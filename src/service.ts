import { randomUUID } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";

import type { Message, RealtimeEvent, User, Workspace } from "@clickclack/sdk-ts";
import type { AgentSessionRuntime } from "@earendil-works/pi-coding-agent";

import { TurnActivity, type ActivityTransport } from "./activity.js";
import { createClickClackClient, type ClickClackBoundary } from "./clickclack.js";
import type { BridgeConfig } from "./config.js";
import { createLogger, environmentSecretValues, type Logger } from "./logger.js";
import { createEmbeddedPiRuntime, type EmbeddedPiRuntimeBoundary } from "./pi-runtime.js";
import { StateStore, type ConversationBinding } from "./state/store.js";
import {
  toConversationId,
  toMessageId,
  toProjectAlias,
  toTurnId,
  type ConversationType,
  type InvocationMode,
} from "./types.js";

export type BridgeServiceDependencies = {
  logger?: Logger;
  stateStore?: StateStore;
  clickClack?: ClickClackBoundary;
  piRuntime?: EmbeddedPiRuntimeBoundary;
};

type ConversationTarget = {
  type: ConversationType;
  id: string;
};

const reconnectDelayMs = 1_000;

export class BridgeService {
  readonly state: StateStore;
  readonly clickClack: ClickClackBoundary;
  readonly piRuntime: EmbeddedPiRuntimeBoundary;
  readonly logger: Logger;

  private started = false;
  private stopped = false;
  private identity?: User;
  private workspace?: Workspace;
  private socket: WebSocket | undefined;
  private reconnectTimer: NodeJS.Timeout | undefined;
  private eventQueue: Promise<void> = Promise.resolve();
  private readonly runtimes = new Map<number, AgentSessionRuntime>();

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
  }

  async start(): Promise<void> {
    if (this.stopped) throw new Error("cannot start a stopped bridge service");
    if (this.started) return;

    const [identity, workspace] = await Promise.all([
      this.clickClack.me(),
      this.clickClack.workspaces.get(this.config.clickClack.workspaceId),
    ]);
    if (identity.kind !== "bot") throw new Error("CLICKCLACK_BOT_TOKEN did not authenticate as a bot");
    if (workspace.id !== this.config.clickClack.workspaceId) {
      throw new Error("ClickClack returned the wrong configured workspace");
    }

    this.identity = identity;
    this.workspace = workspace;
    const interruptedTurns = this.state.recoverInterruptedTurns();
    if (interruptedTurns > 0) {
      this.logger.warn("recovered interrupted Pi turns from previous bridge process", { interruptedTurns });
    }
    this.started = true;
    await this.connectRealtime();
    this.logger.info("bridge service started", {
      botUserId: identity.id,
      botHandle: identity.handle,
      workspaceId: workspace.id,
      projectAliases: [...this.config.projects.keys()],
      piRuntime: this.piRuntime.kind,
      sessionsStarted: this.runtimes.size,
    });
  }

  stop(): void {
    if (this.stopped) return;
    this.stopped = true;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.socket?.close();
    this.socket = undefined;
    for (const runtime of this.runtimes.values()) void runtime.dispose();
    this.runtimes.clear();
    this.state.close();
    this.logger.info("bridge service stopped", {
      started: this.started,
      botUserId: this.identity?.id,
      workspaceId: this.workspace?.id,
    });
  }

  async waitForIdle(): Promise<void> {
    await this.eventQueue;
  }

  private async connectRealtime(): Promise<void> {
    if (this.stopped) return;
    let cursor = this.state.getRealtimeCursor();

    if (!cursor) {
      const initial = await this.clickClack.events.list({
        workspaceId: this.config.clickClack.workspaceId,
        limit: 1,
        includeTail: true,
      });
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
    try {
      if (event.workspace_id !== this.config.clickClack.workspaceId) return;
      if (event.type !== "message.created") return;
      const messageId = textField(event.payload.message_id);
      if (!messageId) return;
      const message = await this.clickClack.messages.get(messageId);
      await this.processMessage(event, message);
    } finally {
      if (event.cursor) this.state.advanceRealtimeCursor(event.cursor);
    }
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
      await this.bindProject(target, projectCommand, message);
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

    const claim = this.state.claimSourceMessage({
      messageId: toMessageId(message.id),
      eventId: event.id,
      eventCursor: event.cursor,
    });
    if (!claim.claimed) return;

    if (isContinueCommand(cleanBody)) {
      await this.continueSession(binding, message);
      return;
    }

    const prompt = cleanBody || "say hello and briefly identify the project connected to this conversation.";
    await this.runTurn(binding, message, prompt);
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
      const runtime = this.runtimes.get(previous.id);
      if (runtime) await runtime.dispose();
      this.runtimes.delete(previous.id);
      this.state.archiveActivePiSession(previous.id);
    }
    const binding = this.state.upsertBinding({
      conversationType: target.type,
      conversationId,
      projectAlias: alias,
      invocationMode: this.invocationMode(target),
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

  private async runTurn(binding: ConversationBinding, source: Message, prompt: string): Promise<void> {
    const turnId = toTurnId(`turn_${randomUUID()}`);
    let status: "starting" | "running" = "starting";
    let activity: TurnActivity | undefined;
    let unsubscribe: (() => void) | undefined;
    try {
      this.state.startActiveTurn({
        turnId,
        bindingId: binding.id,
        sourceMessageId: toMessageId(source.id),
      });
      const runtime = await this.runtimeFor(binding);
      activity = new TurnActivity({
        turnId,
        source,
        projectCwd: this.piRuntime.project(binding.projectAlias).cwd,
        transport: this.activityTransport(source),
        onError: (error) => this.logger.warn("agent activity publish failed", { turnId, error }),
      });
      unsubscribe = runtime.session.subscribe((event) => activity?.handle(event));
      this.state.transitionActiveTurn(turnId, "starting", "running");
      status = "running";
      const messageStart = runtime.session.messages.length;
      try {
        await runtime.session.prompt(prompt, { source: "interactive" });
      } finally {
        unsubscribe();
        unsubscribe = undefined;
      }
      const answer = finalAssistantText(runtime.session.messages.slice(messageStart));
      await activity.finalize();
      await this.sendReply(source, answer, `pi-${source.id}`);
      this.state.finishActiveTurn(turnId, "running");
      this.logger.info("Pi turn completed", {
        turnId,
        sourceMessageId: source.id,
        projectAlias: binding.projectAlias,
      });
    } catch (error) {
      unsubscribe?.();
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
      await this.sendReply(source, "pi couldn't complete that turn. check the bridge log for the error.", `pi-error-${source.id}`);
    }
  }

  private async runtimeFor(binding: ConversationBinding): Promise<AgentSessionRuntime> {
    const cached = this.runtimes.get(binding.id);
    if (cached) return cached;
    const reference = this.state.getActivePiSession(binding.id);
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
    return runtime;
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
      void this.connectRealtime().catch((error: unknown) => {
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

function finalAssistantText(messages: readonly unknown[]): string {
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
  throw new Error("Pi completed without an assistant text response");
}
