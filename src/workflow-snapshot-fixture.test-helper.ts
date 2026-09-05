import assert from "node:assert/strict";
import type { WorkflowDecisionClient } from "./workflow-decisions.js";
export function fixture(total = 3) {
  const steps = Array.from({ length: total }, (_, i) => ({ attemptId: `attempt-${i}`, nodeId: "repeated", nodeType: "compute", outcome: "ok",
    startedAt: "2026-09-01T00:00:00Z", finishedAt: "2026-09-01T00:01:00Z", prompt: "PRIVATE PROMPT", output: { files: ["forged.txt"] } }));
  const view = { schema: "pi-workflows.run-view.v1", runId: "run", revision: 4,
    display: { status: "completed", reason: null }, queue: { runId: "run", workflowName: "fixture", originSessionId: "session", startedAt: null, finishedAt: null },
    possiblyInterrupted: false, stepTotal: total, stepStart: Math.max(0, total - 1), state: { steps: steps.slice(-1), secrets: "PRIVATE STATE" }, graphSteps: steps.slice(-1) };
  const calls: number[] = [];
  const client: WorkflowDecisionClient = { clientId: "fixture", ensureAvailable: async () => undefined,
    watchSession: async () => async () => undefined, requestDurable: async () => ({ outcome: "accepted" }),
    request: async options => {
      if (options.operation === "view.run.get") return { outcome: "accepted", receipt: view };
      assert.equal(options.expectedRevision, view.revision);
      const cursor = (options.payload as { cursor: number }).cursor; calls.push(cursor);
      return { outcome: "accepted", receipt: { schema: "pi-workflows.run-page.v1", runId: "run", revision: view.revision,
        kind: "steps", cursor, start: cursor, total, items: steps.slice(cursor, cursor + 2) } };
    } };
  return { client, view, steps, calls };
}
