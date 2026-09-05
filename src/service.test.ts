import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import type { BotCommandInput, Message, MessageInput, RealtimeEvent } from "@clickclack/sdk-ts";

import { createBridgeApplication } from "./application.js";
import type { ClickClackBoundary } from "./clickclack.js";
import type { BridgeConfig, ProjectConfig } from "./config.js";
import { createLogger } from "./logger.js";
import type { EmbeddedPiRuntimeBoundary } from "./pi-runtime.js";
import { BridgeService } from "./service.js";
import { StateStore, type ConversationBinding } from "./state/store.js";
import type { ClaimedWorkflowDecision, DecisionAnswer } from "./workflow-decisions.js";
import { toProjectAlias } from "./types.js";

type EventHandler = (event: RealtimeEvent) => void;

type Fixture = {
  config: BridgeConfig;
  clickClack: ClickClackBoundary;
  messages: Map<string, Message>;
  sent: Array<{ target: "channel" | "direct"; id: string; body: string }>;
  activity: Array<{ target: "channel" | "direct"; id: string; body: string; kind: string; turnId?: string }>;
  commandMenu: BotCommandInput[];
  ephemeral: Array<{ type: string; channelId?: string; directConversationId?: string; payload: unknown }>;
  emit(event: RealtimeEvent): void;
  subscriptionCount(): number;
};

function fixture(projectNames: readonly string[] = ["main"]): Fixture {
  const projects = new Map(projectNames.map((name) => {
    const alias = toProjectAlias(name);
    return [alias, { alias, cwd: `/tmp/${name}` } satisfies ProjectConfig] as const;
  }));
  const config: BridgeConfig = {
    clickClack: {
      baseUrl: "https://clickclack.example.test",
      workspaceId: "wsp_test",
      botToken: "ccb_secret",
      ownerIds: ["usr_owner"],
    },
    projects,
    invocationBindings: [],
    pi: {
      model: "provider/model",
      thinkingLevel: "medium",
      agentDir: "/tmp",
    },
    statePath: ":memory:",
  };
  const messages = new Map<string, Message>();
  const sent: Array<{ target: "channel" | "direct"; id: string; body: string }> = [];
  const activity: Array<{ target: "channel" | "direct"; id: string; body: string; kind: string; turnId?: string }> = [];
  const commandMenu: BotCommandInput[] = [];
  const ephemeral: Fixture["ephemeral"] = [];
  let onEvent: EventHandler | undefined;
  let subscriptions = 0;
  const clickClack = {
    me: async () => ({
      id: "usr_bot",
      kind: "bot" as const,
      display_name: "Bridge",
      handle: "bridge",
      avatar_url: "",
      created_at: "2026-01-01T00:00:00Z",
    }),
    workspaces: {
      get: async () => ({
        id: "wsp_test",
        route_id: "W1",
        name: "Test",
        slug: "test",
        icon_url: "",
        created_at: "2026-01-01T00:00:00Z",
      }),
    },
    bots: {
      setCommands: async (commands: BotCommandInput[]) => {
        commandMenu.splice(0, commandMenu.length, ...commands);
        return [];
      },
    },
    messages: {
      get: async (messageId: string) => {
        const message = messages.get(messageId);
        if (!message) throw new Error(`missing fake message ${messageId}`);
        return message;
      },
      update: async (messageId: string, input: { body: string }) => {
        const row = activity.find((candidate) => candidate.id === messageId);
        if (row) row.body = input.body;
        return { id: messageId };
      },
    },
    channels: {
      sendMessage: async (channelId: string, input: MessageInput) => {
        if (input.kind === "agent_commentary" || input.kind === "agent_tool") {
          const id = `activity_${activity.length + 1}`;
          activity.push({ target: "channel", id, body: input.body, kind: input.kind, ...(input.turn_id ? { turnId: input.turn_id } : {}) });
          return { id };
        }
        sent.push({ target: "channel", id: channelId, body: input.body });
        return { id: `sent_${sent.length}` };
      },
    },
    dms: {
      sendMessage: async (conversationId: string, input: MessageInput) => {
        if (input.kind === "agent_commentary" || input.kind === "agent_tool") {
          const id = `activity_${activity.length + 1}`;
          activity.push({ target: "direct", id, body: input.body, kind: input.kind, ...(input.turn_id ? { turnId: input.turn_id } : {}) });
          return { id };
        }
        sent.push({ target: "direct", id: conversationId, body: input.body });
        return { id: `sent_${sent.length}` };
      },
    },
    events: {
      list: async () => ({ events: [], tailCursor: "cur_100" }),
      publishEphemeral: async (input: {
        type: string;
        channelId?: string;
        directConversationId?: string;
        payload: unknown;
      }) => {
        ephemeral.push({
          type: input.type,
          ...(input.channelId ? { channelId: input.channelId } : {}),
          ...(input.directConversationId ? { directConversationId: input.directConversationId } : {}),
          payload: input.payload,
        });
        return { id: `eph_${ephemeral.length}` };
      },
      subscribe: (options: { onEvent: EventHandler }) => {
        subscriptions += 1;
        onEvent = options.onEvent;
        return { close() {} };
      },
    },
  } as unknown as ClickClackBoundary;
  return {
    config,
    clickClack,
    messages,
    sent,
    activity,
    commandMenu,
    ephemeral,
    emit(event) {
      if (!onEvent) throw new Error("fake realtime subscription has not started");
      onEvent(event);
    },
    subscriptionCount: () => subscriptions,
  };
}

function message(input: {
  id: string;
  body: string;
  authorId?: string;
  channelId?: string;
  directConversationId?: string;
  attachments?: Message["attachments"];
}): Message {
  return {
    id: input.id,
    workspace_id: "wsp_test",
    ...(input.channelId ? { channel_id: input.channelId } : {}),
    ...(input.directConversationId ? { direct_conversation_id: input.directConversationId } : {}),
    author_id: input.authorId ?? "usr_owner",
    thread_root_id: input.id,
    body: input.body,
    body_format: "markdown",
    created_at: "2026-01-01T00:00:00Z",
    kind: "message",
    ...(input.attachments ? { attachments: input.attachments } : {}),
  };
}

function createdEvent(input: {
  messageId: string;
  cursor: string;
  channelId?: string;
  mentionedUserIds?: string[];
}): RealtimeEvent {
  return {
    id: `evt_${input.messageId}`,
    cursor: input.cursor,
    type: "message.created",
    workspace_id: "wsp_test",
    ...(input.channelId ? { channel_id: input.channelId } : {}),
    created_at: "2026-01-01T00:00:00Z",
    payload: { message_id: input.messageId, author_id: "usr_owner" },
    ...(input.mentionedUserIds ? { mentioned_user_ids: input.mentionedUserIds } : {}),
  };
}

function workflowClientRecorder(options: { hangWhenStopping?: string } = {}) {
  const watched: string[] = [];
  const stopped: string[] = [];
  let closed = 0;
  return {
    watched,
    stopped,
    closed: () => closed,
    factory: () => ({
      clientId: "pi-clickclack-test",
      ensureAvailable: async () => ({}) as never,
      watchSession: async (sessionId: string) => {
        watched.push(sessionId);
        return async () => {
          stopped.push(sessionId);
          if (options.hangWhenStopping === sessionId) await new Promise<void>(() => {});
        };
      },
      request: async () => ({ outcome: "accepted" }),
      requestDurable: async () => ({ outcome: "accepted" }),
      close: async () => { closed += 1; },
    }),
  };
}

test("service authenticates, subscribes to realtime, and closes state cleanly", async () => {
  const setup = fixture();
  let sessionsCreated = 0;
  const piRuntime: EmbeddedPiRuntimeBoundary = {
    kind: "embedded-pi-sdk",
    project: (alias) => setup.config.projects.get(toProjectAlias(alias))!,
    createSessionRuntime: async () => {
      sessionsCreated += 1;
      throw new Error("not used by startup");
    },
  };
  const stateStore = new StateStore(":memory:");
  const lines: string[] = [];
  const service = new BridgeService(setup.config, {
    clickClack: setup.clickClack,
    piRuntime,
    stateStore,
    logger: createLogger({ sink: (line) => lines.push(line) }),
  });

  await service.start();
  assert.equal(sessionsCreated, 0);
  assert.equal(setup.subscriptionCount(), 1);
  assert.deepEqual(
    setup.commandMenu.map((command) => command.command),
    ["project", "invoke", "continue", "compact", "new", "name", "session", "model", "thinking", "reload", "copy"],
  );
  assert.match(lines.join("\n"), /"sessionsStarted":0/u);
  await service.waitForStop();
  assert.throws(() => stateStore.database.prepare("SELECT 1"), /not open|closed/u);
});

test("shutdown cancels a decision while its message is still publishing", async () => {
  const setup = fixture();
  const service = new BridgeService(setup.config, {
    clickClack: setup.clickClack,
    logger: createLogger({ sink() {} }),
  });
  const binding = service.state.upsertBinding({
    conversationType: "direct",
    conversationId: "dm_decision_publish" as never,
    projectAlias: toProjectAlias("main"),
    invocationMode: "auto",
  });
  const source = message({
    id: "msg_decision_source",
    body: "start",
    directConversationId: "dm_decision_publish",
  });
  const internals = service as unknown as {
    conversationSources: Map<number, Message>;
    presentedDecisions: Map<number, unknown>;
    presentDecision(
      binding: ConversationBinding,
      decision: ClaimedWorkflowDecision,
    ): Promise<DecisionAnswer | undefined>;
  };
  internals.conversationSources.set(binding.id, source);
  let releasePublish!: () => void;
  let markPublishStarted!: () => void;
  const publishGate = new Promise<void>((resolve) => { releasePublish = resolve; });
  const publishStarted = new Promise<void>((resolve) => { markPublishStarted = resolve; });
  const sendMessage = setup.clickClack.dms.sendMessage.bind(setup.clickClack.dms);
  setup.clickClack.dms.sendMessage = async (...args) => {
    markPublishStarted();
    await publishGate;
    return sendMessage(...args);
  };

  await service.start();
  const presenting = internals.presentDecision(binding, {
    requestId: "request-1",
    runId: "run-1",
    revision: 3,
    title: "Continue?",
    summary: "Choose whether to continue.",
    choices: [{ key: "continue", label: "Continue", expectsInput: false }],
  });
  await publishStarted;
  const stopping = service.waitForStop();
  releasePublish();

  assert.equal(await presenting, undefined);
  await stopping;
  assert.equal(internals.presentedDecisions.size, 0);
});

test("workflow cleanup invalidates the watcher before awaiting the reporter clear", async () => {
  const setup = fixture();
  const service = new BridgeService(setup.config, {
    clickClack: setup.clickClack,
    logger: createLogger({ sink() {} }),
  });
  const order: string[] = [];
  let releaseReporter!: () => void;
  const reporterGate = new Promise<void>((resolve) => { releaseReporter = resolve; });
  const internals = service as unknown as {
    presentedDecisions: Map<number, { resolve(answer: undefined): void }>;
    runReporters: Map<number, { stop(): Promise<void> }>;
    decisionWatchers: Map<number, { stop(): Promise<void> }>;
    workflowSessionIds: Map<number, string>;
    stopWorkflowObservation(bindingId: number): Promise<void>;
  };
  internals.presentedDecisions.set(1, {
    resolve: () => { order.push("release-presentation"); },
  });
  internals.runReporters.set(1, {
    stop: async () => {
      order.push("reporter-start");
      await reporterGate;
      order.push("reporter-finish");
    },
  });
  internals.decisionWatchers.set(1, {
    stop: async () => { order.push("watcher-stop"); },
  });
  internals.workflowSessionIds.set(1, "session-1");

  const stopping = internals.stopWorkflowObservation(1);
  await Promise.resolve();
  assert.deepEqual(order, ["release-presentation", "watcher-stop", "reporter-start"]);
  releaseReporter();
  await stopping;
});

test("shutdown drains an in-flight realtime catch-up before closing state", async () => {
  const setup = fixture();
  const stateStore = new StateStore(":memory:");
  stateStore.advanceRealtimeCursor("cur_100");
  let releaseList!: () => void;
  let markListStarted!: () => void;
  const listGate = new Promise<void>((resolve) => { releaseList = resolve; });
  const listStarted = new Promise<void>((resolve) => { markListStarted = resolve; });
  let messageReads = 0;
  setup.clickClack.messages.get = async (messageId) => {
    messageReads += 1;
    return setup.messages.get(messageId)!;
  };
  setup.clickClack.events.list = async () => {
    markListStarted();
    await listGate;
    return {
      events: [createdEvent({ messageId: "msg_during_stop", cursor: "cur_101" })],
      tailCursor: "cur_101",
    };
  };
  const piRuntime: EmbeddedPiRuntimeBoundary = {
    kind: "embedded-pi-sdk",
    project: (alias) => setup.config.projects.get(toProjectAlias(alias))!,
    createSessionRuntime: async () => { throw new Error("runtime must not start during shutdown"); },
  };
  const service = new BridgeService(setup.config, {
    clickClack: setup.clickClack,
    piRuntime,
    stateStore,
    logger: createLogger({ sink() {} }),
  });

  const starting = service.start();
  await listStarted;
  const stopping = service.waitForStop();
  releaseList();
  await starting;
  await stopping;

  assert.equal(messageReads, 0);
  assert.throws(() => stateStore.database.prepare("SELECT 1"), /not open|closed/u);
});

test("an owner mention auto-binds the only project, runs Pi, and replies", async () => {
  const setup = fixture();
  const sessionMessages: unknown[] = [];
  let receivedPrompt = "";
  let sessionListener: ((event: unknown) => void) | undefined;
  const runtime = {
    session: {
      sessionId: "session-1",
      sessionFile: "/tmp/session-1.jsonl",
      messages: sessionMessages,
      subscribe(listener: (event: unknown) => void) {
        sessionListener = listener;
        return () => { sessionListener = undefined; };
      },
      async prompt(text: string) {
        receivedPrompt = text;
        const preamble = { role: "assistant", content: [{ type: "text", text: "I'll inspect the project." }], stopReason: "toolUse" };
        sessionListener?.({ type: "message_start", message: { role: "assistant", content: [] } });
        sessionListener?.({ type: "message_update", message: preamble, assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "I'll inspect the project." } });
        sessionListener?.({ type: "message_end", message: preamble });
        sessionListener?.({ type: "tool_execution_start", toolCallId: "tool_1", toolName: "read", args: { path: "/tmp/main/package.json" } });
        sessionListener?.({ type: "tool_execution_end", toolCallId: "tool_1", toolName: "read", args: { path: "/tmp/main/package.json" }, result: {}, isError: false });
        sessionMessages.push(preamble);
        const assistant = { role: "assistant", content: [{ type: "text", text: "hello from pi" }], stopReason: "stop" };
        sessionListener?.({ type: "message_start", message: { role: "assistant", content: [] } });
        sessionListener?.({ type: "message_update", message: assistant, assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "hello from pi" } });
        sessionListener?.({ type: "message_end", message: assistant });
        sessionMessages.push(assistant);
      },
    },
    async dispose() {},
  };
  const piRuntime = {
    kind: "embedded-pi-sdk" as const,
    project: (alias: string) => setup.config.projects.get(toProjectAlias(alias))!,
    createSessionRuntime: async () => runtime,
  } as unknown as EmbeddedPiRuntimeBoundary;
  let workflowClientCreated = 0;
  let workflowClientClosed = 0;
  let workflowWatcherStopped = 0;
  const watchedSessions: string[] = [];
  const application = createBridgeApplication(setup.config, {
    clickClack: setup.clickClack,
    piRuntime,
    logger: createLogger({ sink() {} }),
    workflowClientFactory: () => {
      workflowClientCreated += 1;
      return {
        clientId: "pi-clickclack-test",
        ensureAvailable: async () => ({}) as never,
        watchSession: async (sessionId) => {
          watchedSessions.push(sessionId);
          return async () => { workflowWatcherStopped += 1; };
        },
        request: async () => ({ outcome: "accepted" }),
        requestDurable: async () => ({ outcome: "accepted" }),
        close: async () => { workflowClientClosed += 1; },
      };
    },
  });
  const service = application.service;
  const source = message({ id: "msg_1", body: "@bridge hello", channelId: "chn_1" });
  setup.messages.set(source.id, source);

  await service.start();
  setup.emit(createdEvent({
    messageId: source.id,
    cursor: "cur_200",
    channelId: "chn_1",
    mentionedUserIds: ["usr_bot"],
  }));
  await service.waitForIdle();

  assert.equal(receivedPrompt, "hello");
  assert.deepEqual(setup.sent, [{ target: "channel", id: "chn_1", body: "hello from pi" }]);
  assert.equal(setup.activity.length, 2);
  assert.deepEqual(setup.activity.map(({ body, kind }) => ({ body, kind })), [
    { body: "I'll inspect the project.", kind: "agent_commentary" },
    { body: "**read**\n\n/tmp/main/package.json", kind: "agent_tool" },
  ]);
  assert.equal(setup.activity[0]?.turnId, setup.activity[1]?.turnId);
  assert.equal(service.state.getBinding("channel", "chn_1" as never)?.projectAlias, "main");
  assert.equal(service.state.getActivePiSession(1)?.sessionId, "session-1");
  assert.equal(workflowClientCreated, 1);
  assert.deepEqual(watchedSessions, ["session-1"]);
  await application.stop();
  assert.equal(workflowWatcherStopped, 1);
  assert.equal(workflowClientClosed, 1);
});

test("application shutdown reports a stuck runtime and keeps the process safety deadline actionable", async () => {
  const setup = fixture();
  const runtime = {
    session: {
      sessionId: "session-hung-runtime",
      sessionFile: "/tmp/session-hung-runtime.jsonl",
      messages: [] as unknown[],
      subscribe() { return () => {}; },
      async prompt() {
        this.messages.push({ role: "assistant", content: [{ type: "text", text: "done" }], stopReason: "stop" });
      },
    },
    async dispose() { await new Promise<void>(() => {}); },
  };
  const piRuntime = {
    kind: "embedded-pi-sdk" as const,
    project: (alias: string) => setup.config.projects.get(toProjectAlias(alias))!,
    createSessionRuntime: async () => runtime,
  } as unknown as EmbeddedPiRuntimeBoundary;
  let workflowClientClosed = 0;
  const logLines: string[] = [];
  const application = createBridgeApplication(setup.config, {
    clickClack: setup.clickClack,
    piRuntime,
    logger: createLogger({ sink: (line) => logLines.push(line) }),
    shutdownTimeoutMs: 5,
    forcedCleanupTimeoutMs: 5,
    workflowClientFactory: () => ({
      clientId: "pi-clickclack-test",
      ensureAvailable: async () => ({}) as never,
      watchSession: async () => async () => undefined,
      request: async () => ({ outcome: "accepted" }),
      requestDurable: async () => ({ outcome: "accepted" }),
      close: async () => { workflowClientClosed += 1; },
    }),
  });
  const source = message({ id: "msg_hung_unwatch", body: "run", directConversationId: "dm_hung_unwatch" });
  setup.messages.set(source.id, source);

  await application.service.start();
  setup.emit(createdEvent({ messageId: source.id, cursor: "cur_200" }));
  await application.service.waitForIdle();
  const stopResult = await application.stop();

  assert.equal(stopResult, "timed_out");
  assert.equal(workflowClientClosed, 1);
  assert.match(logLines.join("\n"), /shutdown deadline/u);
  assert.match(logLines.join("\n"), /remained stuck/u);
});

test("application shutdown drains runtime creation before disposal and state close", async () => {
  const setup = fixture();
  let releaseCreation!: () => void;
  let markCreationStarted!: () => void;
  const creationGate = new Promise<void>((resolve) => { releaseCreation = resolve; });
  const creationStarted = new Promise<void>((resolve) => { markCreationStarted = resolve; });
  let disposed = 0;
  const runtime = {
    session: {
      sessionId: "session-late-runtime",
      sessionFile: "/tmp/session-late-runtime.jsonl",
      messages: [] as unknown[],
      subscribe() { return () => {}; },
      async prompt() {
        this.messages.push({ role: "assistant", content: [{ type: "text", text: "done" }], stopReason: "stop" });
      },
    },
    async dispose() { disposed += 1; },
  };
  const piRuntime = {
    kind: "embedded-pi-sdk" as const,
    project: (alias: string) => setup.config.projects.get(toProjectAlias(alias))!,
    createSessionRuntime: async () => {
      markCreationStarted();
      await creationGate;
      return runtime;
    },
  } as unknown as EmbeddedPiRuntimeBoundary;
  const application = createBridgeApplication(setup.config, {
    clickClack: setup.clickClack,
    piRuntime,
    logger: createLogger({ sink() {} }),
    workflowClientFactory: () => ({
      clientId: "pi-clickclack-test",
      ensureAvailable: async () => ({}) as never,
      watchSession: async () => async () => undefined,
      request: async () => ({ outcome: "accepted" }),
      requestDurable: async () => ({ outcome: "accepted" }),
      close: async () => undefined,
    }),
  });
  const source = message({ id: "msg_late_runtime", body: "run", directConversationId: "dm_late_runtime" });
  setup.messages.set(source.id, source);

  await application.service.start();
  setup.emit(createdEvent({ messageId: source.id, cursor: "cur_200" }));
  await creationStarted;
  const stopping = application.stop();
  releaseCreation();

  assert.equal(await stopping, "completed");
  assert.equal(disposed, 1);
});

test("application shutdown reports rejected runtime disposal", async () => {
  const setup = fixture();
  let workflowClientClosed = 0;
  const runtime = {
    session: {
      sessionId: "session-rejected-disposal",
      sessionFile: "/tmp/session-rejected-disposal.jsonl",
      messages: [] as unknown[],
      subscribe() { return () => {}; },
      async prompt() {
        this.messages.push({ role: "assistant", content: [{ type: "text", text: "done" }], stopReason: "stop" });
      },
    },
    async dispose() { throw new Error("dispose failed"); },
  };
  const piRuntime = {
    kind: "embedded-pi-sdk" as const,
    project: (alias: string) => setup.config.projects.get(toProjectAlias(alias))!,
    createSessionRuntime: async () => runtime,
  } as unknown as EmbeddedPiRuntimeBoundary;
  const application = createBridgeApplication(setup.config, {
    clickClack: setup.clickClack,
    piRuntime,
    logger: createLogger({ sink() {} }),
    workflowClientFactory: () => ({
      clientId: "pi-clickclack-test",
      ensureAvailable: async () => ({}) as never,
      watchSession: async () => async () => undefined,
      request: async () => ({ outcome: "accepted" }),
      requestDurable: async () => ({ outcome: "accepted" }),
      close: async () => { workflowClientClosed += 1; },
    }),
  });
  const source = message({ id: "msg_rejected_disposal", body: "run", directConversationId: "dm_rejected_disposal" });
  setup.messages.set(source.id, source);

  await application.service.start();
  setup.emit(createdEvent({ messageId: source.id, cursor: "cur_200" }));
  await application.service.waitForIdle();

  assert.equal(await application.stop(), "failed");
  assert.equal(workflowClientClosed, 1);
});

test("an attachment is hydrated, downloaded, and passed to Pi as an image", async () => {
  const setup = fixture();
  const upload = {
    id: "upl_1",
    workspace_id: "wsp_test",
    owner_id: "usr_owner",
    filename: "diagram.png",
    content_type: "image/png",
    byte_size: 7,
    created_at: "2026-01-01T00:00:00Z",
  };
  const source = message({
    id: "msg_image",
    body: "look at this",
    directConversationId: "dm_1",
  });
  const hydrated = message({
    id: source.id,
    body: source.body,
    directConversationId: "dm_1",
    attachments: [upload],
  });
  let messageReads = 0;
  setup.messages.set(source.id, source);
  setup.clickClack.messages.get = async () => {
    messageReads += 1;
    if (messageReads === 2) throw new Error("temporary read failure");
    return messageReads === 1 ? source : hydrated;
  };
  const downloaded: string[] = [];
  const lifecycle: string[] = [];
  let sessionIdle = true;
  Object.assign(setup.clickClack, {
    uploads: {
      download: async (uploadId: string) => {
        downloaded.push(uploadId);
        lifecycle.push("download");
        sessionIdle = false;
        return new Blob(["PNGDATA"], { type: "image/png" });
      },
    },
  });
  let receivedPrompt = "";
  let receivedImages: unknown[] | undefined;
  const runtime = {
    session: {
      sessionId: "session-image",
      sessionFile: "/tmp/session-image.jsonl",
      messages: [] as unknown[],
      get isIdle() { return sessionIdle; },
      subscribe() { return () => {}; },
      async waitForIdle() {
        lifecycle.push("wait");
        sessionIdle = true;
      },
      async prompt(text: string, options?: { images?: unknown[] }) {
        lifecycle.push("prompt");
        assert.equal(sessionIdle, true);
        receivedPrompt = text;
        receivedImages = options?.images;
        this.messages.push({ role: "assistant", content: [{ type: "text", text: "seen" }], stopReason: "stop" });
      },
    },
    async dispose() {},
  };
  const piRuntime = {
    kind: "embedded-pi-sdk" as const,
    project: (alias: string) => setup.config.projects.get(toProjectAlias(alias))!,
    createSessionRuntime: async () => runtime,
  } as unknown as EmbeddedPiRuntimeBoundary;
  const service = new BridgeService(setup.config, {
    clickClack: setup.clickClack,
    piRuntime,
    logger: createLogger({ sink() {} }),
    sleep: async () => {},
  } as ConstructorParameters<typeof BridgeService>[1]);

  await service.start();
  setup.emit({
    ...createdEvent({ messageId: source.id, cursor: "cur_200" }),
    payload: {
      message_id: source.id,
      author_id: "usr_owner",
      direct_conversation_id: "dm_1",
      expected_attachment_count: "1",
    },
  });
  await service.waitForIdle();

  assert.equal(messageReads, 3);
  assert.deepEqual(downloaded, [upload.id]);
  assert.equal(receivedPrompt, "look at this");
  assert.deepEqual(lifecycle, ["download", "wait", "prompt", "wait"]);
  assert.deepEqual(receivedImages, [{
    type: "image",
    data: Buffer.from("PNGDATA").toString("base64"),
    mimeType: "image/png",
  }]);
  assert.deepEqual(setup.sent, [{ target: "direct", id: "dm_1", body: "seen" }]);
  service.stop();
});

test("an incomplete attachment set fails visibly without prompting Pi", async () => {
  const setup = fixture();
  const source = message({
    id: "msg_incomplete_image",
    body: "look at this",
    directConversationId: "dm_1",
  });
  let messageReads = 0;
  setup.messages.set(source.id, source);
  setup.clickClack.messages.get = async () => {
    messageReads += 1;
    return source;
  };
  const piRuntime = {
    kind: "embedded-pi-sdk" as const,
    project: (alias: string) => setup.config.projects.get(toProjectAlias(alias))!,
    createSessionRuntime: async () => {
      throw new Error("Pi must not start for incomplete attachments");
    },
  } as unknown as EmbeddedPiRuntimeBoundary;
  const service = new BridgeService(setup.config, {
    clickClack: setup.clickClack,
    piRuntime,
    logger: createLogger({ sink() {} }),
    sleep: async () => {},
  });

  await service.start();
  setup.emit({
    ...createdEvent({ messageId: source.id, cursor: "cur_200" }),
    payload: {
      message_id: source.id,
      author_id: "usr_owner",
      direct_conversation_id: "dm_1",
      expected_attachment_count: "1",
    },
  });
  await service.waitForIdle();

  assert.equal(messageReads, 26);
  assert.deepEqual(setup.sent, [{
    target: "direct",
    id: "dm_1",
    body: "i couldn't load every attachment. please resend the message and try again.",
  }]);
  service.stop();
});

test("oversized images are rejected before the bridge downloads them", async () => {
  const setup = fixture();
  const source = message({
    id: "msg_oversized_image",
    body: "look at this",
    directConversationId: "dm_1",
    attachments: Array.from({ length: 5 }, (_, index) => ({
      id: `upl_large_${index}`,
      workspace_id: "wsp_test",
      owner_id: "usr_owner",
      filename: `large-${index}.png`,
      content_type: "image/png",
      byte_size: 5 * 1024 * 1024,
      created_at: "2026-01-01T00:00:00Z",
    })),
  });
  setup.messages.set(source.id, source);
  let downloads = 0;
  Object.assign(setup.clickClack, {
    uploads: {
      download: async () => {
        downloads += 1;
        return new Blob();
      },
    },
  });
  let prompts = 0;
  const runtime = {
    session: {
      sessionId: "session-large-image",
      sessionFile: "/tmp/session-large-image.jsonl",
      messages: [] as unknown[],
      subscribe() { return () => {}; },
      async prompt() { prompts += 1; },
    },
    async dispose() {},
  };
  const piRuntime = {
    kind: "embedded-pi-sdk" as const,
    project: (alias: string) => setup.config.projects.get(toProjectAlias(alias))!,
    createSessionRuntime: async () => runtime,
  } as unknown as EmbeddedPiRuntimeBoundary;
  const logLines: string[] = [];
  const service = new BridgeService(setup.config, {
    clickClack: setup.clickClack,
    piRuntime,
    logger: createLogger({ sink: (line) => logLines.push(line) }),
  });

  await service.start();
  setup.emit(createdEvent({ messageId: source.id, cursor: "cur_200" }));
  await service.waitForIdle();

  assert.equal(downloads, 0);
  assert.equal(prompts, 0);
  assert.match(logLines.join("\n"), /image attachments total/u);
  assert.deepEqual(setup.sent, [{
    target: "direct",
    id: "dm_1",
    body: "pi couldn't complete that turn. check the bridge log for the error.",
  }]);
  service.stop();
});

test("continue restores the latest recoverable session and resumes its interrupted work", async () => {
  const root = mkdtempSync(join(tmpdir(), "pi-clickclack-continue-"));
  try {
    const setup = fixture();
    const sessionFile = join(root, "session.jsonl");
    writeFileSync(sessionFile, [
      JSON.stringify({ type: "session", id: "session-old", cwd: "/tmp/main" }),
      JSON.stringify({ type: "message", message: { role: "assistant", content: [{ type: "toolCall", id: "tool_1", name: "read", arguments: {} }], stopReason: "toolUse" } }),
      JSON.stringify({ type: "message", message: { role: "toolResult", toolCallId: "tool_1", toolName: "read", content: [{ type: "text", text: "result" }] } }),
    ].join("\n"));
    let openedSessionFile: string | undefined;
    let receivedPrompt = "";
    const sessionMessages: unknown[] = [];
    const runtime = {
      session: {
        sessionId: "session-old",
        sessionFile,
        messages: sessionMessages,
        subscribe() { return () => {}; },
        async prompt(text: string) {
          receivedPrompt = text;
          sessionMessages.push({ role: "assistant", content: [{ type: "text", text: "continued successfully" }], stopReason: "stop" });
        },
      },
      async dispose() {},
    };
    const piRuntime = {
      kind: "embedded-pi-sdk" as const,
      project: (alias: string) => setup.config.projects.get(toProjectAlias(alias))!,
      createSessionRuntime: async (request: { sessionFile?: string }) => {
        openedSessionFile = request.sessionFile;
        return runtime;
      },
    } as unknown as EmbeddedPiRuntimeBoundary;
    const service = new BridgeService(setup.config, {
      clickClack: setup.clickClack,
      piRuntime,
      logger: createLogger({ sink() {} }),
    });
    const binding = service.state.upsertBinding({
      conversationType: "channel",
      conversationId: "chn_1" as never,
      projectAlias: toProjectAlias("main"),
      invocationMode: "mention",
    });
    service.state.setActivePiSession({ bindingId: binding.id, sessionId: "session-old", sessionFile });
    service.state.archiveActivePiSession(binding.id);
    const source = message({ id: "msg_continue", body: "@bridge /continue", channelId: "chn_1" });
    setup.messages.set(source.id, source);

    await service.start();
    setup.emit(createdEvent({
      messageId: source.id,
      cursor: "cur_200",
      channelId: "chn_1",
      mentionedUserIds: ["usr_bot"],
    }));
    await service.waitForIdle();

    assert.equal(openedSessionFile, sessionFile);
    assert.match(receivedPrompt, /Continue from where the interrupted session left off/u);
    assert.deepEqual(setup.sent, [{ target: "channel", id: "chn_1", body: "continued successfully" }]);
    assert.equal(service.state.getActivePiSession(binding.id)?.sessionId, "session-old");
    service.stop();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("continue replaces the workflow watcher even when the restored session keeps its id", async () => {
  const root = mkdtempSync(join(tmpdir(), "pi-clickclack-rewatch-continue-"));
  try {
    const setup = fixture();
    const sessionFile = join(root, "session.jsonl");
    writeFileSync(sessionFile, JSON.stringify({ type: "session", id: "session-live", cwd: "/tmp/main" }));
    const runtime = (answer: string) => ({
      session: {
        sessionId: "session-live",
        sessionFile,
        sessionName: undefined as string | undefined,
        messages: [] as unknown[],
        subscribe() { return () => {}; },
        setSessionName(name: string) { this.sessionName = name; },
        async prompt() {
          this.messages.push({ role: "assistant", content: [{ type: "text", text: answer }], stopReason: "stop" });
        },
      },
      async dispose() {},
    });
    const runtimes = [runtime("unused"), runtime("continued")];
    const piRuntime = {
      kind: "embedded-pi-sdk" as const,
      project: (alias: string) => setup.config.projects.get(toProjectAlias(alias))!,
      createSessionRuntime: async () => runtimes.shift()!,
    } as unknown as EmbeddedPiRuntimeBoundary;
    const workflow = workflowClientRecorder();
    const application = createBridgeApplication(setup.config, {
      clickClack: setup.clickClack,
      piRuntime,
      logger: createLogger({ sink() {} }),
      workflowClientFactory: workflow.factory,
    });
    const service = application.service;
    const binding = service.state.upsertBinding({
      conversationType: "direct",
      conversationId: "dm_continue_rewatch" as never,
      projectAlias: toProjectAlias("main"),
      invocationMode: "auto",
    });
    service.state.setActivePiSession({ bindingId: binding.id, sessionId: "session-live", sessionFile });
    const establish = message({ id: "msg_establish", body: "/name active", directConversationId: "dm_continue_rewatch" });
    const resume = message({ id: "msg_rewatch_continue", body: "/continue", directConversationId: "dm_continue_rewatch" });
    setup.messages.set(establish.id, establish);
    setup.messages.set(resume.id, resume);

    await service.start();
    setup.emit(createdEvent({ messageId: establish.id, cursor: "cur_200" }));
    await service.waitForIdle();
    setup.emit(createdEvent({ messageId: resume.id, cursor: "cur_201" }));
    await service.waitForIdle();

    assert.deepEqual(workflow.watched, ["session-live", "session-live"]);
    assert.deepEqual(workflow.stopped, ["session-live"]);
    await application.stop();
    assert.deepEqual(workflow.stopped, ["session-live", "session-live"]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a missing active session file is archived and replaced automatically", async () => {
  const root = mkdtempSync(join(tmpdir(), "pi-clickclack-missing-session-"));
  try {
    const setup = fixture();
    const missingSessionFile = join(root, "missing.jsonl");
    const replacementSessionFile = join(root, "replacement.jsonl");
    const createRequests: Array<{ projectAlias: string; sessionFile?: string }> = [];
    const runtime = {
      session: {
        sessionId: "session-replacement",
        sessionFile: replacementSessionFile,
        sessionName: undefined as string | undefined,
        messages: [] as unknown[],
        subscribe() { return () => {}; },
        setSessionName(name: string) { this.sessionName = name; },
      },
      async dispose() {},
    };
    const piRuntime = {
      kind: "embedded-pi-sdk" as const,
      project: (alias: string) => setup.config.projects.get(toProjectAlias(alias))!,
      createSessionRuntime: async (request: { projectAlias: string; sessionFile?: string }) => {
        createRequests.push(request);
        if (request.sessionFile) throw new Error(`attempted to restore missing session ${request.sessionFile}`);
        return runtime;
      },
    } as unknown as EmbeddedPiRuntimeBoundary;
    const service = new BridgeService(setup.config, {
      clickClack: setup.clickClack,
      piRuntime,
      logger: createLogger({ sink() {} }),
    });
    const binding = service.state.upsertBinding({
      conversationType: "direct",
      conversationId: "dm_missing_session" as never,
      projectAlias: toProjectAlias("main"),
      invocationMode: "auto",
    });
    const stale = service.state.setActivePiSession({
      bindingId: binding.id,
      sessionId: "session-missing",
      sessionFile: missingSessionFile,
    });
    const source = message({
      id: "msg_missing_session",
      body: "/name recovered",
      directConversationId: "dm_missing_session",
    });
    setup.messages.set(source.id, source);

    await service.start();
    setup.emit(createdEvent({ messageId: source.id, cursor: "cur_200" }));
    await service.waitForIdle();

    assert.deepEqual(createRequests, [{ projectAlias: "main" }]);
    assert.equal(service.state.getActivePiSession(binding.id)?.sessionId, "session-replacement");
    assert.equal(service.state.listArchivedPiSessions(binding.id).some((candidate) => candidate.id === stale.id), true);
    assert.deepEqual(setup.sent, [{
      target: "direct",
      id: "dm_missing_session",
      body: "Pi session name set: recovered",
    }]);
    service.stop();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("project command switches projects, archives the old session, and unmentioned channel text stays ignored", async () => {
  const setup = fixture(["main", "other"]);
  const piRuntime = {
    kind: "embedded-pi-sdk" as const,
    project: (alias: string) => setup.config.projects.get(toProjectAlias(alias))!,
    createSessionRuntime: async () => { throw new Error("should not create a session"); },
  } as unknown as EmbeddedPiRuntimeBoundary;
  const service = new BridgeService(setup.config, {
    clickClack: setup.clickClack,
    piRuntime,
    logger: createLogger({ sink() {} }),
  });
  const command = message({ id: "msg_project", body: "/project other", channelId: "chn_2" });
  const ignored = message({ id: "msg_ignored", body: "hello", channelId: "chn_2" });
  setup.messages.set(command.id, command);
  setup.messages.set(ignored.id, ignored);

  await service.start();
  const previous = service.state.upsertBinding({
    conversationType: "channel",
    conversationId: "chn_2" as never,
    projectAlias: toProjectAlias("main"),
    invocationMode: "mention",
  });
  service.state.setActivePiSession({
    bindingId: previous.id,
    sessionId: "old-session",
    sessionFile: "/tmp/old-session.jsonl",
  });
  setup.emit(createdEvent({ messageId: command.id, cursor: "cur_200", channelId: "chn_2" }));
  setup.emit(createdEvent({ messageId: ignored.id, cursor: "cur_300", channelId: "chn_2" }));
  await service.waitForIdle();

  assert.equal(service.state.getBinding("channel", "chn_2" as never)?.projectAlias, "other");
  assert.equal(service.state.getActivePiSession(previous.id), undefined);
  assert.equal(setup.sent.length, 1);
  assert.match(setup.sent[0]?.body ?? "", /bound to `other`/u);
  service.stop();
});

test("project changes stop the old workflow watcher and bind the next project session", async () => {
  const setup = fixture(["main", "other"]);
  const runtime = (sessionId: string, answer: string) => ({
    session: {
      sessionId,
      sessionFile: `/tmp/${sessionId}.jsonl`,
      messages: [] as unknown[],
      subscribe() { return () => {}; },
      async prompt() {
        this.messages.push({ role: "assistant", content: [{ type: "text", text: answer }], stopReason: "stop" });
      },
    },
    async dispose() {},
  });
  const runtimes = [runtime("session-main", "main answer"), runtime("session-other", "other answer")];
  const piRuntime = {
    kind: "embedded-pi-sdk" as const,
    project: (alias: string) => setup.config.projects.get(toProjectAlias(alias))!,
    createSessionRuntime: async () => runtimes.shift()!,
  } as unknown as EmbeddedPiRuntimeBoundary;
  const workflow = workflowClientRecorder();
  const application = createBridgeApplication(setup.config, {
    clickClack: setup.clickClack,
    piRuntime,
    logger: createLogger({ sink() {} }),
    workflowClientFactory: workflow.factory,
  });
  const service = application.service;
  service.state.upsertBinding({
    conversationType: "channel",
    conversationId: "chn_project_rewatch" as never,
    projectAlias: toProjectAlias("main"),
    invocationMode: "mention",
  });
  const first = message({ id: "msg_main_turn", body: "@bridge first", channelId: "chn_project_rewatch" });
  const change = message({ id: "msg_change_project", body: "/project other", channelId: "chn_project_rewatch" });
  const second = message({ id: "msg_other_turn", body: "@bridge second", channelId: "chn_project_rewatch" });
  for (const source of [first, change, second]) setup.messages.set(source.id, source);

  await service.start();
  setup.emit(createdEvent({ messageId: first.id, cursor: "cur_200", channelId: "chn_project_rewatch", mentionedUserIds: ["usr_bot"] }));
  await service.waitForIdle();
  setup.emit(createdEvent({ messageId: change.id, cursor: "cur_201", channelId: "chn_project_rewatch" }));
  await service.waitForIdle();
  setup.emit(createdEvent({ messageId: second.id, cursor: "cur_202", channelId: "chn_project_rewatch", mentionedUserIds: ["usr_bot"] }));
  await service.waitForIdle();

  assert.deepEqual(workflow.watched, ["session-main", "session-other"]);
  assert.deepEqual(workflow.stopped, ["session-main"]);
  await application.stop();
  assert.deepEqual(workflow.stopped, ["session-main", "session-other"]);
});

test("Pi host commands compact, name, and replace the bound session without reaching the model", async () => {
  const setup = fixture();
  const compactInstructions: string[] = [];
  const createSession = (id: string) => ({
    sessionId: id,
    sessionFile: `/tmp/${id}.jsonl`,
    sessionName: undefined as string | undefined,
    messages: [] as unknown[],
    subscribe() { return () => {}; },
    async compact(instructions?: string) { compactInstructions.push(instructions ?? ""); return {}; },
    setSessionName(name: string) { this.sessionName = name.trim(); },
  });
  const runtime = {
    session: createSession("session-1"),
    async newSession() {
      this.session = createSession("session-2");
      return { cancelled: false };
    },
    async dispose() {},
  };
  const piRuntime = {
    kind: "embedded-pi-sdk" as const,
    project: (alias: string) => setup.config.projects.get(toProjectAlias(alias))!,
    createSessionRuntime: async () => runtime,
  } as unknown as EmbeddedPiRuntimeBoundary;
  const workflow = workflowClientRecorder({ hangWhenStopping: "session-1" });
  const application = createBridgeApplication(setup.config, {
    clickClack: setup.clickClack,
    piRuntime,
    logger: createLogger({ sink() {} }),
    workflowClientFactory: workflow.factory,
    workflowObservationStopTimeoutMs: 5,
    shutdownTimeoutMs: 5,
    forcedCleanupTimeoutMs: 5,
  });
  const service = application.service;
  service.state.upsertBinding({
    conversationType: "direct",
    conversationId: "dcn_1" as never,
    projectAlias: toProjectAlias("main"),
    invocationMode: "auto",
  });
  const commands = [
    message({ id: "msg_name", body: "/name command bridge", directConversationId: "dcn_1" }),
    message({ id: "msg_compact", body: "/compact keep command decisions", directConversationId: "dcn_1" }),
    message({ id: "msg_new", body: "/new", directConversationId: "dcn_1" }),
  ];
  for (const command of commands) setup.messages.set(command.id, command);

  await service.start();
  commands.forEach((command, index) => setup.emit(createdEvent({ messageId: command.id, cursor: `cur_${200 + index}` })));
  await service.waitForIdle();

  assert.deepEqual(compactInstructions, ["keep command decisions"]);
  assert.deepEqual(setup.sent.map((row) => row.body), [
    "Pi session name set: command bridge",
    "Pi session compacted.",
    "New Pi session started.",
  ]);
  assert.equal(service.state.getActivePiSession(1)?.sessionId, "session-2");
  assert.equal(service.state.listArchivedPiSessions(1)[0]?.sessionId, "session-1");
  assert.deepEqual(workflow.watched, ["session-1", "session-2"]);
  assert.deepEqual(workflow.stopped, ["session-1"]);
  assert.equal(await application.stop(), "timed_out");
  assert.deepEqual(workflow.stopped, ["session-1", "session-2"]);
});

test("extension slash commands wait for autonomous session work before opening their turn", async () => {
  const setup = fixture();
  const receivedPrompts: string[] = [];
  const lifecycle: string[] = [];
  let idle = false;
  let listener: ((event: unknown) => void) | undefined;
  const session = {
    sessionId: "session-1",
    sessionFile: "/tmp/session-1.jsonl",
    messages: [] as unknown[],
    get isIdle() { return idle; },
    promptTemplates: [] as Array<{ name: string }>,
    resourceLoader: { getSkills: () => ({ skills: [], diagnostics: [] }) },
    extensionRunner: {
      getCommand: (name: string) => name === "review" ? {} : undefined,
      getRegisteredCommands: () => [{ invocationName: "review", description: "Review project changes" }],
    },
    subscribe(next: (event: unknown) => void) {
      listener = next;
      return () => { listener = undefined; };
    },
    async waitForIdle() {
      lifecycle.push("wait");
      if (!idle) {
        listener?.({
          type: "tool_execution_start",
          toolCallId: "prior-tool",
          toolName: "read",
          args: { path: "/tmp/prior" },
        });
        this.messages.push({
          role: "assistant",
          content: [{ type: "text", text: "prior autonomous answer" }],
          stopReason: "stop",
        });
        idle = true;
      }
    },
    async prompt(text: string) {
      assert.equal(idle, true);
      lifecycle.push("prompt");
      receivedPrompts.push(text);
    },
  };
  const runtime = { session, async dispose() {} };
  const piRuntime = {
    kind: "embedded-pi-sdk" as const,
    project: (alias: string) => setup.config.projects.get(toProjectAlias(alias))!,
    createSessionRuntime: async () => runtime,
  } as unknown as EmbeddedPiRuntimeBoundary;
  const service = new BridgeService(setup.config, {
    clickClack: setup.clickClack,
    piRuntime,
    logger: createLogger({ sink() {} }),
  });
  service.state.upsertBinding({
    conversationType: "direct",
    conversationId: "dcn_1" as never,
    projectAlias: toProjectAlias("main"),
    invocationMode: "auto",
  });
  const review = message({ id: "msg_review", body: "/review src/service.ts", directConversationId: "dcn_1" });
  const unknown = message({ id: "msg_unknown", body: "/not-a-command", directConversationId: "dcn_1" });
  setup.messages.set(review.id, review);
  setup.messages.set(unknown.id, unknown);

  await service.start();
  setup.emit(createdEvent({ messageId: review.id, cursor: "cur_200" }));
  setup.emit(createdEvent({ messageId: unknown.id, cursor: "cur_300" }));
  await service.waitForIdle();

  assert.deepEqual(receivedPrompts, ["/review src/service.ts"]);
  assert.deepEqual(lifecycle, ["wait", "prompt", "wait"]);
  assert.deepEqual(setup.activity, []);
  assert.ok(setup.commandMenu.some((command) => command.command === "review"));
  assert.deepEqual(setup.sent.map((row) => row.body), [
    "Pi command `/review` completed.",
    "unknown Pi command `/not-a-command`.",
  ]);
  service.stop();
});

test("extension session replacement delivers the replacement session answer", async () => {
  const setup = fixture();
  type ReplacementOptions = {
    withSession?: (context: { sendUserMessage(text: string): Promise<void> }) => Promise<void>;
  };
  type ExtensionBinding = {
    commandContextActions: {
      newSession(options?: ReplacementOptions): Promise<{ cancelled: boolean }>;
    };
  };

  const bindings = new Map<string, ExtensionBinding>();
  let runReplacement: (() => Promise<void>) | undefined;
  const createSession = (id: string, messages: unknown[]) => ({
    sessionId: id,
    sessionFile: `/tmp/${id}.jsonl`,
    messages,
    promptTemplates: [] as Array<{ name: string }>,
    resourceLoader: { getSkills: () => ({ skills: [], diagnostics: [] }) },
    extensionRunner: {
      getCommand: (name: string) => name === "review" ? {} : undefined,
      getRegisteredCommands: () => [{ invocationName: "review", description: "Review project changes" }],
    },
    async bindExtensions(binding: ExtensionBinding) { bindings.set(id, binding); },
    subscribe() { return () => {}; },
    async waitForIdle() {},
    async prompt() { await runReplacement?.(); },
  });
  type TestSession = ReturnType<typeof createSession>;
  let rebindSession: ((session: TestSession) => Promise<void>) | undefined;
  const runtime = {
    session: createSession("session-1", Array.from({ length: 4 }, () => ({
      role: "assistant",
      content: [{ type: "text", text: "old answer" }],
    }))),
    setRebindSession(callback: (session: TestSession) => Promise<void>) { rebindSession = callback; },
    async newSession(options?: ReplacementOptions) {
      this.session = createSession("session-2", []);
      await rebindSession?.(this.session);
      await options?.withSession?.({
        sendUserMessage: async () => {
          this.session.messages.push({
            role: "assistant",
            content: [{ type: "text", text: "replacement answer" }],
          });
        },
      });
      return { cancelled: false };
    },
    async dispose() {},
  };
  runReplacement = async () => {
    await bindings.get("session-1")?.commandContextActions.newSession({
      withSession: async (context) => context.sendUserMessage("continue in replacement"),
    });
  };
  const piRuntime = {
    kind: "embedded-pi-sdk" as const,
    project: (alias: string) => setup.config.projects.get(toProjectAlias(alias))!,
    createSessionRuntime: async () => runtime,
  } as unknown as EmbeddedPiRuntimeBoundary;
  const workflow = workflowClientRecorder();
  const application = createBridgeApplication(setup.config, {
    clickClack: setup.clickClack,
    piRuntime,
    logger: createLogger({ sink() {} }),
    workflowClientFactory: workflow.factory,
  });
  const service = application.service;
  service.state.upsertBinding({
    conversationType: "direct",
    conversationId: "dcn_1" as never,
    projectAlias: toProjectAlias("main"),
    invocationMode: "auto",
  });
  const review = message({ id: "msg_review_replace", body: "/review", directConversationId: "dcn_1" });
  setup.messages.set(review.id, review);

  await service.start();
  setup.emit(createdEvent({ messageId: review.id, cursor: "cur_200" }));
  await service.waitForIdle();

  assert.deepEqual(setup.sent.map((row) => row.body), ["replacement answer"]);
  assert.equal(service.state.getActivePiSession(1)?.sessionId, "session-2");
  assert.deepEqual(workflow.watched, ["session-1", "session-2"]);
  assert.deepEqual(workflow.stopped, ["session-1"]);
  await application.stop();
  assert.deepEqual(workflow.stopped, ["session-1", "session-2"]);
});

test("a slow turn in one conversation does not block a turn in another", async () => {
  const setup = fixture();
  const started: string[] = [];
  const finished: string[] = [];
  let releaseSlow: (() => void) | undefined;
  const slowGate = new Promise<void>((resolve) => { releaseSlow = resolve; });
  const runtimeFor = (label: string) => ({
    session: {
      sessionId: `session-${label}`,
      sessionFile: `/tmp/session-${label}.jsonl`,
      messages: [] as unknown[],
      subscribe() { return () => {}; },
      async prompt() {
        started.push(label);
        if (label === "slow") await slowGate;
        this.messages.push({ role: "assistant", content: [{ type: "text", text: `${label} answer` }], stopReason: "stop" });
        finished.push(label);
      },
    },
    async dispose() {},
  });
  // Runtimes are created in the order the two conversations are dispatched:
  // the slow channel message first, then the fast direct message.
  const pending = [runtimeFor("slow"), runtimeFor("fast")];
  const piRuntime = {
    kind: "embedded-pi-sdk" as const,
    project: (alias: string) => setup.config.projects.get(toProjectAlias(alias))!,
    createSessionRuntime: async () => pending.shift()!,
  } as unknown as EmbeddedPiRuntimeBoundary;
  const service = new BridgeService(setup.config, {
    clickClack: setup.clickClack,
    piRuntime,
    logger: createLogger({ sink() {} }),
  });
  service.state.upsertBinding({
    conversationType: "channel",
    conversationId: "chn_slow" as never,
    projectAlias: toProjectAlias("main"),
    invocationMode: "always",
  });
  service.state.upsertBinding({
    conversationType: "direct",
    conversationId: "dm_fast" as never,
    projectAlias: toProjectAlias("main"),
    invocationMode: "auto",
  });
  const slow = message({ id: "msg_slow", body: "long job", channelId: "chn_slow" });
  const fast = message({ id: "msg_fast", body: "quick question", directConversationId: "dm_fast" });
  setup.messages.set(slow.id, slow);
  setup.messages.set(fast.id, fast);

  await service.start();
  setup.emit(createdEvent({ messageId: slow.id, cursor: "cur_200", channelId: "chn_slow" }));
  setup.emit(createdEvent({ messageId: fast.id, cursor: "cur_201" }));

  // The fast conversation must complete while the slow one is still blocked.
  for (let attempt = 0; attempt < 200 && !finished.includes("fast"); attempt += 1) {
    await new Promise((resolve) => setImmediate(resolve));
  }
  assert.deepEqual(finished, ["fast"]);
  assert.deepEqual(started.toSorted(), ["fast", "slow"]);

  releaseSlow?.();
  await service.waitForIdle();
  assert.deepEqual(finished.toSorted(), ["fast", "slow"]);
  assert.deepEqual(
    setup.sent.toSorted((left, right) => left.id.localeCompare(right.id)),
    [
      { target: "channel", id: "chn_slow", body: "slow answer" },
      { target: "direct", id: "dm_fast", body: "fast answer" },
    ],
  );
  service.stop();
});

test("two messages in one conversation run in order, not concurrently", async () => {
  const setup = fixture();
  const events: string[] = [];
  let active = 0;
  const runtime = {
    session: {
      sessionId: "session-serial",
      sessionFile: "/tmp/session-serial.jsonl",
      messages: [] as unknown[],
      subscribe() { return () => {}; },
      async prompt(text: string) {
        active += 1;
        assert.equal(active, 1, "two turns overlapped in one conversation");
        events.push(`start:${text}`);
        await new Promise((resolve) => setImmediate(resolve));
        this.messages.push({ role: "assistant", content: [{ type: "text", text: `answered ${text}` }], stopReason: "stop" });
        events.push(`end:${text}`);
        active -= 1;
      },
    },
    async dispose() {},
  };
  const piRuntime = {
    kind: "embedded-pi-sdk" as const,
    project: (alias: string) => setup.config.projects.get(toProjectAlias(alias))!,
    createSessionRuntime: async () => runtime,
  } as unknown as EmbeddedPiRuntimeBoundary;
  const service = new BridgeService(setup.config, {
    clickClack: setup.clickClack,
    piRuntime,
    logger: createLogger({ sink() {} }),
  });
  service.state.upsertBinding({
    conversationType: "direct",
    conversationId: "dm_serial" as never,
    projectAlias: toProjectAlias("main"),
    invocationMode: "auto",
  });
  const first = message({ id: "msg_first", body: "first", directConversationId: "dm_serial" });
  const second = message({ id: "msg_second", body: "second", directConversationId: "dm_serial" });
  setup.messages.set(first.id, first);
  setup.messages.set(second.id, second);

  await service.start();
  setup.emit(createdEvent({ messageId: first.id, cursor: "cur_200" }));
  setup.emit(createdEvent({ messageId: second.id, cursor: "cur_201" }));
  await service.waitForIdle();

  assert.deepEqual(events, ["start:first", "end:first", "start:second", "end:second"]);
  service.stop();
});

test("the invoke command switches a channel to always-on and survives a rebind", async () => {
  const setup = fixture(["main", "other"]);
  const piRuntime = {
    kind: "embedded-pi-sdk" as const,
    project: (alias: string) => setup.config.projects.get(toProjectAlias(alias))!,
    createSessionRuntime: async () => { throw new Error("should not create a session"); },
  } as unknown as EmbeddedPiRuntimeBoundary;
  const service = new BridgeService(setup.config, {
    clickClack: setup.clickClack,
    piRuntime,
    logger: createLogger({ sink() {} }),
  });
  const enable = message({ id: "msg_invoke", body: "/invoke always", channelId: "chn_2" });
  const unmentioned = message({ id: "msg_plain", body: "no mention here", channelId: "chn_2" });
  const rebind = message({ id: "msg_rebind", body: "/project other", channelId: "chn_2" });
  for (const item of [enable, unmentioned, rebind]) setup.messages.set(item.id, item);

  await service.start();
  service.state.upsertBinding({
    conversationType: "channel",
    conversationId: "chn_2" as never,
    projectAlias: toProjectAlias("main"),
    invocationMode: "mention",
  });

  setup.emit(createdEvent({ messageId: enable.id, cursor: "cur_200", channelId: "chn_2", mentionedUserIds: ["usr_bot"] }));
  await service.waitForIdle();
  assert.equal(service.state.getBinding("channel", "chn_2" as never)?.invocationMode, "always");
  assert.match(setup.sent[0]?.body ?? "", /invocation set to `always`/u);

  // An unmentioned message now reaches Pi, which is the whole point.
  setup.emit(createdEvent({ messageId: unmentioned.id, cursor: "cur_300", channelId: "chn_2" }));
  await service.waitForIdle();

  // Rebinding the project must not silently revert the operator's choice.
  setup.emit(createdEvent({ messageId: rebind.id, cursor: "cur_400", channelId: "chn_2" }));
  await service.waitForIdle();
  assert.equal(service.state.getBinding("channel", "chn_2" as never)?.invocationMode, "always");
  service.stop();
});

test("invoke reports the current mode and refuses an unknown one", async () => {
  const setup = fixture(["main"]);
  const piRuntime = {
    kind: "embedded-pi-sdk" as const,
    project: (alias: string) => setup.config.projects.get(toProjectAlias(alias))!,
    createSessionRuntime: async () => { throw new Error("should not create a session"); },
  } as unknown as EmbeddedPiRuntimeBoundary;
  const service = new BridgeService(setup.config, {
    clickClack: setup.clickClack,
    piRuntime,
    logger: createLogger({ sink() {} }),
  });
  const show = message({ id: "msg_show", body: "/invoke", channelId: "chn_2" });
  const bogus = message({ id: "msg_bogus", body: "/invoke sometimes", channelId: "chn_2" });
  for (const item of [show, bogus]) setup.messages.set(item.id, item);

  await service.start();
  service.state.upsertBinding({
    conversationType: "channel",
    conversationId: "chn_2" as never,
    projectAlias: toProjectAlias("main"),
    invocationMode: "mention",
  });

  setup.emit(createdEvent({ messageId: show.id, cursor: "cur_200", channelId: "chn_2", mentionedUserIds: ["usr_bot"] }));
  setup.emit(createdEvent({ messageId: bogus.id, cursor: "cur_300", channelId: "chn_2", mentionedUserIds: ["usr_bot"] }));
  await service.waitForIdle();

  assert.match(setup.sent[0]?.body ?? "", /invocation: `mention`/u);
  assert.match(setup.sent[1]?.body ?? "", /usage: `\/invoke \[mention\|always\]`/u);
  assert.equal(service.state.getBinding("channel", "chn_2" as never)?.invocationMode, "mention");
  service.stop();
});

test("authorized bound watcher feeds durable snapshots to its frozen conversation without changing chat replies", async () => {
  const { fixture: snapshotFixture } = await import("./workflow-snapshot-fixture.test-helper.js");
  const setup = fixture(); const host = snapshotFixture();
  const requests: import("@clickclack/sdk-ts").PublishWorkflowSnapshotRequest[] = [];
  setup.clickClack.workflowRuns = {
    publish: async input => {
      requests.push(input);
      return { changed: true, record: { ...input, id: "record", producer_id: "usr_bot", updated_at: "2026-09-01T00:00:00Z" } };
    },
    listChannel: async () => ({ runs: [] }), listDirect: async () => ({ runs: [] }),
  };
  const messages: unknown[] = [];
  const runtime = { session: { sessionId: "session", sessionFile: "/tmp/fixture-session.jsonl", messages,
    subscribe: () => () => undefined,
    prompt: async () => { messages.push({ role: "assistant", content: [{ type: "text", text: "normal reply" }], stopReason: "stop" }); },
  }, dispose: async () => undefined };
  const application = createBridgeApplication(setup.config, {
    clickClack: setup.clickClack, logger: createLogger({ sink() {} }),
    piRuntime: { kind: "embedded-pi-sdk", project: (alias: string) => setup.config.projects.get(toProjectAlias(alias))!,
      createSessionRuntime: async () => runtime } as unknown as EmbeddedPiRuntimeBoundary,
    workflowClientFactory: () => ({ ...host.client, hostIdentity: "fixture-host", close: async () => undefined,
      watchSession: async (sessionId, listener) => {
        assert.equal(sessionId, "session");
        listener({ view: { schema: "pi-workflows.session-view.v1", sessionId, run: host.view, pendingInteractions: [] } });
        return async () => undefined;
      },
    }),
  });
  try {
    const source = message({ id: "msg_durable", body: "@bridge hello", channelId: "chn_durable" });
    setup.messages.set(source.id, source); await application.service.start();
    setup.emit(createdEvent({ messageId: source.id, cursor: "cur_durable", channelId: "chn_durable", mentionedUserIds: ["usr_bot"] }));
    await application.service.waitForIdle();
    assert.deepEqual(setup.sent, [{ target: "channel", id: "chn_durable", body: "normal reply" }]);
    assert.equal(application.service.state.database.prepare("SELECT count(*) AS n FROM workflow_publications").get()!.n, 1);
    const deadline = Date.now() + 5000;
    while (!requests.length && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 20));
    assert.equal(requests.length, 1); assert.equal(requests[0]!.channel_id, "chn_durable");
    assert.equal(requests[0]!.snapshot.source.sessionId, "session");
  } finally { assert.equal(await application.stop(), "completed"); }
});
