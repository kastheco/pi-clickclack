import assert from "node:assert/strict";
import test from "node:test";
import { createClickClackClient } from "./clickclack.js";
import { collectWorkflowSnapshot } from "./workflow-snapshot.js";
import { fixture } from "./workflow-snapshot-fixture.test-helper.js";

test("background publication requests add an abort deadline; chat transport remains unchanged", async (t) => {
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
  await client.botRuntimeStatus.publish("channels", "channel", {
    workspace_id: "workspace",
    status: { runtime: "pi", model_provider: "openai-codex", model_id: "gpt-5.6", reasoning: "high", fast_mode: true },
  });
  assert.equal(signals[0], undefined);
  assert.ok(signals[1] instanceof AbortSignal); assert.equal(signals[1].aborted, false);
  assert.ok(signals[2] instanceof AbortSignal); assert.equal(signals[2].aborted, false);
});
