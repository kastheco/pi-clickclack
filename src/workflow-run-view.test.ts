import assert from "node:assert/strict";
import test from "node:test";

import { readRunView, sessionRun } from "./workflow-run-view.js";

function step(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    attemptId: "attempt-1",
    nodeId: "plan",
    nodeType: "agent",
    outcome: "ok",
    startedAt: "2026-09-03T10:00:00.000Z",
    finishedAt: "2026-09-03T10:00:30.000Z",
    // Content the host carries on a step record and an operator view must not.
    prompt: "SECRET PROMPT TEXT",
    output: { secret: "raw node output" },
    ...overrides,
  };
}

function runView(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    schema: "pi-workflows.run-view.v1",
    runId: "run-1",
    revision: 7,
    display: { status: "waiting", activity: null, controls: ["answer"], reason: "awaiting a decision" },
    queue: {
      runId: "run-1",
      workflowName: "ship-it",
      status: "parked",
      startedAt: "2026-09-03T10:00:00.000Z",
      finishedAt: null,
    },
    graphSteps: [step()],
    stepTotal: 4,
    live: true,
    possiblyInterrupted: false,
    // Execution detail an operator view has no business reading.
    manifest: { secret: "manifest" },
    state: { secret: "state" },
    workflow: { secret: "definition" },
    ...overrides,
  };
}

test("a run reads down to what an operator can be shown", () => {
  assert.deepEqual(readRunView(runView()), {
    runId: "run-1",
    workflowName: "ship-it",
    revision: 7,
    status: "waiting",
    reason: "awaiting a decision",
    live: true,
    possiblyInterrupted: false,
    startedAt: "2026-09-03T10:00:00.000Z",
    finishedAt: null,
    steps: [
      {
        attemptId: "attempt-1",
        nodeId: "plan",
        nodeType: "agent",
        outcome: "ok",
        startedAt: "2026-09-03T10:00:00.000Z",
        finishedAt: "2026-09-03T10:00:30.000Z",
      },
    ],
    stepTotal: 4,
  });
});

// A step record holds the agent's full prompt and the raw node output, and the
// run view holds workflow state and manifest. The same reasoning already keeps
// decisionForOperator off the decision subject: an operator surface shows what
// the workflow author meant to show, never execution detail.
test("execution detail never reaches the operator view", () => {
  const serialized = JSON.stringify(readRunView(runView()));
  for (const leaked of ["SECRET PROMPT TEXT", "raw node output", "manifest", "state", "definition"]) {
    assert.doesNotMatch(serialized, new RegExp(leaked, "u"), leaked);
  }
});

test("a run is read off a session-view event", () => {
  const run = sessionRun({ view: { schema: "pi-workflows.session-view.v1", run: runView() } });
  assert.equal(run?.runId, "run-1");
  assert.equal(run?.status, "waiting");
});

test("a session with no run reads as no run", () => {
  const cases: Record<string, unknown> = {
    "null run": { view: { run: null } },
    "no run key": { view: {} },
    "no view": {},
    "not an object": "nope",
    "null event": null,
  };
  for (const [name, event] of Object.entries(cases)) {
    assert.equal(sessionRun(event), undefined, name);
  }
});

// Half a run is worse than no run: a status surface would show a confident view
// of something it did not actually understand.
test("a malformed run reads as no run rather than a partial one", () => {
  const cases: Record<string, unknown> = {
    "no run id": runView({ runId: undefined }),
    "no revision": runView({ revision: undefined }),
    "no display": runView({ display: undefined }),
    "unknown status": runView({ display: { status: "vibing" } }),
    "no queue": runView({ queue: undefined }),
    "no workflow name": runView({ queue: { status: "parked" } }),
    "not an object": "nope",
  };
  for (const [name, value] of Object.entries(cases)) {
    assert.equal(readRunView(value), undefined, name);
  }
});

test("a run with no steps yet is still a run", () => {
  const run = readRunView(runView({ graphSteps: [], stepTotal: 0 }));
  assert.deepEqual(run?.steps, []);
  assert.equal(run?.stepTotal, 0);
});

test("an unreadable step is dropped without dropping the run", () => {
  const run = readRunView(runView({
    graphSteps: [
      step(),
      step({ outcome: "vibing" }),
      step({ nodeId: undefined }),
      step({ finishedAt: 12 }),
      "not a step",
      null,
      step({ attemptId: "attempt-2", nodeId: "review" }),
    ],
  }));
  assert.deepEqual(run?.steps.map((entry) => entry.nodeId), ["plan", "review"]);
});

test("a step window smaller than the run's total is reported as such", () => {
  const run = readRunView(runView({ graphSteps: [step()], stepTotal: 12 }));
  assert.equal(run?.steps.length, 1);
  assert.equal(run?.stepTotal, 12);
});

test("an interrupted run says so", () => {
  const run = readRunView(runView({ live: false, possiblyInterrupted: true }));
  assert.equal(run?.live, false);
  assert.equal(run?.possiblyInterrupted, true);
});

test("a run with no host reason reads as no reason", () => {
  const run = readRunView(runView({ display: { status: "running", reason: null } }));
  assert.equal(run?.reason, null);
});
