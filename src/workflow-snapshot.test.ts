import assert from "node:assert/strict";
import test from "node:test";
import { collectWorkflowSnapshot } from "./workflow-snapshot.js";
import { fixture } from "./workflow-snapshot-fixture.test-helper.js";

test("durable snapshot pages full attempts, not compact graph, and allowlists privacy fields", async () => {
  const f = fixture(); const snapshot = await collectWorkflowSnapshot(f.client, "session", "run");
  assert.deepEqual(f.calls, [0, 2]); assert.equal(snapshot.steps.length, 3); assert.equal(snapshot.run.stepsComplete, true);
  assert.equal(snapshot.files, null); assert.doesNotMatch(JSON.stringify(snapshot), /PRIVATE|forged|prompt|output|state/);
});
test("durable snapshot caps history truthfully", async () => {
  const f = fixture(1001); const snapshot = await collectWorkflowSnapshot(f.client, "session", "run");
  assert.equal(snapshot.steps.length, 1000); assert.equal(snapshot.run.stepTotal, 1001); assert.equal(snapshot.run.stepsComplete, false);
});
test("durable snapshot rejects revision conflict, duplicates, and session mismatch", async () => {
  const f = fixture(); await assert.rejects(collectWorkflowSnapshot(f.client, "other-session", "run"));
  f.steps[1]!.attemptId = f.steps[0]!.attemptId; await assert.rejects(collectWorkflowSnapshot(f.client, "session", "run"));
  const g = fixture(); const request = g.client.request; g.client.request = async options => {
    const response = await request(options); if (options.operation === "view.page") (response.receipt as { revision: number }).revision++;
    return response;
  };
  await assert.rejects(collectWorkflowSnapshot(g.client, "session", "run"));
});
test("durable snapshot only accepts bounded typed host files", async () => {
  const f = fixture(); const view = f.view as typeof f.view & { operatorArtifacts?: unknown };
  view.operatorArtifacts = { changedFiles: { source: "host-git", basis: "cumulative-since-base", baseRevision: "abc",
    attribution: "clean-baseline", complete: true, truncated: false, entries: [{ path: "src/new.ts", oldPath: "src/old.ts", change: "renamed", content: "PRIVATE" }] } };
  const snapshot = await collectWorkflowSnapshot(f.client, "session", "run");
  assert.deepEqual(snapshot.files?.entries, [{ path: "src/new.ts", oldPath: "src/old.ts", change: "renamed" }]);
  for (const path of ["/absolute", "../escape", "a//b", "a/./b", "a\\b", "a:b", "a\u0000b"]) {
    (view.operatorArtifacts as { changedFiles: { entries: { path: string }[] } }).changedFiles.entries[0]!.path = path;
    await assert.rejects(collectWorkflowSnapshot(f.client, "session", "run"));
  }
});
test("terminal null origin needs persisted discovery, and overlapping centered pages remain complete", async () => {
  const f = fixture(5);
  (f.view.queue as { originSessionId: string | null }).originSessionId = null;
  await assert.rejects(collectWorkflowSnapshot(f.client, "session", "run"));
  const request = f.client.request;
  f.client.request = async options => {
    if (options.operation !== "view.page") return request(options);
    const cursor = (options.payload as { cursor: number }).cursor;
    const start = Math.max(0, cursor - 1);
    return { outcome: "accepted", receipt: { schema: "pi-workflows.run-page.v1", runId: "run", revision: 4,
      kind: "steps", cursor, start, total: 5, items: f.steps.slice(start, start + 3) } };
  };
  const snapshot = await collectWorkflowSnapshot(f.client, "session", "run", true);
  assert.equal(snapshot.steps.length, 5); assert.equal(snapshot.run.stepsComplete, true);
  f.view.queue.originSessionId = "other-session";
  await assert.rejects(collectWorkflowSnapshot(f.client, "session", "run", true));
});
test("durable reasons allow only static host literals, never short error/path/prompt/secret text", async () => {
  const f = fixture();
  const display = f.view.display as { status: string; reason: string | null };
  for (const reason of ["failed reading /home/private/project/file", "prompt: SECRET USER REQUEST", "token=secret-value",
    "The workflow is durably paused. extra", " The workflow is durably paused."]) {
    display.reason = reason;
    assert.equal((await collectWorkflowSnapshot(f.client, "session", "run")).run.reason, null);
  }
  display.reason = "The workflow is durably paused.";
  assert.equal((await collectWorkflowSnapshot(f.client, "session", "run")).run.reason, display.reason);
});
