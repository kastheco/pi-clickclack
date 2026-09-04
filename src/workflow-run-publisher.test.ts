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

test("the first run seen is published", async () => {
  const { published, reporter: subject } = reporter();
  subject.report(run());
  await subject.drain();
  assert.equal(published.length, 1);
  assert.equal(published[0]?.runId, "run-1");
});

// The host emits a session view on every write to that session, most of which
// change nothing an operator can see. Forwarding all of them would put a frame
// on the socket for every internal write.
test("an unchanged run is not republished", async () => {
  const { published, reporter: subject } = reporter();
  subject.report(run());
  subject.report(run());
  subject.report(run());
  await subject.drain();
  assert.equal(published.length, 1);
});

test("a revision bump alone is not a visible change", async () => {
  const { published, reporter: subject } = reporter();
  subject.report(run({ revision: 3 }));
  subject.report(run({ revision: 9 }));
  await subject.drain();
  assert.equal(published.length, 1);
});

test("a status change publishes", async () => {
  const { published, reporter: subject } = reporter();
  subject.report(run({ status: "running" }));
  subject.report(run({ status: "waiting" }));
  await subject.drain();
  assert.deepEqual(published.map((entry) => entry?.status), ["running", "waiting"]);
});

test("a finished step publishes", async () => {
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
  await subject.drain();
  assert.equal(published.length, 2);
});

test("a run ending publishes a cleared frame", async () => {
  const { published, reporter: subject } = reporter();
  subject.report(run());
  subject.report(undefined);
  await subject.drain();
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
test("stopping clears a published run", async () => {
  const { published, reporter: subject } = reporter();
  subject.report(run());
  await subject.stop();
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
  await subject.drain();
  assert.equal(published.length, 0);
  assert.equal(errors.length, 1);

  subject.report(run());
  await subject.drain();
  assert.equal(published.length, 1);
});

/** A publisher whose frames only land when the test releases them. */
function deferredReporter(): {
  landed: (RunView | null)[];
  release(index: number): void;
  reporter: WorkflowRunReporter;
} {
  const landed: (RunView | null)[] = [];
  const gates: Array<() => void> = [];
  const released = new Set<number>();
  return {
    landed,
    release: (index) => {
      const gate = gates[index];
      if (gate) gate();
      else released.add(index);
    },
    reporter: new WorkflowRunReporter({
      publish: async (value) => {
        const index = gates.length;
        await new Promise<void>((resolve) => {
          gates.push(resolve);
          if (released.has(index)) resolve();
        });
        landed.push(value);
      },
    }),
  };
}

// A frame is absolute state, not a delta. Two in flight at once could land out
// of order and leave the client showing a run that has already moved on.
test("frames land in the order they were decided", async () => {
  const { landed, release, reporter: subject } = deferredReporter();
  subject.report(run({ status: "running" }));
  subject.report(run({ status: "waiting" }));

  // Release the second publish first. Serialization means it cannot have
  // started, so the first still lands first.
  release(1);
  release(0);
  await subject.drain();

  assert.deepEqual(landed.map((entry) => entry?.status), ["running", "waiting"]);
});

// The dangerous race: a clear lands, then a stale run lands after it, and a
// conversation whose watcher has stopped shows a live run forever.
test("a clear cannot be overtaken by a frame decided before it", async () => {
  const { landed, release, reporter: subject } = deferredReporter();
  subject.report(run({ status: "running" }));
  const stopped = subject.stop();

  release(1);
  release(0);
  await stopped;

  assert.deepEqual(landed.map((entry) => entry?.status ?? "cleared"), ["running", "cleared"]);
  assert.equal(landed[landed.length - 1], null);
});

test("stopping resolves once the clear has landed", async () => {
  const { release, reporter: subject } = deferredReporter();
  subject.report(run());

  let settled = false;
  const stopped = subject.stop().then(() => {
    settled = true;
  });
  await Promise.resolve();
  assert.equal(settled, false, "stop resolved before its frames landed");

  release(0);
  release(1);
  await stopped;
  assert.equal(settled, true);
});

// One failure must not strand every later frame behind it.
test("a failed publish does not block the frames behind it", async () => {
  const landed: (RunView | null)[] = [];
  const errors: unknown[] = [];
  let first = true;
  const subject = new WorkflowRunReporter({
    publish: async (value) => {
      if (first) {
        first = false;
        throw new Error("socket down");
      }
      landed.push(value);
    },
    onError: (error) => errors.push(error),
  });

  subject.report(run({ status: "running" }));
  subject.report(run({ status: "waiting" }));
  await subject.drain();

  assert.equal(errors.length, 1);
  assert.deepEqual(landed.map((entry) => entry?.status), ["waiting"]);
});

// A visible field that the frame carries must not be able to change silently.
test("every carried field is covered by the change check", async () => {
  const { published, reporter: subject } = reporter();
  const step = {
    attemptId: "a1",
    nodeId: "plan",
    nodeType: "agent",
    outcome: "ok" as const,
    startedAt: "2026-09-03T10:00:00.000Z",
    finishedAt: "2026-09-03T10:00:20.000Z",
  };
  subject.report(run({ steps: [step], stepTotal: 1 }));
  subject.report(run({ steps: [{ ...step, nodeType: "action" }], stepTotal: 1 }));
  subject.report(run({
    steps: [{ ...step, nodeType: "action", startedAt: "2026-09-03T11:00:00.000Z" }],
    stepTotal: 1,
  }));
  await subject.drain();
  assert.equal(published.length, 3);
});
