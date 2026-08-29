import assert from "node:assert/strict";
import test from "node:test";

import { TurnActivity, type ActivityTransport } from "./activity.js";

function fixture() {
  const created: Array<{ kind: string; body: string; turnId: string }> = [];
  const updated: Array<{ messageId: string; body: string }> = [];
  const transport: ActivityTransport = {
    async create(kind, body, turnId) {
      created.push({ kind, body, turnId });
      return { id: `msg_${created.length}` };
    },
    async update(messageId, body) {
      updated.push({ messageId, body });
    },
  };
  const activity = new TurnActivity({
    turnId: "turn_1",
    source: { channel_id: "chn_1" },
    transport,
    flushMs: 0,
  });
  return { activity, created, updated };
}

test("publishes pre-tool prose and tools as durable ClickClack activity", async () => {
  const { activity, created } = fixture();

  activity.handle({ type: "message_start", message: { role: "assistant", content: [] } });
  activity.handle({
    type: "message_update",
    assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "I'll inspect the file." },
  });
  activity.handle({
    type: "message_end",
    message: { role: "assistant", content: [{ type: "text", text: "I'll inspect the file." }] },
  });
  activity.handle({
    type: "tool_execution_start",
    toolCallId: "tool_1",
    toolName: "read",
    args: { path: "/repo/src/service.ts" },
  });
  activity.handle({
    type: "tool_execution_end",
    toolCallId: "tool_1",
    toolName: "read",
    isError: false,
  });
  await activity.finalize();

  assert.deepEqual(created, [
    { kind: "agent_commentary", body: "I'll inspect the file.", turnId: "turn_1" },
    { kind: "agent_tool", body: "**read**\n\n/repo/src/service.ts", turnId: "turn_1" },
  ]);
});

test("keeps the final assistant answer out of the activity preamble", async () => {
  const { activity, created } = fixture();

  activity.handle({ type: "message_start", message: { role: "assistant", content: [] } });
  activity.handle({
    type: "message_update",
    assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "finished." },
  });
  activity.handle({
    type: "message_end",
    message: { role: "assistant", content: [{ type: "text", text: "finished." }] },
  });
  await activity.finalize();

  assert.deepEqual(created, []);
});

test("coalesces thinking snapshots into one durable commentary row", async () => {
  const { activity, created, updated } = fixture();

  activity.handle({ type: "message_start", message: { role: "assistant", content: [] } });
  activity.handle({
    type: "message_update",
    assistantMessageEvent: { type: "thinking_delta", contentIndex: 0, delta: "Checking " },
  });
  await activity.finalize();
  activity.handle({
    type: "message_update",
    assistantMessageEvent: { type: "thinking_end", contentIndex: 0, content: "Checking the runtime" },
  });
  await activity.finalize();

  assert.deepEqual(created, [
    { kind: "agent_commentary", body: "**Thinking**\n\nChecking", turnId: "turn_1" },
  ]);
  assert.deepEqual(updated, [
    { messageId: "msg_1", body: "**Thinking**\n\nChecking the runtime" },
  ]);
});

test("marks failed tool rows without duplicating them", async () => {
  const { activity, created, updated } = fixture();

  activity.handle({
    type: "tool_execution_start",
    toolCallId: "tool_1",
    toolName: "bash",
    args: { command: "pnpm test" },
  });
  await activity.finalize();
  activity.handle({
    type: "tool_execution_end",
    toolCallId: "tool_1",
    toolName: "bash",
    isError: true,
  });
  await activity.finalize();

  assert.equal(created.length, 1);
  assert.deepEqual(updated, [
    { messageId: "msg_1", body: "**bash**\n\npnpm test\n\nfailed" },
  ]);
});

test("hides a redundant pinned-project cd prefix from shell activity", async () => {
  const created: Array<{ body: string }> = [];
  const activity = new TurnActivity({
    turnId: "turn_1",
    source: { channel_id: "chn_1" },
    projectCwd: "/home/kas/dev/clickclack",
    transport: {
      async create(_kind, body) { created.push({ body }); return { id: "msg_1" }; },
      async update() {},
    },
  });

  activity.handle({
    type: "tool_execution_start",
    toolCallId: "tool_1",
    toolName: "bash",
    args: { command: "cd /home/kas/dev/clickclack && sed -n '1,80p' apps/web/src/App.svelte" },
  });
  await activity.finalize();

  assert.deepEqual(created, [{ body: "**bash**\n\nsed -n '1,80p' apps/web/src/App.svelte" }]);
});

test("reports activity transport failures without failing the Pi turn", async () => {
  const errors: unknown[] = [];
  const activity = new TurnActivity({
    turnId: "turn_1",
    source: { direct_conversation_id: "dcn_1" },
    transport: {
      async create() { throw new Error("scope denied"); },
      async update() {},
    },
    onError: (error) => errors.push(error),
    flushMs: 0,
  });

  activity.handle({
    type: "tool_execution_start",
    toolCallId: "tool_1",
    toolName: "read",
    args: {},
  });
  await activity.finalize();

  assert.equal(errors.length, 1);
});
