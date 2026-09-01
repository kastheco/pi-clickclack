import { randomUUID } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";

import type { BotCommandInput, Message, RealtimeEvent, User, Workspace } from "@clickclack/sdk-ts";
import { resolveCliModel, type AgentSessionRuntime } from "@earendil-works/pi-coding-agent";

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

type ActiveSessionTurn = {
  activity: TurnActivity;
  session: AgentSessionRuntime["session"];
  messageStart: number;
  unsubscribe: (() => void) | undefined;
};

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
  private readonly activeSessionTurns = new Map<number, ActiveSessionTurn>();
  private readonly activeExtensionErrors = new Map<number, Error[]>();
  private readonly projectCommandMenus = new Map<string, BotCommandInput[]>();

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
    await this.publishCommandMenu();
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

    const slashInvocation = parseSlashInvocation(cleanBody);
    if (slashInvocation) {
      await this.handleSlashCommand(binding, message, slashInvocation);
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

  private async handleSlashCommand(
    binding: ConversationBinding,
    source: Message,
    invocation: SlashInvocation,
  ): Promise<void> {
    const command = invocation.name.toLowerCase();
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
      activeSessionTurn = {
        activity,
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
        await this.promptAndWaitForNestedPrompts(runtime.session, prompt);
        if (extensionErrors[0]) throw extensionErrors[0];
      } finally {
        this.activeExtensionErrors.delete(binding.id);
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
    return runtime;
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
    activeTurn.unsubscribe = session.subscribe((event) => activeTurn.activity.handle(event));
  }

  private async replaceRuntimeSession(
    binding: ConversationBinding,
    runtime: AgentSessionRuntime,
    replace: () => Promise<{ cancelled: boolean }>,
  ): Promise<{ cancelled: boolean }> {
    try {
      const result = await replace();
      if (!result.cancelled) this.recordReplacementSession(binding, runtime);
      return result;
    } catch (error) {
      this.runtimes.delete(binding.id);
      throw error;
    }
  }

  private async promptAndWaitForNestedPrompts(
    session: AgentSessionRuntime["session"],
    prompt: string,
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
      await session.prompt(prompt, { source: "interactive" });
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
  throw new Error("Pi completed without an assistant text response");
}
