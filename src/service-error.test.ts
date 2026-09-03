import assert from "node:assert/strict";
import test from "node:test";

import type { Message, RealtimeEvent } from "@clickclack/sdk-ts";

import type { ClickClackBoundary } from "./clickclack.js";
import type { BridgeConfig } from "./config.js";
import { createLogger } from "./logger.js";
import type { EmbeddedPiRuntimeBoundary } from "./pi-runtime.js";
import { BridgeService } from "./service.js";
import { toProjectAlias } from "./types.js";

test("does not reuse an earlier assistant message when the current Pi turn fails", async () => {
  const alias = toProjectAlias("main");
  const config: BridgeConfig = {
    clickClack: {
      baseUrl: "https://clickclack.example.test",
      workspaceId: "wsp_test",
      botToken: "ccb_secret",
      ownerIds: ["usr_owner"],
    },
    projects: new Map([[alias, { alias, cwd: "/tmp" }]]),
    invocationBindings: [],
    pi: { model: "provider/model", thinkingLevel: "medium", agentDir: "/tmp" },
    statePath: ":memory:",
  };
  const source: Message = {
    id: "msg_failed",
    workspace_id: "wsp_test",
    direct_conversation_id: "dm_test",
    author_id: "usr_owner",
    thread_root_id: "msg_failed",
    body: "do the task",
    body_format: "markdown",
    created_at: "2026-01-01T00:00:00Z",
    kind: "message",
  };
  const sent: string[] = [];
  let onEvent: ((event: RealtimeEvent) => void) | undefined;
  const clickClack = {
    me: async () => ({ id: "usr_bot", kind: "bot", display_name: "Bridge", handle: "bridge", avatar_url: "", created_at: "" }),
    workspaces: { get: async () => ({ id: "wsp_test", route_id: "W1", name: "Test", slug: "test", icon_url: "", created_at: "" }) },
    bots: { setCommands: async () => [] },
    messages: { get: async () => source },
    channels: { sendMessage: async () => ({}) },
    dms: { sendMessage: async (_id: string, input: { body: string }) => { sent.push(input.body); return {}; } },
    events: {
      list: async () => ({ events: [], tailCursor: "cur_100" }),
      subscribe: (options: { onEvent: (event: RealtimeEvent) => void }) => { onEvent = options.onEvent; return { close() {} }; },
    },
  } as unknown as ClickClackBoundary;
  const messages: unknown[] = [{ role: "assistant", content: [{ type: "text", text: "stale response" }], stopReason: "stop" }];
  let listener: ((event: unknown) => void) | undefined;
  const runtime = {
    session: {
      sessionId: "session-failed",
      sessionFile: "/tmp/session-failed.jsonl",
      messages,
      subscribe(next: (event: unknown) => void) { listener = next; return () => { listener = undefined; }; },
      async prompt() {
        const failed = { role: "assistant", content: [], stopReason: "error", errorMessage: "provider rejected the transcript" };
        listener?.({ type: "message_end", message: failed });
        messages.push(failed);
      },
    },
    async dispose() {},
  };
  const piRuntime = {
    kind: "embedded-pi-sdk",
    project: () => ({ alias, cwd: "/tmp" }),
    createSessionRuntime: async () => runtime,
  } as unknown as EmbeddedPiRuntimeBoundary;
  const service = new BridgeService(config, { clickClack, piRuntime, logger: createLogger({ sink() {} }) });

  await service.start();
  onEvent?.({
    id: "evt_failed",
    cursor: "cur_200",
    type: "message.created",
    workspace_id: "wsp_test",
    created_at: "",
    payload: { message_id: source.id, author_id: source.author_id },
  });
  await service.waitForIdle();

  assert.deepEqual(sent, ["pi couldn't complete that turn. check the bridge log for the error."]);
  assert.doesNotMatch(sent[0] ?? "", /stale response/u);
  service.stop();
});

test("quarantines an empty Pi session so the next message gets a fresh runtime", async () => {
  const alias = toProjectAlias("main");
  const config: BridgeConfig = {
    clickClack: {
      baseUrl: "https://clickclack.example.test",
      workspaceId: "wsp_test",
      botToken: "ccb_secret",
      ownerIds: ["usr_owner"],
    },
    projects: new Map([[alias, { alias, cwd: "/tmp" }]]),
    invocationBindings: [],
    pi: { model: "provider/model", thinkingLevel: "medium", agentDir: "/tmp" },
    statePath: ":memory:",
  };
  const sources = new Map<string, Message>([
    [
      "msg_empty",
      {
        id: "msg_empty",
        workspace_id: "wsp_test",
        direct_conversation_id: "dm_test",
        author_id: "usr_owner",
        thread_root_id: "msg_empty",
        body: "first attempt",
        body_format: "markdown",
        created_at: "2026-01-01T00:00:00Z",
        kind: "message",
      },
    ],
    [
      "msg_fresh",
      {
        id: "msg_fresh",
        workspace_id: "wsp_test",
        direct_conversation_id: "dm_test",
        author_id: "usr_owner",
        thread_root_id: "msg_fresh",
        body: "second attempt",
        body_format: "markdown",
        created_at: "2026-01-01T00:00:01Z",
        kind: "message",
      },
    ],
  ]);
  const sent: string[] = [];
  let onEvent: ((event: RealtimeEvent) => void) | undefined;
  const clickClack = {
    me: async () => ({ id: "usr_bot", kind: "bot", display_name: "Bridge", handle: "bridge", avatar_url: "", created_at: "" }),
    workspaces: { get: async () => ({ id: "wsp_test", route_id: "W1", name: "Test", slug: "test", icon_url: "", created_at: "" }) },
    bots: { setCommands: async () => [] },
    messages: { get: async (id: string) => sources.get(id) },
    channels: { sendMessage: async () => ({}) },
    dms: { sendMessage: async (_id: string, input: { body: string }) => { sent.push(input.body); return {}; } },
    events: {
      list: async () => ({ events: [], tailCursor: "cur_100" }),
      subscribe: (options: { onEvent: (event: RealtimeEvent) => void }) => { onEvent = options.onEvent; return { close() {} }; },
    },
  } as unknown as ClickClackBoundary;
  let created = 0;
  let disposed = 0;
  const piRuntime = {
    kind: "embedded-pi-sdk",
    project: () => ({ alias, cwd: "/tmp" }),
    createSessionRuntime: async () => {
      created += 1;
      const messages: unknown[] = [];
      const empty = created === 1;
      return {
        session: {
          sessionId: empty ? "session-empty" : "session-fresh",
          sessionFile: empty ? "/tmp/session-empty.jsonl" : "/tmp/session-fresh.jsonl",
          messages,
          subscribe() { return () => {}; },
          async prompt() {
            messages.push(
              empty
                ? { role: "assistant", content: [], stopReason: "stop", usage: { totalTokens: 0 } }
                : { role: "assistant", content: [{ type: "text", text: "fresh answer" }], stopReason: "stop" },
            );
          },
        },
        async dispose() { disposed += 1; },
      };
    },
  } as unknown as EmbeddedPiRuntimeBoundary;
  const service = new BridgeService(config, {
    clickClack,
    piRuntime,
    logger: createLogger({ sink() {} }),
  });

  await service.start();
  onEvent?.(messageEvent("evt_empty", "cur_200", "msg_empty"));
  await service.waitForIdle();
  onEvent?.(messageEvent("evt_fresh", "cur_201", "msg_fresh"));
  await service.waitForIdle();

  assert.deepEqual(sent, [
    "pi's session stopped responding, so it was reset. send that again.",
    "fresh answer",
  ]);
  assert.equal(created, 2);
  assert.equal(disposed, 1);
  service.stop();
});

function messageEvent(id: string, cursor: string, messageId: string): RealtimeEvent {
  return {
    id,
    cursor,
    type: "message.created",
    workspace_id: "wsp_test",
    created_at: "",
    payload: { message_id: messageId, author_id: "usr_owner" },
  };
}
