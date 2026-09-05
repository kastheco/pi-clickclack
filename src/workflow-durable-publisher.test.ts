import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { PublishWorkflowSnapshotRequest, PublishWorkflowSnapshotResponse } from "@clickclack/sdk-ts";
import { StateStore } from "./state/store.js";
import { DurableWorkflowPublisher } from "./workflow-durable-publisher.js";
import { fixture } from "./workflow-snapshot-fixture.test-helper.js";
function ack(input: PublishWorkflowSnapshotRequest): PublishWorkflowSnapshotResponse {
  return { changed: true, record: { ...input, id: "record", producer_id: "bot", updated_at: "2026-09-01T00:00:00Z" } };
}
const target = { workspace_id: "workspace", channel_id: "channel" };
const event = { view: { schema: "pi-workflows.session-view.v1", sessionId: "session", run: { schema: "pi-workflows.run-view.v1", runId: "run", revision: 4, queue: { runId: "run", originSessionId: "session" } } } };

test("outbox persists before send, retries exact bytes after restart and retains terminal on null/stop", async () => {
  const root = mkdtempSync(join(tmpdir(), "workflow-outbox-")); const path = join(root, "bridge.sqlite");
  let state = new StateStore(path); let now = 0; const f = fixture(); let first: string | undefined;
  try {
    const options = () => ({ database: state.database, endpoint: "http://fixture", hostIdentity: "fixture-host", producerId: "bot", workspaceId: "workspace", client: () => f.client, now: () => now });
    let publisher = new DurableWorkflowPublisher({ ...options(), publish: async input => {
      const row = state.database.prepare("SELECT payload,delivered FROM workflow_publications").get()!;
      assert.equal(row.payload, JSON.stringify(input)); assert.equal(row.delivered, 0); first = JSON.stringify(input);
      throw new Error("transient transport loss");
    } });
    publisher.observe(target, "session", event, "binding-project");
    assert.equal(state.database.prepare("SELECT count(*) AS n FROM workflow_publications").get()!.n, 1);
    await publisher.flush(); await publisher.stop(); state.close();
    state = new StateStore(path); now = 1000; let sends = 0;
    publisher = new DurableWorkflowPublisher({ ...options(), publish: async input => {
      sends++; assert.equal(JSON.stringify(input), first); return ack(input);
    } });
    publisher.observe(target, "session", { view: { sessionId: "session", run: null } }, "binding-project");
    await publisher.flush(); assert.equal(sends, 1);
    assert.equal(state.database.prepare("SELECT delivered FROM workflow_publications").get()!.delivered, 1);
    now += 60_000; await publisher.flush(); assert.equal(sends, 1); await publisher.stop();
    assert.equal(state.database.prepare("SELECT terminal FROM workflow_publications").get()!.terminal, 1);
    assert.doesNotMatch(String(state.database.prepare("SELECT payload FROM workflow_publications").get()!.payload), /PRIVATE|forged|prompt/);
  } finally { state.close(); rmSync(root, { recursive: true, force: true }); }
});
test("scope and exact session/target fence observations and acknowledgments", async () => {
  const state = new StateStore(":memory:"); const f = fixture(); let now = 0; let sends = 0;
  const options = { database: state.database, endpoint: "http://fixture", hostIdentity: "fixture-host", producerId: "bot", workspaceId: "workspace", client: () => f.client, now: () => now };
  const publisher = new DurableWorkflowPublisher({ ...options, publish: async input => {
    sends++; const result = ack(input); result.record.channel_id = "wrong"; return result;
  } });
  try {
    publisher.observe(target, "other-session", event, "binding-project"); await publisher.flush(); assert.equal(sends, 0);
    publisher.observe(target, "session", event, "binding-project"); await publisher.flush(); assert.equal(sends, 1);
    assert.equal(state.database.prepare("SELECT delivered FROM workflow_publications").get()!.delivered, 0);
    await publisher.flush(); assert.equal(sends, 1, "backoff prevents immediate resend");
    now = 1000; await publisher.flush(); assert.equal(sends, 2);
    await publisher.stop();
    const other = new DurableWorkflowPublisher({ ...options, producerId: "other-bot", publish: async input => { sends++; return ack(input); } });
    now = 100_000; await other.flush(); assert.equal(sends, 2); await other.stop();
  } finally { await publisher.stop(); state.close(); }
});
test("same revision differing digest is blocked; pointer clear still fetches final revision", async () => {
  const state = new StateStore(":memory:"); const f = fixture(); let now = 0; const sent: PublishWorkflowSnapshotRequest[] = [];
  f.view.display.status = "running";
  const publisher = new DurableWorkflowPublisher({ database: state.database, endpoint: "http://fixture", hostIdentity: "fixture-host", producerId: "bot", workspaceId: "workspace",
    client: () => f.client, now: () => now, publish: async input => { sent.push(input); return ack(input); } });
  try {
    publisher.observe(target, "session", event, "binding-project"); await publisher.flush();
    f.view.display.status = "completed"; now += 1000; await publisher.flush(); assert.equal(sent.length, 1);
    publisher.observe(target, "session", { view: { sessionId: "session", run: null } }, "binding-project");
    f.view.revision++; now += 2000; await publisher.flush(); assert.equal(sent.length, 2);
    assert.equal(sent[1]!.snapshot.run.status, "completed");
    publisher.observe({ workspace_id: "workspace", direct_conversation_id: "dm" }, "session", event, "binding-project");
    await publisher.flush(); assert.equal(sent.length, 3); assert.equal(sent[2]!.direct_conversation_id, "dm");
  } finally { await publisher.stop(); state.close(); }
});
test("watch schema/origin fence discovery; binding, project and host namespaces isolate replay", async () => {
  const state = new StateStore(":memory:"); const f = fixture(); let sends = 0;
  const options = { database: state.database, endpoint: "http://fixture", hostIdentity: "host-one", producerId: "bot", workspaceId: "workspace",
    client: () => f.client, publish: async (input: PublishWorkflowSnapshotRequest) => { sends++; return ack(input); } };
  const publisher = new DurableWorkflowPublisher(options);
  try {
    publisher.observe(target, "session", { view: { ...event.view, schema: "wrong" } }, "binding-one-project");
    publisher.observe(target, "session", { view: { ...event.view, run: { ...event.view.run, queue: { runId: "run", originSessionId: "wrong" } } } }, "binding-one-project");
    await publisher.flush(); assert.equal(sends, 0);
    publisher.observe(target, "session", event, "binding-one-project");
    publisher.observe(target, "session", event, "binding-two-project");
    assert.equal(state.database.prepare("SELECT count(*) AS n FROM workflow_publications").get()!.n, 2);
    await publisher.stop();
    const otherHost = new DurableWorkflowPublisher({ ...options, hostIdentity: "host-two" });
    await otherHost.flush(); assert.equal(sends, 0); await otherHost.stop();
    // Identity alone survived shutdown; the first snapshot can still be collected
    // after the terminal host reservation disappeared, without a new watch event.
    (f.view.queue as { originSessionId: string | null }).originSessionId = null;
    const restarted = new DurableWorkflowPublisher(options); await restarted.flush(); assert.equal(sends, 2); await restarted.stop();
  } finally { await publisher.stop(); state.close(); }
});
