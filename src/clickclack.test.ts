import assert from "node:assert/strict";
import test from "node:test";
import { createClickClackClient } from "./clickclack.js";
import { collectWorkflowSnapshot } from "./workflow-snapshot.js";
import { fixture } from "./workflow-snapshot-fixture.test-helper.js";

test("only durable workflow API requests add an abort deadline; chat transport remains unchanged", async (t) => {
  const signals: (AbortSignal | null | undefined)[] = [];
  t.mock.method(globalThis, "fetch", async (_input: unknown, init?: RequestInit) => {
    signals.push(init?.signal);
    return new Response("{}", { status: 200, headers: { "Content-Type": "application/json" } });
  });
  const client = createClickClackClient({ clickClack: { baseUrl: "http://fixture.invalid", botToken: "fixture", workspaceId: "workspace", ownerIds: [] },
    pi: { agentDir: "/unused", model: "unused", thinkingLevel: "off" }, projects: new Map(), invocationBindings: [], statePath: ":memory:" });
  await client.me();
  const snapshot = await collectWorkflowSnapshot(fixture().client, "session", "run");
  await client.workflowRuns.publish({ workspace_id: "workspace", channel_id: "channel", snapshot });
  assert.equal(signals[0], undefined);
  assert.ok(signals[1] instanceof AbortSignal); assert.equal(signals[1].aborted, false);
});
