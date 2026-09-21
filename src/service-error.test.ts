import assert from "node:assert/strict";
import test from "node:test";

import type { Message, RealtimeEvent } from "@clickclack/sdk-ts";

import type { ClickClackBoundary } from "./clickclack.js";
import type { BridgeConfig } from "./config.js";
import { createLogger } from "./logger.js";
import type { EmbeddedPiRuntimeBoundary } from "./pi-runtime.js";
import { BridgeService } from "./service.js";
import { toProjectAlias } from "./types.js";

for (const failure of ["message", "throw", "command"] as const) {
test(`publishes the current Pi ${failure} error without reusing an earlier answer`, async () => {
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
    body: failure === "command" ? "/compact" : "do the task",
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
    messages: { findByNonce: async () => undefined, get: async () => source },
    channels: { list: async () => [], sendMessage: async () => ({ id: "msg_channel" }) },
    dms: { sendMessage: async (_id: string, input: { body: string }) => { sent.push(input.body); return { id: `msg_sent_${sent.length}` }; } },
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
      async compact() { throw new Error("provider rejected the transcript ccb_secret"); },
      async prompt() {
        if (failure === "throw") throw new Error("provider rejected the transcript ccb_secret");
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

  assert.equal(sent.length, 1);
  assert.match(sent[0] ?? "", /provider rejected the transcript/u);
  assert.match(sent[0] ?? "", failure === "command" ? /reference: msg_failed/u : /reference: turn_/u);
  assert.doesNotMatch(sent[0] ?? "", /stale response|ccb_secret/u);
  service.stop();
});
}

for (const scenario of ["empty", "compact-before-answer", "compact-after-answer", "compact-error", "compact-empty"] as const) {
test(`turn recovery handles ${scenario} without losing current work`, async () => {
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
    messages: { findByNonce: async () => undefined, get: async (id: string) => sources.get(id) },
    channels: { list: async () => [], sendMessage: async () => ({ id: "msg_channel" }) },
    dms: { sendMessage: async (_id: string, input: { body: string }) => { sent.push(input.body); return { id: `msg_sent_${sent.length}` }; } },
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
      const messages: unknown[] = scenario === "empty" ? [] : Array.from({ length: 20 }, () => ({
        role: "assistant", content: [{ type: "text", text: "stale work" }], stopReason: "stop",
      }));
      const empty = created === 1;
      let calls = 0;
      let listener: ((event: unknown) => void) | undefined;
      return {
        session: {
          sessionId: empty ? "session-empty" : "session-fresh",
          sessionFile: empty ? "/tmp/session-empty.jsonl" : "/tmp/session-fresh.jsonl",
          messages,
          subscribe(next: (event: unknown) => void) { listener = next; return () => { listener = undefined; }; },
          async prompt() {
            calls += 1;
            if (scenario !== "empty" && empty && calls === 1) {
              const compact = () => messages.splice(0, messages.length, {
                role: "compactionSummary", summary: "current work, not stale work",
              });
              if (scenario !== "compact-after-answer") compact();
              const answer = {
                role: "assistant",
                content: scenario === "compact-empty" || scenario === "compact-error"
                  ? [] : [{ type: "text", text: "current answer" }],
                stopReason: scenario === "compact-error" ? "error" : "stop",
                ...(scenario === "compact-error" ? { errorMessage: "provider failed after compaction" } : {}),
              };
              messages.push(answer);
              listener?.({ type: "message_end", message: answer });
              if (scenario === "compact-after-answer") compact();
              return;
            }
            const answer = empty && scenario === "empty"
              ? { role: "assistant", content: [], stopReason: "stop", usage: { totalTokens: 0 } }
              : { role: "assistant", content: [{ type: "text", text: "fresh answer" }], stopReason: "stop" };
            messages.push(answer);
            listener?.({ type: "message_end", message: answer });
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

  if (scenario === "empty" || scenario === "compact-empty") {
    assert.match(sent[0] ?? "", /session stopped responding/u);
    assert.equal(created, 2);
    assert.equal(disposed, 1);
  } else {
    if (scenario === "compact-error") assert.match(sent[0] ?? "", /provider failed after compaction/u);
    else assert.equal(sent[0], "current answer");
    assert.equal(created, 1, "compaction must not archive the current session");
    assert.equal(disposed, 0);
    assert.equal(sent[1], "fresh answer");
  }
  assert.equal(sent.length, 2);
  assert.doesNotMatch(sent.join("\n"), /stale work/u);
  service.stop();
});
}

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
