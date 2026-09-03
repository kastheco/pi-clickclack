import assert from "node:assert/strict";
import test from "node:test";

import { WorkflowRunReporter } from "./workflow-run-publisher.js";
import type { RunView } from "./workflow-run-view.js";

function run(overrides: Partial<RunView> = {}): RunView {
  return {
    runId: "run-1",
    workflowName: "ship-it",
    revision: 3,
    status: "running",
    reason: null,
    live: true,
    possiblyInterrupted: false,
    startedAt: "2026-09-03T10:00:00.000Z",
    finishedAt: null,
    steps: [],
    stepTotal: 0,
    ...overrides,
  };
}

function reporter(): { published: (RunView | null)[]; reporter: WorkflowRunReporter } {
  const published: (RunView | null)[] = [];
  return {
    published,
    reporter: new WorkflowRunReporter({
      publish: async (value) => {
        published.push(value);
      },
    }),
  };
}

test("the first run seen is published", () => {
  const { published, reporter: subject } = reporter();
  subject.report(run());
  assert.equal(published.length, 1);
  assert.equal(published[0]?.runId, "run-1");
});

// The host emits a session view on every write to that session, most of which
// change nothing an operator can see. Forwarding all of them would put a frame
// on the socket for every internal write.
test("an unchanged run is not republished", () => {
  const { published, reporter: subject } = reporter();
  subject.report(run());
  subject.report(run());
  subject.report(run());
  assert.equal(published.length, 1);
});

test("a revision bump alone is not a visible change", () => {
  const { published, reporter: subject } = reporter();
  subject.report(run({ revision: 3 }));
  subject.report(run({ revision: 9 }));
  assert.equal(published.length, 1);
});

test("a status change publishes", () => {
  const { published, reporter: subject } = reporter();
  subject.report(run({ status: "running" }));
  subject.report(run({ status: "waiting" }));
  assert.deepEqual(published.map((entry) => entry?.status), ["running", "waiting"]);
});

test("a finished step publishes", () => {
  const { published, reporter: subject } = reporter();
  subject.report(run({ steps: [], stepTotal: 0 }));
  subject.report(run({
    stepTotal: 1,
    steps: [{
      attemptId: "a1",
      nodeId: "plan",
      nodeType: "agent",
      outcome: "ok",
      startedAt: "2026-09-03T10:00:00.000Z",
      finishedAt: "2026-09-03T10:00:20.000Z",
    }],
  }));
  assert.equal(published.length, 2);
});

test("a run ending publishes a cleared frame", () => {
  const { published, reporter: subject } = reporter();
  subject.report(run());
  subject.report(undefined);
  assert.deepEqual(published, [published[0], null]);
});

test("a session that never had a run publishes nothing", () => {
  const { published, reporter: subject } = reporter();
  subject.report(undefined);
  subject.report(undefined);
  assert.equal(published.length, 0);
});

// A conversation whose watcher goes away would otherwise leave its last frame on
// screen forever, because nothing else ever contradicts it.
test("stopping clears a published run", () => {
  const { published, reporter: subject } = reporter();
  subject.report(run());
  subject.stop();
  assert.deepEqual(published[published.length - 1], null);
});

test("stopping without a published run says nothing", () => {
  const { published, reporter: subject } = reporter();
  subject.stop();
  assert.equal(published.length, 0);
});

test("a stopped reporter ignores later reports", () => {
  const { published, reporter: subject } = reporter();
  subject.stop();
  subject.report(run());
  assert.equal(published.length, 0);
});

// A dropped frame must not be remembered as sent, or the run would sit stale on
// screen until something else about it changed.
test("a failed publish is retried on the next identical report", async () => {
  const published: (RunView | null)[] = [];
  const errors: unknown[] = [];
  let fail = true;
  const subject = new WorkflowRunReporter({
    publish: async (value) => {
      if (fail) {
        fail = false;
        throw new Error("socket down");
      }
      published.push(value);
    },
    onError: (error) => errors.push(error),
  });

  subject.report(run());
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(published.length, 0);
  assert.equal(errors.length, 1);

  subject.report(run());
  await Promise.resolve();
  assert.equal(published.length, 1);
});
