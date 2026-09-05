import { randomUUID } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";

import type { BotCommandInput, Message, RealtimeEvent, User, Workspace } from "@clickclack/sdk-ts";
import { resolveCliModel, type AgentSessionRuntime, type PromptOptions } from "@earendil-works/pi-coding-agent";

import { TurnActivity, type ActivityTransport } from "./activity.js";
import {
  botCommandMenu,
  isPiResourceCommand,
  parseSlashInvocation,
  runtimeBotCommandMenu,
  type SlashInvocation,
} from "./commands.js";
import { createClickClackClient, type ClickClackBoundary } from "./clickclack.js";
import type { BridgeConfig } from "./config.js";
import { decisionTurnId, readDecisionReply, renderDecisionPrompt } from "./decision-prompt.js";
import {
  WorkflowDecisionWatcher,
  type ClaimedWorkflowDecision,
  type DecisionAnswer,
  type WorkflowDecisionClient,
} from "./workflow-decisions.js";
import { sessionRun, type RunView } from "./workflow-run-view.js";
import { DurableWorkflowPublisher } from "./workflow-durable-publisher.js";
import { WorkflowRunReporter } from "./workflow-run-publisher.js";
import { createLogger, environmentSecretValues, type Logger } from "./logger.js";
import { createEmbeddedPiRuntime, type EmbeddedPiRuntimeBoundary } from "./pi-runtime.js";
import { steerWithReceipt } from "./pi-steering.js";
import { StateStore, type ConversationBinding, type SteeringReceipt } from "./state/store.js";
import {
  toConversationId,
  toMessageId,
  toProjectAlias,
  toTurnId,
  type ConversationType,
  type InvocationMode,
  type MessageId,
  type TurnId,
} from "./types.js";

export type BridgeServiceDependencies = {
  logger?: Logger;
  stateStore?: StateStore;
  clickClack?: ClickClackBoundary;
  piRuntime?: EmbeddedPiRuntimeBoundary;
  sleep?: (milliseconds: number) => Promise<void>;
  workflowObservationStopTimeoutMs?: number;
  /**
   * Supplies the Pi Workflows client used to deliver human decisions.
   *
   * The production application supplies a lazy process-owned client. Direct
   * service construction defaults to none, which keeps isolated tests opt-in.
   */
  workflowClient?: () => WorkflowDecisionClient | undefined;
};

type ConversationTarget = {
  type: ConversationType;
  id: string;
};

const reconnectDelayMs = 1_000;
const attachmentHydrationDelayMs = 80;
const attachmentHydrationAttempts = 25;
const maxPiImageBytes = 5 * 1024 * 1024;
const maxPiImageTotalBytes = 20 * 1024 * 1024;
const piImageContentTypes = new Set(["image/gif", "image/jpeg", "image/png", "image/webp"]);

type ActiveSessionTurn = {
  turnId: TurnId;
  activity: TurnActivity;
  unconsumedSteering: Set<MessageId>;
  session: AgentSessionRuntime["session"];
  messageStart: number;
  unsubscribe: (() => void) | undefined;
};

/**
 * One workflow decision presented in a conversation and awaiting a reply.
 *
 * The bridge holds the claim while this is open, so an unanswered decision is
 * released rather than left claimed when the conversation moves on.
 */
type PresentedDecision = {
  decision: ClaimedWorkflowDecision;
  source: Message;
  resolve: (answer: DecisionAnswer | undefined) => void;
};

export class BridgeService {
  readonly state: StateStore;
  readonly clickClack: ClickClackBoundary;
  readonly piRuntime: EmbeddedPiRuntimeBoundary;
  readonly logger: Logger;

  private readonly sleep: (milliseconds: number) => Promise<void>;
  private readonly workflowObservationStopTimeoutMs: number;
  private readonly workflowClient: (() => WorkflowDecisionClient | undefined) | undefined;
  private started = false;
  private stopped = false;
  private identity?: User;
  private workspace?: Workspace;
  private socket: WebSocket | undefined;
  private reconnectTimer: NodeJS.Timeout | undefined;
  private eventQueue: Promise<void> = Promise.resolve();
  private startupTask: Promise<void> | undefined;
  private readonly realtimeTasks = new Set<Promise<void>>();
  /**
   * One work chain per conversation binding. Ingest stays globally ordered so
   * the realtime cursor and source-message claims advance in event order, but
   * agent turns run on these chains so a turn in one conversation cannot block
   * a message in another.
   */
  private readonly conversationQueues = new Map<number, Promise<void>>();
  private readonly queuedConversationWork = new Map<number, number>();
  private readonly steeringMessages = new WeakMap<object, MessageId>();
  private steeringNotices: Promise<void> = Promise.resolve();
  private readonly runtimes = new Map<number, AgentSessionRuntime>();
  private readonly activeSessionTurns = new Map<number, ActiveSessionTurn>();
  private readonly decisionWatchers = new Map<number, WorkflowDecisionWatcher>();
  private readonly workflowSessionIds = new Map<number, string>();
  /** Timed-out watcher detaches that shutdown must still account for. */
  private readonly pendingWorkflowCleanup = new Set<Promise<void>>();
  /** Owns durable replay independently of any individual watcher lifetime. */
  private durableWorkflows: DurableWorkflowPublisher | undefined;
  /** Publishes each bound conversation's ephemeral workflow run state. */
  private readonly runReporters = new Map<number, WorkflowRunReporter>();
  private readonly presentedDecisions = new Map<number, PresentedDecision>();
  /** Last owner message per binding, used as the conversation to post decisions into. */
  private readonly conversationSources = new Map<number, Message>();
  private readonly activeExtensionErrors = new Map<number, Error[]>();
  private readonly projectCommandMenus = new Map<string, BotCommandInput[]>();
  private stopTask: Promise<void> = Promise.resolve();

  constructor(
    readonly config: BridgeConfig,
    dependencies: BridgeServiceDependencies = {},
  ) {
    this.logger = dependencies.logger ?? createLogger({
      secretValues: [config.clickClack.botToken, ...environmentSecretValues()],
    });
    this.state = dependencies.stateStore ?? new StateStore(config.statePath);
    this.clickClack = dependencies.clickClack ?? createClickClackClient(config);
    this.piRuntime = dependencies.piRuntime ?? createEmbeddedPiRuntime(config);
    this.sleep = dependencies.sleep ?? delay;
    this.workflowObservationStopTimeoutMs = dependencies.workflowObservationStopTimeoutMs ?? 1_000;
    this.workflowClient = dependencies.workflowClient;
  }

  start(): Promise<void> {
    if (this.stopped) return Promise.reject(new Error("cannot start a stopped bridge service"));
    if (this.startupTask !== undefined) return this.startupTask;
    this.startupTask = this.startOnce();
    return this.startupTask;
  }

  private async startOnce(): Promise<void> {
    const [identity, workspace] = await Promise.all([
      this.clickClack.me(),
      this.clickClack.workspaces.get(this.config.clickClack.workspaceId),
    ]);
    if (identity.kind !== "bot") throw new Error("CLICKCLACK_BOT_TOKEN did not authenticate as a bot");
    if (workspace.id !== this.config.clickClack.workspaceId) {
      throw new Error("ClickClack returned the wrong configured workspace");
    }
    if (this.stopped) return;

    this.identity = identity;
    this.workspace = workspace;
    if (this.clickClack.workflowRuns !== undefined && this.workflowClient !== undefined) {
      const hostIdentity = this.workflowClient()?.hostIdentity;
      if (!hostIdentity?.trim()) throw new Error("Missing stable workflow host identity");
      this.durableWorkflows = new DurableWorkflowPublisher({
        database: this.state.database, endpoint: this.config.clickClack.baseUrl,
        producerId: identity.id, workspaceId: workspace.id, client: this.workflowClient,
        hostIdentity,
        publish: (input) => this.clickClack.workflowRuns!.publish(input),
        onError: (metadata) => this.logger.warn("durable workflow publication deferred", metadata),
      });
      this.durableWorkflows.start();
    }
    await this.publishCommandMenu();
    if (this.stopped) return;
    const interruptedTurns = this.state.recoverInterruptedTurns();
    if (interruptedTurns > 0) {
      this.logger.warn("recovered interrupted Pi turns from previous bridge process", { interruptedTurns });
    }
    this.state.markSteeringUncertain();
    await this.notifyUncertainSteering();
    this.started = true;
    await this.trackRealtime(this.connectRealtime());
    this.logger.info("bridge service started", {
      botUserId: identity.id,
      botHandle: identity.handle,
      workspaceId: workspace.id,
      projectAliases: [...this.config.projects.keys()],
      piRuntime: this.piRuntime.kind,
      publishedCommands: botCommandMenu.length,
      sessionsStarted: this.runtimes.size,
    });
  }

  stop(): void {
    if (this.stopped) return;
    this.stopped = true;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.socket?.close();
    this.socket = undefined;
    this.stopTask = this.finishCleanup();
  }

  async waitForStop(): Promise<void> {
    this.stop();
    await this.stopTask;
  }

  private async finishCleanup(): Promise<void> {
    // Startup and reconnect catch-up run outside the normal event queue. Drain
    // them first, then drain every event and conversation they admitted before
    // taking the runtime snapshot or closing state.
    if (this.startupTask !== undefined) await Promise.allSettled([this.startupTask]);
    while (this.realtimeTasks.size > 0) {
      await Promise.allSettled([...this.realtimeTasks]);
    }
    await this.eventQueue;
    while (this.conversationQueues.size > 0) {
      await Promise.all([...this.conversationQueues.values()]);
    }

    const workflowBindings = new Set([
      ...this.decisionWatchers.keys(),
      ...this.runReporters.keys(),
      ...this.presentedDecisions.keys(),
    ]);
    const cleanup = [
      ...[...workflowBindings].map(async (bindingId) => await this.stopWorkflowObservation(bindingId)),
      ...[...this.runtimes.values()].map(async (runtime) => await runtime.dispose()),
    ];
    this.workflowSessionIds.clear();
    this.conversationSources.clear();
    this.runtimes.clear();

    const cleanupResults = await Promise.allSettled(cleanup);
    while (this.pendingWorkflowCleanup.size > 0) {
      const pending = [...this.pendingWorkflowCleanup];
      pending.forEach((task) => this.pendingWorkflowCleanup.delete(task));
      cleanupResults.push(...await Promise.allSettled(pending));
    }
    const cleanupFailures = cleanupResults
      .filter((result): result is PromiseRejectedResult => result.status === "rejected")
      .map((failure) => failure.reason);
    try {
      await this.durableWorkflows?.stop();
      this.state.close();
    } catch (error) {
      cleanupFailures.push(error);
    }
    if (cleanupFailures.length > 0) {
      this.logger.warn("bridge cleanup failed", { failures: cleanupFailures });
      throw new AggregateError(cleanupFailures, "bridge cleanup failed");
    }
    this.logger.info("bridge service stopped", {
      started: this.started,
      botUserId: this.identity?.id,
      workspaceId: this.workspace?.id,
    });
  }

  async waitForIdle(): Promise<void> {
    for (;;) {
      await this.eventQueue;
      const pending = [...this.conversationQueues.values()];
      if (pending.length === 0) return;
      await Promise.all(pending);
    }
  }

  /**
   * Append conversation-scoped work to that conversation's chain and return
   * immediately. Failures are logged rather than rethrown so one failed turn
   * does not poison the chain for later messages.
   */
  private enqueueConversationWork(bindingId: number, work: () => Promise<void>): void {
    const previous = this.conversationQueues.get(bindingId) ?? Promise.resolve();
    this.queuedConversationWork.set(bindingId, (this.queuedConversationWork.get(bindingId) ?? 0) + 1);
    const next: Promise<void> = previous
      .then(() => {
        const remaining = (this.queuedConversationWork.get(bindingId) ?? 1) - 1;
        if (remaining === 0) this.queuedConversationWork.delete(bindingId);
        else this.queuedConversationWork.set(bindingId, remaining);
        return work();
      })
      .catch((error: unknown) => {
        this.logger.error("conversation work failed", { bindingId, error });
      })
      .then(() => {
        if (this.conversationQueues.get(bindingId) === next) this.conversationQueues.delete(bindingId);
      });
    this.conversationQueues.set(bindingId, next);
  }

  private trackRealtime(task: Promise<void>): Promise<void> {
    this.realtimeTasks.add(task);
    void task.finally(() => this.realtimeTasks.delete(task)).catch(() => undefined);
    return task;
  }

  private async connectRealtime(): Promise<void> {
    if (this.stopped) return;
    await this.notifyUncertainSteering();
    if (this.stopped) return;
    let cursor = this.state.getRealtimeCursor();

    if (!cursor) {
      const initial = await this.clickClack.events.list({
        workspaceId: this.config.clickClack.workspaceId,
        limit: 1,
        includeTail: true,
      });
      if (this.stopped) return;
      if (initial.tailCursor) {
        this.state.advanceRealtimeCursor(initial.tailCursor);
        cursor = initial.tailCursor;
      }
    } else {
      cursor = await this.catchUp(cursor);
    }

    if (this.stopped) return;
    this.socket = this.clickClack.events.subscribe({
      workspaceId: this.config.clickClack.workspaceId,
      ...(cursor ? { afterCursor: cursor } : {}),
      onEvent: (event) => this.enqueueEvent(event),
      onClose: () => {
        this.socket = undefined;
        this.scheduleReconnect();
      },
    });
  }

  private async catchUp(afterCursor: string): Promise<string> {
    let cursor = afterCursor;
    for (;;) {
      const page = await this.clickClack.events.list({
        workspaceId: this.config.clickClack.workspaceId,
        afterCursor: cursor,
        limit: 100,
        includeTail: true,
      });
      if (this.stopped) return cursor;
      for (const event of page.events) {
        await this.processEvent(event);
        cursor = event.cursor;
      }
      if (page.events.length < 100) {
        if (page.tailCursor && page.tailCursor > cursor) {
          this.state.advanceRealtimeCursor(page.tailCursor);
          cursor = page.tailCursor;
        }
        return cursor;
      }
    }
  }

  private enqueueEvent(event: RealtimeEvent): void {
    if (this.stopped) return;
    this.eventQueue = this.eventQueue
      .then(() => this.processEvent(event))
      .catch((error: unknown) => {
        this.logger.error("realtime event handling failed", {
          eventId: event.id,
          eventType: event.type,
          error,
        });
      });
  }

  private async processEvent(event: RealtimeEvent): Promise<void> {
    if (event.workspace_id !== this.config.clickClack.workspaceId) return;
    if (event.type === "message.created") {
      const messageId = textField(event.payload.message_id);
      if (messageId) {
        const message = await this.clickClack.messages.get(messageId);
        await this.processMessage(event, message);
      }
    }
    if (event.cursor) this.state.advanceRealtimeCursor(event.cursor);
  }

  private async processMessage(event: RealtimeEvent, message: Message): Promise<void> {
    if (!this.identity || message.author_id === this.identity.id) return;
    if (!this.config.clickClack.ownerIds.includes(message.author_id)) return;
    if ((message.kind ?? "message") !== "message" || message.deleted_at) return;

    const target = conversationTarget(message);
    if (!target) return;
    const cleanBody = stripBotMention(message.body, this.identity.handle);
    const projectCommand = parseProjectCommand(cleanBody);

    if (projectCommand) {
      const claim = this.state.claimSourceMessage({
        messageId: toMessageId(message.id),
        eventId: event.id,
        eventCursor: event.cursor,
      });
      if (!claim.claimed) return;
      // Rebinding disposes the conversation's runtime, so it has to wait behind
      // any turn already running on that conversation.
      const existing = this.state.getBinding(target.type, toConversationId(target.id));
      if (existing) {
        this.enqueueConversationWork(existing.id, () => this.bindProject(target, projectCommand, message));
      } else {
        await this.bindProject(target, projectCommand, message);
      }
      return;
    }

    let binding = this.state.getBinding(target.type, toConversationId(target.id));
    const directed = this.isDirected(event, target, binding);
    if (!directed) return;

    if (!binding && this.config.projects.size === 1) {
      const alias = this.config.projects.keys().next().value;
      if (alias) binding = this.state.upsertBinding({
        conversationType: target.type,
        conversationId: toConversationId(target.id),
        projectAlias: alias,
        invocationMode: this.invocationMode(target),
      });
    }
    if (!binding) {
      await this.sendReply(message, `bind this conversation first with \`/project <alias>\`. available: ${[...this.config.projects.keys()].join(", ")}`);
      return;
    }

    this.conversationSources.set(binding.id, message);

    // A presented workflow decision consumes the next matching reply before it
    // can start a Pi turn. The reply is matched before the source message is
    // claimed, so an unmatched reply still falls through to ordinary handling
    // and the conversation is not trapped by a pending decision.
    const presented = this.presentedDecisions.get(binding.id);
    if (presented !== undefined) {
      const reply = readDecisionReply(presented.decision, cleanBody);
      if (reply.kind !== "unmatched") {
        const claim = this.state.claimSourceMessage({
          messageId: toMessageId(message.id),
          eventId: event.id,
          eventCursor: event.cursor,
        });
        if (!claim.claimed) return;
        this.presentedDecisions.delete(binding.id);
        presented.resolve(reply.kind === "answer" ? reply.answer : undefined);
        await this.sendReply(
          message,
          reply.kind === "answer"
            ? "answer recorded, resuming the workflow."
            : "left the decision pending.",
          `pi-decision-ack-${message.id}`,
        );
        return;
      }
    }

    const hydrated = await this.hydrateExpectedAttachments(event, message);
    if (!hydrated) {
      const claim = this.state.claimSourceMessage({
        messageId: toMessageId(message.id),
        eventId: event.id,
        eventCursor: event.cursor,
      });
      if (claim.claimed) {
        await this.sendReply(
          message,
          "i couldn't load every attachment. please resend the message and try again.",
          `pi-attachment-error-${message.id}`,
        );
      }
      return;
    }
    message = hydrated;
    const hasImage = message.attachments?.some((attachment) =>
      piImageContentTypes.has(normalizeContentType(attachment.content_type))
    );
    const prompt = cleanBody || (hasImage
      ? "Review the attached image."
      : "say hello and briefly identify the project connected to this conversation.");
    if (!parseSlashInvocation(cleanBody) && await this.trySteer(event, binding, message, prompt)) return;
    const claim = this.state.claimSourceMessage({
      messageId: toMessageId(message.id),
      eventId: event.id,
      eventCursor: event.cursor,
    });
    if (!claim.claimed) return;

    const bound = binding;
    const claimed = message;

    if (isContinueCommand(cleanBody)) {
      this.enqueueConversationWork(bound.id, () => this.continueSession(bound, claimed));
      return;
    }

    const slashInvocation = parseSlashInvocation(cleanBody);
    if (slashInvocation) {
      this.enqueueConversationWork(bound.id, () => this.handleSlashCommand(bound, claimed, slashInvocation));
      return;
    }

    this.enqueueConversationWork(bound.id, () => this.runTurn(bound, claimed, prompt));
  }

  private async trySteer(
    event: RealtimeEvent, binding: ConversationBinding, source: Message, prompt: string,
  ): Promise<boolean> {
    const active = this.activeSessionTurns.get(binding.id);
    if (!active?.session.isStreaming || this.queuedConversationWork.has(binding.id)) return false;
    const session = active.session;
    if (this.state.getSourceMessageClaim(toMessageId(source.id))) return true;
    let images: PromptOptions["images"];
    try {
      images = await this.loadPromptImages(source);
    } catch (error) {
      const claim = this.state.claimSourceMessage({ messageId: toMessageId(source.id), eventId: event.id, eventCursor: event.cursor });
      if (claim.claimed) await this.sendReply(source, "i couldn't load every attachment. please resend the message and try again.", `pi-attachment-error-${source.id}`);
      this.logger.warn("steering attachment preparation failed", { sourceMessageId: source.id, error });
      return true;
    }
    // No await between this check, the durable claim/receipt, and Pi 0.85.1's
    // synchronous enqueue. Settlement cannot route this input a second time.
    if (this.activeSessionTurns.get(binding.id) !== active || active.session !== session || !session.isStreaming
      || this.queuedConversationWork.has(binding.id)) return false;
    const claim = this.state.claimSourceMessage({
      messageId: toMessageId(source.id), eventId: event.id, eventCursor: event.cursor,
      steering: {
        bindingId: binding.id, sessionId: active.session.sessionId, turnId: active.turnId,
        projectAlias: binding.projectAlias, authorId: source.author_id,
        workspaceId: this.config.clickClack.workspaceId, botId: this.identity!.id,
      },
    });
    if (!claim.claimed) return true;
    let captured = false;
    try {
      await steerWithReceipt(active.session, prompt, images, (message) => {
        captured = true;
        active.unconsumedSteering.add(toMessageId(source.id));
        this.steeringMessages.set(message, toMessageId(source.id));
      });
      if (!captured) active.unconsumedSteering.add(toMessageId(source.id));
    } catch (error) {
      // A rejection does not prove enqueue never happened. Never queue a fallback.
      this.state.markSteeringMessageUncertain(toMessageId(source.id));
      this.logger.warn("Pi steering delivery uncertain", { sourceMessageId: source.id, error });
    }
    return true;
  }

  private notifyUncertainSteering(): Promise<void> {
    this.steeringNotices = this.steeringNotices.then(async () => {
      for (const receipt of this.state.listUncertainSteering()) {
        try {
          if (this.state.getActiveTurn(receipt.turnId)) continue;
          const source = await this.clickClack.messages.get(receipt.messageId);
          const target = this.steeringNoticeTarget(receipt, source);
          if (!target) continue;
          const nonce = `pi-steering-uncertain-${receipt.messageId}`;
          const body = `i couldn't confirm delivery of your mid-turn message (${receipt.messageId}). it may have reached Pi; i won't replay it automatically. please check the result before resending.${receipt.runtimeRetired ? " the Pi runtime was retired to prevent its pending queue reaching another turn; session history is preserved." : ""}`;
          const existing = this.state.getOutbound(nonce);
          if (existing?.status === "sent" || existing?.status === "reconciled") {
            this.state.markSteeringNotified(receipt.messageId);
            continue;
          }
          const outbound = existing ?? this.state.reserveOutbound({ nonce, targetType: target.type, targetId: target.id, messageKind: "message", body });
          if (existing) {
            const found = await this.clickClack.messages.findByNonce(receipt.workspaceId, nonce);
            if (found) {
              if (outbound.status === "pending") this.state.transitionOutbound({ nonce, expected: "pending", next: "uncertain" });
              this.state.transitionOutbound({ nonce, expected: "uncertain", next: "reconciled", messageId: toMessageId(found.id) });
              this.state.markSteeringNotified(receipt.messageId);
              continue;
            }
          }
          try {
            // Nonce lookup can cross a rebind or owner-policy change.
            if (!this.steeringNoticeTarget(receipt, source)) continue;
            const sent = target.type === "channel"
              ? await this.clickClack.channels.sendMessage(target.id, { body, nonce })
              : await this.clickClack.dms.sendMessage(target.id, { body, nonce });
            this.state.transitionOutbound({ nonce, expected: outbound.status, next: "sent", messageId: toMessageId(sent.id) });
            this.state.markSteeringNotified(receipt.messageId);
          } catch (error) {
            if (outbound.status === "pending") this.state.transitionOutbound({ nonce, expected: "pending", next: "uncertain" });
            throw error;
          }
        } catch (error) {
          this.logger.warn("steering uncertainty notice deferred", { sourceMessageId: receipt.messageId, error });
        }
      }
    });
    return this.steeringNotices;
  }

  private steeringNoticeTarget(receipt: SteeringReceipt, source: Message): ConversationTarget | undefined {
    if (receipt.workspaceId !== this.config.clickClack.workspaceId || receipt.botId !== this.identity?.id
      || !this.config.clickClack.ownerIds.includes(receipt.authorId)) return undefined;
    const target = conversationTarget(source);
    if (!target || source.author_id !== receipt.authorId || source.workspace_id !== receipt.workspaceId || source.deleted_at) return undefined;
    const binding = this.state.getBinding(target.type, toConversationId(target.id));
    if (binding?.id !== receipt.bindingId || binding.projectAlias !== receipt.projectAlias) return undefined;
    const latest = this.state.getActivePiSession(binding.id) ?? this.state.listArchivedPiSessions(binding.id)[0];
    return latest?.sessionId === receipt.sessionId ? target : undefined;
  }

  private async bindProject(target: ConversationTarget, aliasValue: string, source: Message): Promise<void> {
    const alias = toProjectAlias(aliasValue);
    if (!this.config.projects.has(alias)) {
      await this.sendReply(source, `unknown project \`${aliasValue}\`. available: ${[...this.config.projects.keys()].join(", ")}`);
      return;
    }
    const conversationId = toConversationId(target.id);
    const previous = this.state.getBinding(target.type, conversationId);
    if (previous && previous.projectAlias !== alias) {
      await this.stopWorkflowObservation(previous.id);
      const runtime = this.runtimes.get(previous.id);
      if (runtime) await runtime.dispose();
      this.runtimes.delete(previous.id);
      this.state.archiveActivePiSession(previous.id);
    }
    const binding = this.state.upsertBinding({
      conversationType: target.type,
      conversationId,
      projectAlias: alias,
      // An existing binding keeps the mode it was last set to. Recomputing from
      // static config here would silently revert an operator's /invoke choice
      // the next time they rebound the project.
      invocationMode: previous?.invocationMode ?? this.invocationMode(target),
    });
    const modeText = binding.invocationMode === "mention" ? "mention @pi to invoke it" : "messages will invoke pi automatically";
    await this.sendReply(source, `bound to \`${aliasValue}\`; ${modeText}.`);
  }

  private async continueSession(binding: ConversationBinding, source: Message): Promise<void> {
    const active = this.state.getActivePiSession(binding.id);
    const archived = this.state.listArchivedPiSessions(binding.id);
    const reference = active && isRecoverableSessionFile(active.sessionFile)
      ? active
      : archived.find((candidate) => isRecoverableSessionFile(candidate.sessionFile));
    if (!reference) {
      await this.sendReply(source, "no recoverable Pi session was found for this conversation.");
      return;
    }

    await this.stopWorkflowObservation(binding.id);
    const cached = this.runtimes.get(binding.id);
    if (cached) await cached.dispose();
    this.runtimes.delete(binding.id);
    if (reference.archivedAt) this.state.restorePiSession(binding.id, reference.id);

    await this.runTurn(
      binding,
      source,
      "Continue from where the interrupted session left off. Review the latest tool results, then finish the task without repeating completed work.",
    );
  }

  private async handleSlashCommand(
    binding: ConversationBinding,
    source: Message,
    invocation: SlashInvocation,
  ): Promise<void> {
    const command = invocation.name.toLowerCase();
    // Answered before the runtime is resolved: changing how a conversation
    // invokes Pi should not require a working Pi session.
    if (command === "invoke") {
      await this.handleInvokeCommand(binding, source, invocation.args);
      return;
    }
    try {
      const runtime = await this.runtimeFor(binding);
      switch (command) {
        case "compact":
          await runtime.session.compact(invocation.args || undefined);
          await this.sendReply(source, "Pi session compacted.", `pi-command-${source.id}`);
          return;
        case "new": {
          if (invocation.args) {
            await this.sendReply(source, "usage: `/new`", `pi-command-${source.id}`);
            return;
          }
          let result: { cancelled: boolean };
          try {
            result = await runtime.newSession();
          } catch (error) {
            this.runtimes.delete(binding.id);
            throw error;
          }
          if (result.cancelled) {
            await this.sendReply(source, "Pi session replacement was cancelled.", `pi-command-${source.id}`);
            return;
          }
          this.recordReplacementSession(binding, runtime);
          await this.watchWorkflowDecisions(binding, runtime.session.sessionId);
          await this.sendReply(source, "New Pi session started.", `pi-command-${source.id}`);
          return;
        }
        case "name": {
          if (!invocation.args) {
            await this.sendReply(
              source,
              runtime.session.sessionName ? `Pi session name: ${runtime.session.sessionName}` : "usage: `/name <name>`",
              `pi-command-${source.id}`,
            );
            return;
          }
          runtime.session.setSessionName(invocation.args);
          await this.sendReply(source, `Pi session name set: ${runtime.session.sessionName ?? invocation.args}`, `pi-command-${source.id}`);
          return;
        }
        case "session":
          if (invocation.args) {
            await this.sendReply(source, "usage: `/session`", `pi-command-${source.id}`);
            return;
          }
          await this.sendReply(source, formatSessionStats(runtime), `pi-command-${source.id}`);
          return;
        case "model":
          await this.handleModelCommand(runtime, source, invocation.args);
          return;
        case "thinking":
          await this.handleThinkingCommand(runtime, source, invocation.args);
          return;
        case "reload":
          if (invocation.args) {
            await this.sendReply(source, "usage: `/reload`", `pi-command-${source.id}`);
            return;
          }
          await runtime.session.reload();
          try {
            await this.refreshProjectCommandMenu(binding.projectAlias, runtime);
          } catch (error) {
            this.logger.warn("could not refresh reloaded Pi commands in ClickClack", {
              projectAlias: binding.projectAlias,
              error,
            });
          }
          await this.sendReply(source, "Pi extensions, skills, prompts, and context reloaded.", `pi-command-${source.id}`);
          return;
        case "copy": {
          if (invocation.args) {
            await this.sendReply(source, "usage: `/copy`", `pi-command-${source.id}`);
            return;
          }
          const text = runtime.session.getLastAssistantText();
          await this.sendReply(source, text ?? "This Pi session has no assistant answer to copy.", `pi-command-${source.id}`);
          return;
        }
        default:
          if (!isPiResourceCommand(runtime, invocation)) {
            await this.sendReply(source, `unknown Pi command \`/${invocation.name}\`.`, `pi-command-${source.id}`);
            return;
          }
          await this.runTurn(binding, source, invocation.raw, {
            allowNoAssistant: true,
            noAssistantReply: `Pi command \`/${invocation.name}\` completed.`,
          });
      }
    } catch (error) {
      this.logger.error("Pi command failed", {
        command: invocation.name,
        sourceMessageId: source.id,
        projectAlias: binding.projectAlias,
        error,
      });
      await this.sendReply(source, `Pi command \`/${invocation.name}\` failed. check the bridge log for the error.`, `pi-command-error-${source.id}`);
    }
  }

  private async handleModelCommand(runtime: AgentSessionRuntime, source: Message, modelRef: string): Promise<void> {
    if (!modelRef) {
      const current = runtime.session.model;
      const label = current ? `${current.provider}/${current.id}` : "none";
      await this.sendReply(source, `Pi model: ${label}`, `pi-command-${source.id}`);
      return;
    }
    const resolved = resolveCliModel({
      cliModel: modelRef,
      modelRuntime: runtime.session.modelRuntime,
    });
    if (resolved.error || !resolved.model) {
      await this.sendReply(source, `couldn't resolve Pi model \`${modelRef}\`: ${resolved.error ?? "model not found"}`, `pi-command-${source.id}`);
      return;
    }
    await runtime.session.setModel(resolved.model);
    if (resolved.thinkingLevel) runtime.session.setThinkingLevel(resolved.thinkingLevel);
    await this.sendReply(
      source,
      `Pi model set: ${resolved.model.provider}/${resolved.model.id} (${runtime.session.thinkingLevel})`,
      `pi-command-${source.id}`,
    );
  }

  private async handleThinkingCommand(runtime: AgentSessionRuntime, source: Message, level: string): Promise<void> {
    const available = runtime.session.getAvailableThinkingLevels();
    if (!level) {
      await this.sendReply(
        source,
        `Pi thinking: ${runtime.session.thinkingLevel}. available: ${available.join(", ") || "off"}`,
        `pi-command-${source.id}`,
      );
      return;
    }
    if (!available.includes(level as (typeof available)[number])) {
      await this.sendReply(source, `invalid thinking level \`${level}\`. available: ${available.join(", ") || "off"}`, `pi-command-${source.id}`);
      return;
    }
    runtime.session.setThinkingLevel(level as (typeof available)[number]);
    await this.sendReply(source, `Pi thinking set: ${runtime.session.thinkingLevel}`, `pi-command-${source.id}`);
  }

  private recordReplacementSession(binding: ConversationBinding, runtime: AgentSessionRuntime): void {
    const sessionFile = runtime.session.sessionFile;
    if (!sessionFile) throw new Error("Pi did not create a persistent replacement session file");
    this.state.setActivePiSession({
      bindingId: binding.id,
      sessionId: runtime.session.sessionId,
      sessionFile,
    });
  }

  private async hydrateExpectedAttachments(
    event: RealtimeEvent,
    message: Message,
  ): Promise<Message | undefined> {
    const expected = positiveIntegerField(event.payload.expected_attachment_count);
    if (expected === 0 || (message.attachments?.length ?? 0) >= expected) return message;

    let hydrated = message;
    let lastError: unknown;
    for (let attempt = 0; attempt < attachmentHydrationAttempts; attempt += 1) {
      await this.sleep(attachmentHydrationDelayMs);
      try {
        hydrated = await this.clickClack.messages.get(message.id);
        if ((hydrated.attachments?.length ?? 0) >= expected) return hydrated;
      } catch (error) {
        lastError = error;
      }
    }
    this.logger.warn("message attachments did not finish hydrating", {
      messageId: message.id,
      expectedAttachments: expected,
      hydratedAttachments: hydrated.attachments?.length ?? 0,
      ...(lastError ? { error: lastError } : {}),
    });
    return undefined;
  }

  private async loadPromptImages(
    message: Message,
  ): Promise<Array<{ type: "image"; data: string; mimeType: string }>> {
    const attachments = message.attachments ?? [];
    const images = attachments.filter((attachment) =>
      piImageContentTypes.has(normalizeContentType(attachment.content_type))
    );
    const oversized = images.find((attachment) => attachment.byte_size > maxPiImageBytes);
    if (oversized) {
      throw new Error(
        `ClickClack image attachment ${oversized.id} is larger than Pi's ${maxPiImageBytes} byte limit`,
      );
    }
    const totalBytes = images.reduce((total, attachment) => total + attachment.byte_size, 0);
    if (totalBytes > maxPiImageTotalBytes) {
      throw new Error(
        `ClickClack image attachments total ${totalBytes} bytes; Pi's limit is ${maxPiImageTotalBytes}`,
      );
    }

    const promptImages: Array<{ type: "image"; data: string; mimeType: string }> = [];
    for (const attachment of images) {
      const blob = await this.clickClack.uploads.download(attachment.id);
      const bytes = Buffer.from(await blob.arrayBuffer());
      if (bytes.byteLength !== attachment.byte_size) {
        throw new Error(
          `ClickClack attachment ${attachment.id} downloaded ${bytes.byteLength} bytes; expected ${attachment.byte_size}`,
        );
      }
      promptImages.push({
        type: "image",
        data: bytes.toString("base64"),
        mimeType: normalizeContentType(attachment.content_type),
      });
    }
    return promptImages;
  }

  private async runTurn(
    binding: ConversationBinding,
    source: Message,
    prompt: string,
    options: { allowNoAssistant?: boolean; noAssistantReply?: string } = {},
  ): Promise<void> {
    const turnId = toTurnId(`turn_${randomUUID()}`);
    let status: "starting" | "running" = "starting";
    let activity: TurnActivity | undefined;
    let activeSessionTurn: ActiveSessionTurn | undefined;
    try {
      const runtime = await this.runtimeFor(binding);
      // Attachment hydration can cross the network. Do it before the final
      // idle barrier so autonomous extension work that starts meanwhile stays
      // outside this ClickClack turn's activity and error boundary.
      const images = await this.loadPromptImages(source);
      if (runtime.session.isIdle === false) await runtime.session.waitForIdle();
      this.state.startActiveTurn({
        turnId,
        bindingId: binding.id,
        sourceMessageId: toMessageId(source.id),
      });
      activity = new TurnActivity({
        turnId,
        source,
        projectCwd: this.piRuntime.project(binding.projectAlias).cwd,
        transport: this.activityTransport(source),
        onError: (error) => this.logger.warn("agent activity publish failed", { turnId, error }),
      });
      activeSessionTurn = {
        turnId,
        activity,
        unconsumedSteering: new Set(),
        session: runtime.session,
        messageStart: runtime.session.messages.length,
        unsubscribe: undefined,
      };
      this.activeSessionTurns.set(binding.id, activeSessionTurn);
      this.bindActiveTurnSession(binding.id, runtime.session);
      this.state.transitionActiveTurn(turnId, "starting", "running");
      status = "running";
      const extensionErrors: Error[] = [];
      this.activeExtensionErrors.set(binding.id, extensionErrors);
      try {
        await this.promptAndWaitForNestedPrompts(
          runtime.session,
          prompt,
          images.length > 0 ? { images } : {},
        );
        if (extensionErrors[0]) throw extensionErrors[0];
      } finally {
        this.activeExtensionErrors.delete(binding.id);
        this.state.markSteeringUncertain(turnId);
        this.activeSessionTurns.delete(binding.id);
        activeSessionTurn.unsubscribe?.();
        activeSessionTurn.unsubscribe = undefined;
      }
      const answer = finalAssistantText(
        activeSessionTurn.session.messages.slice(activeSessionTurn.messageStart),
        options.allowNoAssistant,
      );
      await activity.finalize();
      await this.sendReply(source, answer ?? options.noAssistantReply ?? "Pi command completed.", `pi-${source.id}`);
      this.state.finishActiveTurn(turnId, "running");
      this.logger.info("Pi turn completed", {
        turnId,
        sourceMessageId: source.id,
        projectAlias: binding.projectAlias,
      });
    } catch (error) {
      this.activeSessionTurns.delete(binding.id);
      activeSessionTurn?.unsubscribe?.();
      await activity?.finalize();
      const current = this.state.getActiveTurn(turnId);
      if (current?.status === "starting") this.state.transitionActiveTurn(turnId, "starting", "stopping");
      if (current?.status === "running") this.state.transitionActiveTurn(turnId, "running", "stopping");
      if (this.state.getActiveTurn(turnId)?.status === "stopping") this.state.finishActiveTurn(turnId, "stopping");
      this.logger.error("Pi turn failed", {
        turnId,
        sourceMessageId: source.id,
        projectAlias: binding.projectAlias,
        status,
        error,
      });
      if (error instanceof MissingAssistantTextError) {
        const reset = await this.quarantineUnresponsiveSession(binding);
        if (reset) {
          await this.sendReply(
            source,
            "pi's session stopped responding, so it was reset. send that again.",
            `pi-error-${source.id}`,
          );
          return;
        }
      }
      await this.sendReply(source, "pi couldn't complete that turn. check the bridge log for the error.", `pi-error-${source.id}`);
    } finally {
      this.state.markSteeringUncertain(turnId);
      const session = activeSessionTurn?.session;
      // Never clear extension-owned queues. Retire only this runtime when our
      // unconfirmed input could survive in its queue and leak into a later turn.
      if (session && activeSessionTurn?.unconsumedSteering.size
        && this.state.hasUnconsumedSteering(turnId, session.sessionId)
        && session.getSteeringMessages?.().length > 0
        && this.runtimes.get(binding.id)?.session === session) {
        await this.quarantineUnresponsiveSession(binding);
        this.state.markSteeringRuntimeRetired(turnId);
      }
      await this.notifyUncertainSteering();
    }
  }

  private async quarantineUnresponsiveSession(binding: ConversationBinding): Promise<boolean> {
    const runtime = this.runtimes.get(binding.id);
    this.runtimes.delete(binding.id);

    try {
      await this.stopWorkflowObservation(binding.id);
    } catch (error) {
      this.logger.warn("could not stop workflow observation for unresponsive Pi session", {
        bindingId: binding.id,
        error,
      });
    }

    if (runtime) {
      try {
        await runtime.dispose();
      } catch (error) {
        this.logger.warn("could not dispose unresponsive Pi session", {
          bindingId: binding.id,
          error,
        });
      }
    }
    const archived = this.state.archiveActivePiSession(binding.id);
    if (runtime || archived) {
      this.logger.warn("quarantined unresponsive Pi session", {
        bindingId: binding.id,
        projectAlias: binding.projectAlias,
      });
      return true;
    }
    return false;
  }

  private async runtimeFor(binding: ConversationBinding): Promise<AgentSessionRuntime> {
    const cached = this.runtimes.get(binding.id);
    if (cached) {
      await this.watchWorkflowDecisions(binding, cached.session.sessionId);
      return cached;
    }
    let reference = this.state.getActivePiSession(binding.id);
    if (reference && !existsSync(reference.sessionFile)) {
      this.state.archiveActivePiSession(binding.id);
      this.logger.warn("archived missing active Pi session file", {
        bindingId: binding.id,
        projectAlias: binding.projectAlias,
        sessionId: reference.sessionId,
      });
      reference = undefined;
    }
    const runtime = await this.piRuntime.createSessionRuntime({
      projectAlias: binding.projectAlias,
      ...(reference ? { sessionFile: reference.sessionFile } : {}),
    });
    if (!reference) {
      const sessionFile = runtime.session.sessionFile;
      if (!sessionFile) throw new Error("Pi did not create a persistent session file");
      this.state.setActivePiSession({
        bindingId: binding.id,
        sessionId: runtime.session.sessionId,
        sessionFile,
      });
    }
    this.runtimes.set(binding.id, runtime);
    try {
      await this.bindRuntimeExtensions(binding, runtime);
    } catch (error) {
      this.runtimes.delete(binding.id);
      await runtime.dispose();
      throw error;
    }
    try {
      await this.refreshProjectCommandMenu(binding.projectAlias, runtime);
    } catch (error) {
      this.logger.warn("could not refresh Pi resource commands in ClickClack", {
        projectAlias: binding.projectAlias,
        error,
      });
    }
    await this.watchWorkflowDecisions(binding, runtime.session.sessionId);
    return runtime;
  }

  /**
   * Surfaces this binding's workflow human decisions in its conversation.
   *
   * Watching is best effort: a workflow host that is unavailable must not stop
   * ordinary chat turns, so a failure is logged and the binding runs without
   * decision delivery until its next runtime.
   */
  private async watchWorkflowDecisions(
    binding: ConversationBinding,
    sessionId: string,
  ): Promise<void> {
    if (
      this.workflowSessionIds.get(binding.id) === sessionId
      && this.decisionWatchers.has(binding.id)
    ) return;
    await this.stopWorkflowObservation(binding.id);

    const client = this.workflowClient?.();
    if (client === undefined) return;

    // The session view carries the run alongside its pending interactions, so
    // the run reporter rides this one subscription rather than opening a second.
    const reporter = new WorkflowRunReporter({
      publish: (run) => this.publishRunFrame(binding, run),
      onError: (error) =>
        this.logger.warn("workflow run publication failed", { bindingId: binding.id, error }),
    });

    const watcher = new WorkflowDecisionWatcher({
      client,
      sessionId,
      present: async (decision) => await this.presentDecision(binding, decision),
      onRun: (event) => {
        try {
          this.durableWorkflows?.observe({
            workspace_id: this.config.clickClack.workspaceId,
            ...(binding.conversationType === "channel" ? { channel_id: binding.conversationId }
              : { direct_conversation_id: binding.conversationId }),
          }, sessionId, event, JSON.stringify([binding.id, binding.projectAlias, this.config.projects.get(binding.projectAlias)?.cwd]));
        } catch {
          this.logger.warn("durable workflow observation deferred", { sessionId, bindingId: binding.id });
        }
        reporter.report(sessionRun(event));
      },
      onError: (error) =>
        this.logger.warn("workflow decision delivery failed", { bindingId: binding.id, error }),
    });
    this.workflowSessionIds.set(binding.id, sessionId);
    this.decisionWatchers.set(binding.id, watcher);
    this.runReporters.set(binding.id, reporter);
    try {
      await watcher.start();
    } catch (error) {
      if (this.decisionWatchers.get(binding.id) === watcher) {
        this.workflowSessionIds.delete(binding.id);
        this.decisionWatchers.delete(binding.id);
        this.runReporters.delete(binding.id);
      }
      await reporter.stop();
      this.logger.warn("could not watch workflow decisions", { bindingId: binding.id, error });
    }
  }

  private async stopWorkflowObservation(bindingId: number): Promise<void> {
    const presented = this.presentedDecisions.get(bindingId);
    this.presentedDecisions.delete(bindingId);
    presented?.resolve(undefined);

    const reporter = this.runReporters.get(bindingId);
    this.runReporters.delete(bindingId);

    const watcher = this.decisionWatchers.get(bindingId);
    this.decisionWatchers.delete(bindingId);
    this.workflowSessionIds.delete(bindingId);

    // Stop the watcher synchronously before awaiting the reporter's final
    // clear. Its generation bump and queue/timer reset prevent a released
    // presentation from being reclaimed during that await.
    const stopping = watcher?.stop();
    if (stopping) void stopping.catch(() => undefined);

    let reporterError: unknown;
    try {
      // A replacement reporter must not publish until the old reporter's clear
      // has landed, or a delayed old clear can erase the new run frame.
      if (reporter) await reporter.stop();
    } catch (error) {
      reporterError = error;
    }

    let watcherError: unknown;
    if (stopping) {
      try {
        const stopped = await settlesWithin(
          stopping,
          this.workflowObservationStopTimeoutMs,
        );
        if (!stopped) {
          // Keep the task, even after it settles, so shutdown can account for a
          // late rejection instead of falsely reporting completed cleanup.
          this.pendingWorkflowCleanup.add(stopping);
          this.logger.warn("workflow observation cleanup exceeded its deadline", {
            bindingId,
            workflowObservationStopTimeoutMs: this.workflowObservationStopTimeoutMs,
          });
        }
      } catch (error) {
        watcherError = error;
        this.logger.warn("could not stop workflow observation", { bindingId, error });
      }
    }

    const errors = [reporterError, watcherError].filter((error) => error !== undefined);
    if (errors.length > 0) throw new AggregateError(errors, "workflow observation cleanup failed");
  }

  /**
   * Publishes one conversation's run state as an ephemeral frame.
   *
   * Ephemeral rather than durable: this is the live state of a run, not a record
   * of it, and a timeline full of status frames would bury the conversation.
   * ClickClack requires such a frame to name exactly one channel or DM, which
   * the binding already does.
   */
  private async publishRunFrame(
    binding: ConversationBinding,
    run: RunView | null,
  ): Promise<void> {
    const workspaceId = this.workspace?.id;
    if (workspaceId === undefined) return;
    const target = binding.conversationType === "channel"
      ? { channelId: binding.conversationId }
      : { directConversationId: binding.conversationId };
    await this.clickClack.events.publishEphemeral({
      workspaceId,
      ...target,
      type: "workflow.run",
      payload: { run },
    });
  }

  /**
   * Posts one decision into its conversation and waits for the operator.
   *
   * Resolution comes from processMessage when a reply matches. A decision left
   * open when the conversation moves on stays pending for another presenter
   * rather than being answered on the operator's behalf.
   */
  private async presentDecision(
    binding: ConversationBinding,
    decision: ClaimedWorkflowDecision,
  ): Promise<DecisionAnswer | undefined> {
    const source = this.conversationSources.get(binding.id);
    if (source === undefined) return undefined;

    let resolveAnswer!: (answer: DecisionAnswer | undefined) => void;
    const answer = new Promise<DecisionAnswer | undefined>((resolve) => {
      resolveAnswer = resolve;
    });
    const presentation = { decision, source, resolve: resolveAnswer };
    this.presentedDecisions.set(binding.id, presentation);

    try {
      // Posted as agent_commentary carrying a decision turn_id rather than as
      // an ordinary reply. Register first so replacement or shutdown can
      // cancel the presentation while publication is in flight.
      await this.activityTransport(source).create(
        "agent_commentary",
        renderDecisionPrompt(decision),
        decisionTurnId(decision.requestId, decision.revision),
      );
    } catch (error) {
      if (this.presentedDecisions.get(binding.id) === presentation) {
        this.presentedDecisions.delete(binding.id);
        resolveAnswer(undefined);
      }
      throw error;
    }

    return await answer;
  }

  private async bindRuntimeExtensions(binding: ConversationBinding, runtime: AgentSessionRuntime): Promise<void> {
    const bindSession = async (session: AgentSessionRuntime["session"]): Promise<void> => {
      if (typeof session.bindExtensions !== "function") return;
      await session.bindExtensions({
        mode: "rpc",
        commandContextActions: {
          waitForIdle: () => session.waitForIdle(),
          newSession: (options) => this.replaceRuntimeSession(binding, runtime, () => runtime.newSession(options)),
          fork: (entryId, options) => this.replaceRuntimeSession(binding, runtime, async () => {
            const result = await runtime.fork(entryId, options);
            return { cancelled: result.cancelled };
          }),
          navigateTree: async (targetId, options) => {
            const result = await session.navigateTree(targetId, options);
            return { cancelled: result.cancelled };
          },
          switchSession: (sessionPath, options) => this.replaceRuntimeSession(
            binding,
            runtime,
            () => runtime.switchSession(sessionPath, options),
          ),
          reload: async () => {
            await session.reload();
            await this.refreshProjectCommandMenu(binding.projectAlias, runtime);
          },
        },
        onError: (extensionError) => {
          const error = new Error(
            `Pi extension error (${extensionError.extensionPath}, ${extensionError.event}): ${extensionError.error}`,
          );
          this.logger.error("Pi extension failed", {
            projectAlias: binding.projectAlias,
            bindingId: binding.id,
            extensionPath: extensionError.extensionPath,
            event: extensionError.event,
            error: extensionError.error,
            stack: extensionError.stack,
          });
          this.activeExtensionErrors.get(binding.id)?.push(error);
        },
      });
      this.bindActiveTurnSession(binding.id, session);
      await this.watchWorkflowDecisions(binding, session.sessionId);
    };

    if (typeof runtime.setRebindSession === "function") {
      runtime.setRebindSession(bindSession);
    }
    await bindSession(runtime.session);
  }

  private bindActiveTurnSession(bindingId: number, session: AgentSessionRuntime["session"]): void {
    const activeTurn = this.activeSessionTurns.get(bindingId);
    if (!activeTurn) return;
    activeTurn.unsubscribe?.();
    activeTurn.session = session;
    activeTurn.messageStart = session.messages.length;
    activeTurn.unsubscribe = session.subscribe((event) => {
      if (event.type === "message_start") {
        const sourceId = this.steeringMessages.get(event.message);
        if (sourceId) {
          activeTurn.unconsumedSteering.delete(sourceId);
          this.state.consumeSteering(sourceId);
          this.steeringMessages.delete(event.message);
        }
      }
      activeTurn.activity.handle(event);
    });
  }

  private async replaceRuntimeSession(
    binding: ConversationBinding,
    runtime: AgentSessionRuntime,
    replace: () => Promise<{ cancelled: boolean }>,
  ): Promise<{ cancelled: boolean }> {
    try {
      const result = await replace();
      if (!result.cancelled) {
        this.recordReplacementSession(binding, runtime);
        await this.watchWorkflowDecisions(binding, runtime.session.sessionId);
      }
      return result;
    } catch (error) {
      this.runtimes.delete(binding.id);
      throw error;
    }
  }

  private async promptAndWaitForNestedPrompts(
    session: AgentSessionRuntime["session"],
    prompt: string,
    promptOptions: Pick<PromptOptions, "images"> = {},
  ): Promise<void> {
    const originalPrompt = session.prompt;
    const pending = new Set<Promise<void>>();
    let invocationCount = 0;
    let nestedFailure: unknown;

    session.prompt = (text, promptOptions) => {
      invocationCount += 1;
      const isNested = invocationCount > 1;
      const operation = originalPrompt.call(session, text, promptOptions);
      pending.add(operation);
      void operation.catch((error: unknown) => {
        if (isNested && nestedFailure === undefined) nestedFailure = error;
      }).finally(() => pending.delete(operation));
      return operation;
    };

    try {
      await session.prompt(prompt, { ...promptOptions, source: "interactive" });
      while (pending.size > 0) await Promise.allSettled([...pending]);
      if (nestedFailure !== undefined) throw nestedFailure;
      if (typeof session.waitForIdle === "function") await session.waitForIdle();
    } finally {
      session.prompt = originalPrompt;
    }
  }

  private async refreshProjectCommandMenu(projectAlias: string, runtime: AgentSessionRuntime): Promise<void> {
    this.projectCommandMenus.set(projectAlias, runtimeBotCommandMenu(runtime));
    await this.publishCommandMenu();
  }

  private async publishCommandMenu(): Promise<void> {
    const byName = new Map<string, BotCommandInput>();
    for (const command of botCommandMenu) byName.set(command.command, command);
    for (const commands of this.projectCommandMenus.values()) {
      for (const command of commands) {
        if (!byName.has(command.command)) byName.set(command.command, command);
      }
    }
    await this.clickClack.bots.setCommands([...byName.values()].slice(0, 100));
  }

  private isDirected(
    event: RealtimeEvent,
    target: ConversationTarget,
    binding: ConversationBinding | undefined,
  ): boolean {
    if (target.type === "direct") return true;
    if (binding?.invocationMode === "always") return true;
    return Boolean(this.identity && event.mentioned_user_ids?.includes(this.identity.id));
  }

  /**
   * Shows or sets how this conversation invokes Pi.
   *
   * Direct conversations always invoke automatically, so the mode is fixed
   * there. A channel dedicated to Pi can opt out of mention-only without an
   * environment change and a restart.
   */
  private async handleInvokeCommand(
    binding: ConversationBinding,
    source: Message,
    args: string,
  ): Promise<void> {
    const nonce = `pi-command-${source.id}`;
    const requested = args.trim().toLowerCase();
    const describe = (mode: InvocationMode) =>
      mode === "mention" ? "mention @pi to invoke it" : "every message invokes pi";

    if (!requested) {
      await this.sendReply(source, `invocation: \`${binding.invocationMode}\`; ${describe(binding.invocationMode)}.`, nonce);
      return;
    }
    if (requested !== "mention" && requested !== "always") {
      await this.sendReply(source, "usage: `/invoke [mention|always]`", nonce);
      return;
    }
    if (binding.conversationType === "direct") {
      await this.sendReply(source, "direct conversations always invoke pi automatically.", nonce);
      return;
    }

    const updated = this.state.upsertBinding({
      conversationType: binding.conversationType,
      conversationId: binding.conversationId,
      projectAlias: binding.projectAlias,
      invocationMode: requested,
    });
    await this.sendReply(source, `invocation set to \`${updated.invocationMode}\`; ${describe(updated.invocationMode)}.`, nonce);
  }

  private invocationMode(target: ConversationTarget): InvocationMode {
    if (target.type === "direct") return "auto";
    return this.config.invocationBindings.find(
      (candidate) => candidate.conversationType === target.type && candidate.conversationId === target.id,
    )?.mode ?? "mention";
  }

  private activityTransport(source: Message): ActivityTransport {
    return {
      create: async (kind, body, turnId) => {
        if (source.channel_id) {
          return this.clickClack.channels.sendMessage(source.channel_id, {
            body,
            kind,
            turn_id: turnId,
          });
        }
        if (source.direct_conversation_id) {
          return this.clickClack.dms.sendMessage(source.direct_conversation_id, {
            body,
            kind,
            turn_id: turnId,
          });
        }
        throw new Error("source message has no activity conversation");
      },
      update: (messageId, body) => this.clickClack.messages.update(messageId, { body }),
    };
  }

  private async sendReply(source: Message, body: string, nonce?: string): Promise<void> {
    if (source.channel_id) {
      await this.clickClack.channels.sendMessage(source.channel_id, {
        body,
        ...(nonce ? { nonce } : {}),
      });
      return;
    }
    if (source.direct_conversation_id) {
      await this.clickClack.dms.sendMessage(source.direct_conversation_id, {
        body,
        ...(nonce ? { nonce } : {}),
      });
      return;
    }
    throw new Error("source message has no replyable conversation");
  }

  private scheduleReconnect(): void {
    if (this.stopped || this.reconnectTimer) return;
    this.logger.warn("ClickClack realtime connection closed; reconnecting", { delayMs: reconnectDelayMs });
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = undefined;
      void this.trackRealtime(this.connectRealtime()).catch((error: unknown) => {
        this.logger.error("ClickClack realtime reconnect failed", { error });
        this.scheduleReconnect();
      });
    }, reconnectDelayMs);
  }
}

function conversationTarget(message: Message): ConversationTarget | undefined {
  if (message.channel_id) return { type: "channel", id: message.channel_id };
  if (message.direct_conversation_id) return { type: "direct", id: message.direct_conversation_id };
  return undefined;
}

function parseProjectCommand(body: string): string | undefined {
  const match = /^\/project\s+([a-z][a-z0-9-]{0,62})\s*$/iu.exec(body);
  return match?.[1]?.toLowerCase();
}

function stripBotMention(body: string, handle: string): string {
  const escaped = handle.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
  return body.replace(new RegExp(`(?:^|\\s)@${escaped}\\b`, "giu"), " ").trim();
}

function textField(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function positiveIntegerField(value: unknown): number {
  const parsed = typeof value === "number" ? value : typeof value === "string" ? Number(value) : 0;
  return Number.isInteger(parsed) && parsed > 0 ? parsed : 0;
}

function normalizeContentType(value: string): string {
  return value.split(";", 1)[0]?.trim().toLowerCase() ?? "";
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function settlesWithin(task: Promise<void>, timeoutMs: number): Promise<boolean> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      task.then(() => true),
      new Promise<false>((resolve) => {
        timer = setTimeout(() => resolve(false), Math.max(0, timeoutMs));
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function isContinueCommand(body: string): boolean {
  return body.trim().toLowerCase() === "/continue";
}

function isRecoverableSessionFile(path: string): boolean {
  if (!existsSync(path)) return false;
  const pendingToolCalls = new Set<string>();
  try {
    for (const line of readFileSync(path, "utf8").split("\n")) {
      if (!line.trim()) continue;
      const entry = JSON.parse(line) as { message?: unknown };
      const message = entry.message;
      if (!message || typeof message !== "object" || !("role" in message)) continue;
      if (message.role === "assistant" && "content" in message && Array.isArray(message.content)) {
        for (const part of message.content) {
          if (!part || typeof part !== "object" || !("type" in part) || part.type !== "toolCall") continue;
          if ("id" in part && typeof part.id === "string") pendingToolCalls.add(part.id);
        }
      }
      if (message.role === "toolResult" && "toolCallId" in message && typeof message.toolCallId === "string") {
        pendingToolCalls.delete(message.toolCallId);
      }
    }
  } catch {
    return false;
  }
  return pendingToolCalls.size === 0;
}

function formatSessionStats(runtime: AgentSessionRuntime): string {
  const stats = runtime.session.getSessionStats();
  const context = stats.contextUsage && stats.contextUsage.tokens !== null && stats.contextUsage.percent !== null
    ? `${stats.contextUsage.tokens.toLocaleString()} / ${stats.contextUsage.contextWindow.toLocaleString()} tokens (${stats.contextUsage.percent.toFixed(1)}%)`
    : "unavailable";
  return [
    "**Pi session**",
    "",
    `- name: ${runtime.session.sessionName ?? "unnamed"}`,
    `- id: \`${stats.sessionId}\``,
    `- model: ${runtime.session.model ? `${runtime.session.model.provider}/${runtime.session.model.id}` : "none"}`,
    `- thinking: ${runtime.session.thinkingLevel}`,
    `- messages: ${stats.totalMessages} (${stats.userMessages} user, ${stats.assistantMessages} assistant)`,
    `- tools: ${stats.toolCalls} calls, ${stats.toolResults} results`,
    `- tokens: ${stats.tokens.total.toLocaleString()}`,
    `- context: ${context}`,
    `- cost: $${stats.cost.toFixed(3)}`,
  ].join("\n");
}

function finalAssistantText(messages: readonly unknown[], allowMissing = false): string | undefined {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (!message || typeof message !== "object" || !("role" in message) || message.role !== "assistant") continue;
    const stopReason = "stopReason" in message && typeof message.stopReason === "string" ? message.stopReason : undefined;
    const errorMessage = "errorMessage" in message && typeof message.errorMessage === "string"
      ? message.errorMessage
      : "Pi assistant turn failed";
    if (stopReason === "error" || stopReason === "aborted") throw new Error(errorMessage);
    if (stopReason === "toolUse") throw new Error("Pi turn ended with an unresolved tool call");
    if (!("content" in message)) break;
    if (typeof message.content === "string" && message.content.trim()) return message.content.trim();
    if (!Array.isArray(message.content)) break;
    const text = message.content
      .filter((part): part is { type: "text"; text: string } => Boolean(
        part && typeof part === "object" && "type" in part && part.type === "text" && "text" in part && typeof part.text === "string",
      ))
      .map((part) => part.text)
      .join("")
      .trim();
    if (text) return text;
    break;
  }
  if (allowMissing) return undefined;
  throw new MissingAssistantTextError();
}

class MissingAssistantTextError extends Error {
  constructor() {
    super("Pi completed without an assistant text response");
    this.name = "MissingAssistantTextError";
  }
}
