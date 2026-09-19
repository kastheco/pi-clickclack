import assert from "node:assert/strict";
import test from "node:test";

import { TurnActivity, type ActivityTransport } from "./activity.js";
import type { GitActivityRecord } from "./git-activity.js";

function fixture(options: { reasoning?: "stream" | "off" } = {}) {
  const created: Array<{ kind: string; body: string; turnId: string }> = [];
  const nonces: string[] = [];
  const updated: Array<{ messageId: string; body: string }> = [];
  const progress: Array<{ op: string; line?: { id: string; kind: string; text?: string; status?: string; tool_name?: string } }> = [];
  const transport: ActivityTransport = {
    async create(kind, body, turnId, nonce) {
      created.push({ kind, body, turnId });
      nonces.push(nonce);
      return { id: `msg_${created.length}` };
    },
    async update(messageId, body) {
      updated.push({ messageId, body });
    },
    async progress(payload) {
      progress.push(payload as (typeof progress)[number]);
    },
  };
  const activity = new TurnActivity({
    turnId: "turn_1",
    source: { channel_id: "chn_1" },
    transport,
    flushMs: 0,
    ...(options.reasoning ? { reasoning: options.reasoning } : {}),
  });
  return { activity, created, nonces, updated, progress };
}

test("publishes pre-tool prose and tools as durable ClickClack activity", async () => {
  const { activity, created, nonces } = fixture();

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
  assert.equal(new Set(nonces).size, 2);
  assert.ok(nonces.every((nonce) => /^pi-activity-[a-f0-9]{48}$/u.test(nonce)));
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

test("streams intermediate prose instead of provider reasoning summaries", async () => {
  const { activity, created, updated, progress } = fixture();

  activity.handle({ type: "message_start", message: { role: "assistant", content: [] } });
  activity.handle({
    type: "message_update",
    assistantMessageEvent: { type: "thinking_delta", contentIndex: 0, delta: "**Planning terse status**" },
  });
  activity.handle({
    type: "message_update",
    assistantMessageEvent: { type: "thinking_end", contentIndex: 0, content: "**Planning terse status**" },
  });
  activity.handle({
    type: "message_update",
    assistantMessageEvent: {
      type: "text_delta",
      delta: "i found the boundary. i’m checking the caller before changing it.",
    },
  });
  activity.handle({ type: "tool_execution_start", toolCallId: "call_1", toolName: "read", args: { path: "src/a.ts" } });
  await activity.finalize();

  assert.deepEqual(created.map((row) => [row.kind, row.body]), [
    ["agent_commentary", "i found the boundary. i’m checking the caller before changing it."],
    ["agent_tool", created[1]?.body],
  ]);
  assert.deepEqual(updated, []);
  assert.deepEqual(
    progress.filter((entry) => entry.line?.kind === "commentary").map((entry) => [entry.op, entry.line?.text, entry.line?.status]),
    [
      ["append", "i found the boundary. i’m checking the caller before changing it.", undefined],
      ["finalize", "i found the boundary. i’m checking the caller before changing it.", "done"],
    ],
  );
  assert.equal(progress.some((entry) => entry.line?.kind === "thinking"), false);
});

test("never publishes provider thinking summaries", async () => {
  const { activity, created, updated, progress } = fixture();

  activity.handle({ type: "message_start", message: { role: "assistant", content: [] } });
  activity.handle({
    type: "message_update",
    assistantMessageEvent: { type: "thinking_delta", contentIndex: 0, delta: "private reasoning" },
  });
  activity.handle({
    type: "message_update",
    assistantMessageEvent: { type: "thinking_end", contentIndex: 0, content: "private reasoning complete" },
  });
  await activity.finalize();

  assert.deepEqual(created, []);
  assert.deepEqual(updated, []);
  assert.deepEqual(progress, []);
});

test("reasoning off suppresses intermediate prose", async () => {
  const { activity, created, progress } = fixture({ reasoning: "off" });

  activity.handle({ type: "message_start", message: { role: "assistant", content: [] } });
  activity.handle({
    type: "message_update",
    assistantMessageEvent: { type: "text_delta", delta: "i’m checking the caller before changing it." },
  });
  activity.handle({ type: "tool_execution_start", toolCallId: "call_1", toolName: "read", args: { path: "src/a.ts" } });
  await activity.finalize();

  assert.deepEqual(created.map((row) => row.kind), ["agent_tool"]);
  assert.equal(progress.some((entry) => entry.line?.kind === "commentary"), false);
});

test("streams throttled text and tool lifecycle as targeted progress", async () => {
  const { activity, progress } = fixture();

  activity.handle({ type: "agent_start" });
  activity.handle({ type: "message_start", message: { role: "assistant", content: [] } });
  activity.handle({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "Inspecting" } });
  activity.handle({ type: "tool_execution_start", toolCallId: "call_1", toolName: "read", args: { path: "src/a.ts" } });
  activity.handle({ type: "tool_execution_end", toolCallId: "call_1", isError: false });
  activity.handle({ type: "agent_end" });
  await activity.finalize();

  assert.deepEqual(progress.map(({ op, line }) => ({ op, id: line?.id, kind: line?.kind, status: line?.status })), [
    { op: "append", id: "lifecycle", kind: "lifecycle", status: "running" },
    { op: "append", id: "assistant-1", kind: "commentary", status: undefined },
    { op: "finalize", id: "assistant-1", kind: "commentary", status: "done" },
    { op: "append", id: "tool-call_1", kind: "tool", status: "running" },
    { op: "finalize", id: "tool-call_1", kind: "tool", status: "succeeded" },
    { op: "finalize", id: "lifecycle", kind: "lifecycle", status: "done" },
    { op: "clear", id: undefined, kind: undefined, status: undefined },
  ]);
});

test("returns successful write outputs only when the final answer references them", async () => {
  const activity = new TurnActivity({
    turnId: "turn_1",
    source: { channel_id: "chn_1" },
    projectCwd: "/repo",
    transport: {
      async create() { return { id: "msg_1" }; },
      async update() {},
    },
  });
  activity.handle({ type: "tool_execution_start", toolCallId: "write_1", toolName: "write", args: { path: "artifacts/report.pdf" } });
  activity.handle({ type: "tool_execution_end", toolCallId: "write_1", isError: false });
  activity.handle({ type: "tool_execution_start", toolCallId: "write_2", toolName: "write", args: { path: "artifacts/failed.csv" } });
  activity.handle({ type: "tool_execution_end", toolCallId: "write_2", isError: true });
  await activity.finalize();

  assert.deepEqual(activity.referencedGeneratedPaths("Download `artifacts/report.pdf`."), ["/repo/artifacts/report.pdf"]);
  assert.deepEqual(activity.referencedGeneratedPaths("Done."), []);
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

test("gives git its own heading so a commit is legible while collapsed", async () => {
  const { activity, created } = fixture();

  activity.handle({
    type: "tool_execution_start",
    toolCallId: "tool_1",
    toolName: "bash",
    args: { command: "git commit -m 'fix: keep the queue draining'" },
  });
  activity.handle({
    type: "tool_execution_start",
    toolCallId: "tool_2",
    toolName: "bash",
    args: { command: "rg 'git' src/" },
  });
  await activity.finalize();

  assert.deepEqual(created.map((row) => row.body), [
    "**git commit**\n\n-m fix: keep the queue draining",
    "**bash**\n\nrg 'git' src/",
  ]);
});

test("names the repository when a git command targets one explicitly", async () => {
  const { activity, created } = fixture();

  activity.handle({
    type: "tool_execution_start",
    toolCallId: "tool_1",
    toolName: "bash",
    args: { command: "git -C /home/kas/dev/vault push origin staging" },
  });
  await activity.finalize();

  assert.equal(created[0]?.body, "**git push** · /home/kas/dev/vault\n\norigin staging");
});

test("classifies git after the pinned cd prefix is stripped", async () => {
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
    args: { command: "cd /home/kas/dev/clickclack && git status --short" },
  });
  await activity.finalize();

  assert.deepEqual(created, [{ body: "**git status**\n\n--short" }]);
});

test("publishes commit and push outcomes to the configured git activity sink", async () => {
  const published: Array<{ body: string; nonce: string }> = [];
  const activity = new TurnActivity({
    turnId: "turn_1",
    source: { channel_id: "chn_source" },
    projectCwd: "/repo",
    projectAlias: "clickclack",
    sessionId: "session_1",
    transport: {
      async create() { return { id: "msg_tool" }; },
      async update() {},
      async publishGit(body, nonce) { published.push({ body, nonce }); },
    },
    async collectGitActivity(context): Promise<GitActivityRecord> {
      return {
        v: 1,
        action: context.operation.action,
        outcome: context.outcome,
        repository: { name: "clickclack", url: "https://github.com/example/clickclack" },
        branch: "kas/main",
        commit: {
          sha: "0123456789abcdef",
          subject: "ship activity cards",
          url: "https://github.com/example/clickclack/commit/0123456789abcdef",
        },
        project: context.projectAlias,
        session: { id: context.sessionId, turnId: context.turnId },
        occurredAt: "2026-03-20T12:00:00.000Z",
      };
    },
  });

  activity.handle({
    type: "tool_execution_start",
    toolCallId: "tool_1",
    toolName: "bash",
    args: { command: "git commit -m ship && git push origin kas/main" },
  });
  activity.handle({ type: "tool_execution_end", toolCallId: "tool_1", isError: false });
  await activity.finalize();

  assert.equal(published.length, 2);
  assert.match(published[0]?.body ?? "", /\*\*git commit succeeded\*\*/u);
  assert.match(published[1]?.body ?? "", /\*\*git push succeeded\*\*/u);
  assert.notEqual(published[0]?.nonce, published[1]?.nonce);
});

test("a failed git command still reports its failure", async () => {
  const { activity, created, updated } = fixture();

  activity.handle({
    type: "tool_execution_start",
    toolCallId: "tool_1",
    toolName: "bash",
    args: { command: "git push origin main" },
  });
  await activity.finalize();
  activity.handle({ type: "tool_execution_end", toolCallId: "tool_1", isError: true });
  await activity.finalize();

  assert.equal(created.length, 1);
  assert.deepEqual(updated, [{ messageId: "msg_1", body: "**git push**\n\norigin main\n\nfailed" }]);
});
