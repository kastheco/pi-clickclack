import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import type { BotCommandInput, Message, MessageInput, RealtimeEvent } from "@clickclack/sdk-ts";

import type { ClickClackBoundary } from "./clickclack.js";
import type { BridgeConfig, ProjectConfig } from "./config.js";
import { createLogger } from "./logger.js";
import type { EmbeddedPiRuntimeBoundary } from "./pi-runtime.js";
import { BridgeService } from "./service.js";
import { StateStore } from "./state/store.js";
import { toProjectAlias } from "./types.js";

type EventHandler = (event: RealtimeEvent) => void;

type Fixture = {
  config: BridgeConfig;
  clickClack: ClickClackBoundary;
  messages: Map<string, Message>;
  sent: Array<{ target: "channel" | "direct"; id: string; body: string }>;
  activity: Array<{ target: "channel" | "direct"; id: string; body: string; kind: string; turnId?: string }>;
  commandMenu: BotCommandInput[];
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
    ["project", "continue", "compact", "new", "name", "session", "model", "thinking", "reload", "copy"],
  );
  assert.match(lines.join("\n"), /"sessionsStarted":0/u);
  service.stop();
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
  const service = new BridgeService(setup.config, {
    clickClack: setup.clickClack,
    piRuntime,
    logger: createLogger({ sink() {} }),
  });
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
  service.stop();
});

test("extension slash commands pass through AgentSession.prompt and unknown commands do not", async () => {
  const setup = fixture();
  const receivedPrompts: string[] = [];
  const session = {
    sessionId: "session-1",
    sessionFile: "/tmp/session-1.jsonl",
    messages: [] as unknown[],
    promptTemplates: [] as Array<{ name: string }>,
    resourceLoader: { getSkills: () => ({ skills: [], diagnostics: [] }) },
    extensionRunner: {
      getCommand: (name: string) => name === "review" ? {} : undefined,
      getRegisteredCommands: () => [{ invocationName: "review", description: "Review project changes" }],
    },
    subscribe() { return () => {}; },
    async prompt(text: string) { receivedPrompts.push(text); },
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
  const review = message({ id: "msg_review_replace", body: "/review", directConversationId: "dcn_1" });
  setup.messages.set(review.id, review);

  await service.start();
  setup.emit(createdEvent({ messageId: review.id, cursor: "cur_200" }));
  await service.waitForIdle();

  assert.deepEqual(setup.sent.map((row) => row.body), ["replacement answer"]);
  assert.equal(service.state.getActivePiSession(1)?.sessionId, "session-2");
  service.stop();
});
