import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import type { Message, MessageInput, RealtimeEvent } from "@clickclack/sdk-ts";

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
