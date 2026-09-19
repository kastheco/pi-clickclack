import assert from "node:assert/strict";
import test from "node:test";

import {
  decisionForOperator,
  sessionInteractions,
  WorkflowDecisionWatcher,
  type ClaimedWorkflowDecision,
  type DecisionAnswer,
  type WorkflowDecisionClient,
  type WorkflowInteractiveRequest,
} from "./workflow-decisions.js";

function decisionRequest(): WorkflowInteractiveRequest {
  return {
    requestId: "request-1",
    runId: "run-1",
    revision: 3,
    kind: "decision",
    status: "pending",
    contract: {
      request: {
        title: "Approve the implementation plan",
        subject: { plan: "secret canonical detail" },
        presentation: {
          schema: "pi-workflows.decision-presentation.v1",
          summary: "Review the implementation plan.",
          blocks: [],
        },
        choices: {
          continue: { label: "Yes, continue" },
          replan: {
            label: "Replan",
            input: { kind: "text", name: "instructions", prompt: "What should change?" },
          },
        },
      },
    },
  };
}

function sessionEvent(interactions: readonly WorkflowInteractiveRequest[]): unknown {
  return {
    type: "event",
    event: "session_snapshot",
    payload: { pendingInteractions: interactions },
  };
}

type RecordedRequest = { operation: string; expectedRevision: number | undefined; payload?: unknown };

function client(
  overrides: Partial<WorkflowDecisionClient> = {},
): WorkflowDecisionClient & { recorded: RecordedRequest[]; emit(event: unknown): void } {
  const recorded: RecordedRequest[] = [];
  let listener: ((event: unknown) => void) | undefined;
  return {
    recorded,
    emit: (event) => listener?.(event),
    clientId: "bridge-1",
    ensureAvailable: async () => undefined,
    watchSession: async (_sessionId, next) => {
      listener = next;
      return async () => {
        listener = undefined;
      };
    },
    request: async (options) => {
      recorded.push({
        operation: options.operation,
        expectedRevision: options.expectedRevision,
        payload: options.payload,
      });
      return { outcome: "accepted", revision: 4 };
    },
    requestDurable: async (options) => {
      recorded.push({
        operation: options.operation,
        expectedRevision: options.expectedRevision,
        payload: options.payload,
      });
      return { outcome: "accepted", revision: 5 };
    },
    ...overrides,
  };
}

async function settle(): Promise<void> {
  for (let tick = 0; tick < 10; tick += 1) await new Promise((resolve) => setTimeout(resolve, 1));
}

test("external subscription advertises ownership without taking agent coordination", async () => {
  let options: unknown;
  const transport = client({ watchSession: async (_session,next,opts) => { options=opts; return async () => {}; } });
  const watcher = new WorkflowDecisionWatcher({ client: transport, sessionId: "s", present: async () => undefined });
  await watcher.start(); assert.deepEqual(options,{externalPresenter:true}); await watcher.stop();
});

test("the operator view carries the authored presentation and never the subject", () => {
  const decision = decisionForOperator(decisionRequest());
  assert.notEqual(decision, undefined);
  assert.equal(decision?.title, "Approve the implementation plan");
  assert.equal(decision?.summary, "Review the implementation plan.");
  assert.deepEqual(decision?.choices, [
    { key: "continue", label: "Yes, continue", expectsInput: false },
    { key: "replan", label: "Replan", expectsInput: true },
  ]);
  assert.doesNotMatch(JSON.stringify(decision), /secret canonical detail/u);
});

test("externalized decision contracts are hydrated before presentation", async () => {
  const transport = client();
  const interaction = {
    ...decisionRequest(),
    contract: {
      $artifact: {
        path: "interactions/decision-1/contract.json",
        mediaType: "application/json",
        bytes: 123,
        sha256: "a".repeat(64),
      },
    },
  };
  const hydrated: Array<{ runId: string; value: unknown }> = [];
  Object.assign(transport, {
    hydrateContent: async (runId: string, value: unknown) => {
      hydrated.push({ runId, value });
      return decisionRequest().contract;
    },
  });
  const presented: ClaimedWorkflowDecision[] = [];
  const watcher = new WorkflowDecisionWatcher({
    client: transport,
    sessionId: "session-1",
    present: async (decision) => {
      presented.push(decision);
      return undefined;
    },
  });

  await watcher.start();
  transport.emit(sessionEvent([interaction]));
  await settle();

  assert.deepEqual(hydrated, [{ runId: "run-1", value: interaction.contract }]);
  assert.equal(presented[0]?.title, "Approve the implementation plan");
  await watcher.stop();
});

test("agent and assistant interactions are not treated as decisions", () => {
  for (const kind of ["agent", "assistant"] as const) {
    assert.equal(decisionForOperator({ ...decisionRequest(), kind }), undefined);
  }
});

test("session events without a pending interaction list are ignored", () => {
  assert.equal(sessionInteractions(undefined), undefined);
  assert.equal(sessionInteractions({ view: {} }), undefined);
  assert.equal(sessionInteractions({ type: "event", event: "run_snapshot", payload: {} }), undefined);
  assert.deepEqual(sessionInteractions(sessionEvent([])), []);
});

test("a pending decision is presented and answered at its current revision", async () => {
  const transport = client();
  const presented: string[] = [];
  const watcher = new WorkflowDecisionWatcher({
    client: transport,
    sessionId: "session-1",
    present: async (decision) => {
      presented.push(decision.title);
      return { choice: "replan", input: { instructions: "Use the existing island." } };
    },
  });

  await watcher.start();
  transport.emit(sessionEvent([decisionRequest()]));
  await settle();

  assert.deepEqual(presented, ["Approve the implementation plan"]);
  assert.deepEqual(transport.recorded.map((entry) => entry.operation), [
    "decision.answer",
  ]);
  assert.deepEqual(transport.recorded.map((entry) => entry.expectedRevision), [3]);
  assert.deepEqual((transport.recorded[0]?.payload as { response: unknown }).response, {
    choice: "replan",
    input: { instructions: "Use the existing island." },
  });
});

test("duplicate snapshots do not reopen the same decision revision", async () => {
  const transport=client(); let count=0;
  const watcher=new WorkflowDecisionWatcher({client:transport,sessionId:"s",present:async()=>{count++;return undefined;}});
  await watcher.start(); transport.emit(sessionEvent([decisionRequest()])); await settle();
  transport.emit(sessionEvent([decisionRequest()])); await settle(); assert.equal(count,1); await watcher.stop();
});

test("a new revision cancels stale presentation and fences its answer", async () => {
  const transport=client(); const signals: AbortSignal[]=[];
  const watcher=new WorkflowDecisionWatcher({client:transport,sessionId:"s",present:async (_decision,signal)=>{
    signals.push(signal); if(signals.length===1) await new Promise<void>(resolve=>signal.addEventListener("abort",()=>resolve(),{once:true}));
    return {choice:"continue"};
  }});
  await watcher.start();transport.emit(sessionEvent([decisionRequest()]));await settle();
  transport.emit(sessionEvent([{...decisionRequest(),revision:4}]));await settle();
  assert.equal(signals[0]?.aborted,true);assert.deepEqual(transport.recorded.map(r=>r.expectedRevision),[4]);await watcher.stop();
});

test("releasing a decision without an answer does not settle the run", async () => {
  const transport = client();
  const watcher = new WorkflowDecisionWatcher({
    client: transport,
    sessionId: "session-1",
    present: async () => undefined,
  });

  await watcher.start();
  transport.emit(sessionEvent([decisionRequest()]));
  await settle();

  assert.deepEqual(transport.recorded.map((entry) => entry.operation), []);
});

test("stopping the watcher waits for an in-flight presentation to release", async () => {
  const transport = client();
  let finish: ((value: DecisionAnswer | undefined) => void) | undefined;
  const watcher = new WorkflowDecisionWatcher({
    client: transport,
    sessionId: "session-1",
    present: () => new Promise((resolve) => { finish = resolve; }),
  });

  await watcher.start();
  transport.emit(sessionEvent([decisionRequest()]));
  await settle();
  const stopping = watcher.stop();
  finish?.(undefined);
  await stopping;

  assert.deepEqual(transport.recorded.map((entry) => entry.operation), []);
});

test("stopping the watcher drains an acknowledged decision answer", async () => {
  let releaseAnswer!: () => void;
  let markAnswerStarted!: () => void;
  const answerGate = new Promise<void>((resolve) => { releaseAnswer = resolve; });
  const answerStarted = new Promise<void>((resolve) => { markAnswerStarted = resolve; });
  const transport = client({
    requestDurable: async (options) => {
      transport.recorded.push({
        operation: options.operation,
        expectedRevision: options.expectedRevision,
        payload: options.payload,
      });
      markAnswerStarted();
      await answerGate;
      return { outcome: "accepted", revision: 5 };
    },
  });
  let finish: ((value: DecisionAnswer | undefined) => void) | undefined;
  const watcher = new WorkflowDecisionWatcher({
    client: transport,
    sessionId: "session-1",
    present: () => new Promise((resolve) => { finish = resolve; }),
  });

  await watcher.start();
  transport.emit(sessionEvent([decisionRequest()]));
  await settle();
  finish?.({ choice: "continue" });
  await answerStarted;
  let stopped = false;
  const stopping = watcher.stop().then(() => { stopped = true; });
  await Promise.resolve();
  assert.equal(stopped, false);
  releaseAnswer();
  await stopping;

  assert.deepEqual(transport.recorded.map((entry) => entry.operation), [
    "decision.answer",
  ]);
});

test("a decision snapshot arriving behind active consumption is drained", async () => {
  const transport = client();
  let presented = 0;
  const watcher = new WorkflowDecisionWatcher({
    client: transport,
    sessionId: "session-1",
    present: async () => {
      presented += 1;
      return undefined;
    },
  });

  await watcher.start();
  transport.emit(sessionEvent([]));
  transport.emit(sessionEvent([decisionRequest()]));
  await settle();

  assert.equal(presented, 1);
  assert.deepEqual(transport.recorded.map((entry) => entry.operation), []);
});

test("only one decision is presented at a time", async () => {
  const transport = client();
  let presented = 0;
  const watcher = new WorkflowDecisionWatcher({
    client: transport,
    sessionId: "session-1",
    present: () => {
      presented += 1;
      return new Promise(() => {});
    },
  });

  await watcher.start();
  transport.emit(sessionEvent([
    decisionRequest(),
    { ...decisionRequest(), requestId: "request-2" },
  ]));
  await settle();

  assert.equal(presented, 1);
});

test("the same answer retries under one key while a corrected answer does not", async () => {
  const keys: string[] = [];
  const transport = client({
    requestDurable: async (options) => {
      keys.push(options.idempotencyKey);
      return { outcome: "accepted" };
    },
  });
  const answers: DecisionAnswer[] = [
    { choice: "replan", input: { instructions: "first" } },
    { choice: "replan", input: { instructions: "first" } },
    { choice: "replan", input: { instructions: "corrected" } },
    { choice: "continue" },
  ];

  for (const answer of answers) {
    const watcher = new WorkflowDecisionWatcher({
      client: transport,
      sessionId: "session-1",
      present: async () => answer,
    });
    await watcher.start();
    transport.emit(sessionEvent([decisionRequest()]));
    await settle();
    await watcher.stop();
  }

  // A repeated answer reuses its key so the host adopts the first acceptance.
  assert.equal(keys[0], keys[1]);
  // A corrected instruction and a different choice are separate attempts.
  assert.notEqual(keys[1], keys[2]);
  assert.notEqual(keys[2], keys[3]);
});

test("the session view's run is reported alongside its decisions", async () => {
  const transport = client();
  const seen: unknown[] = [];
  const watcher = new WorkflowDecisionWatcher({
    client: transport,
    sessionId: "session-1",
    present: async () => undefined,
    onRun: (event) => seen.push(event),
  });
  await watcher.start();

  const event = { view: { pendingInteractions: [], run: { runId: "run-1" } } };
  transport.emit(event);
  await settle();

  assert.deepEqual(seen, [event]);
  await watcher.stop();
});

// The run observer is cosmetic; a decision is not. An observer that throws must
// not cost the operator the decision that arrived on the same event.
test("a throwing run observer does not stop the decision on that event", async () => {
  const transport = client();
  const errors: unknown[] = [];
  const presented: string[] = [];
  const watcher = new WorkflowDecisionWatcher({
    client: transport,
    sessionId: "session-1",
    present: async (decision) => {
      presented.push(decision.requestId);
      return { choice: "continue" };
    },
    onRun: () => {
      throw new Error("observer blew up");
    },
    onError: (error) => errors.push(error),
  });
  await watcher.start();

  transport.emit(sessionEvent([decisionRequest()]));
  await settle();

  assert.deepEqual(presented, ["request-1"]);
  assert.equal(errors.length, 1);
  await watcher.stop();
});

test("a watcher with no run observer works unchanged", async () => {
  const transport = client();
  const presented: string[] = [];
  const watcher = new WorkflowDecisionWatcher({
    client: transport,
    sessionId: "session-1",
    present: async (decision) => {
      presented.push(decision.requestId);
      return { choice: "continue" };
    },
  });
  await watcher.start();
  transport.emit(sessionEvent([decisionRequest()]));
  await settle();
  assert.deepEqual(presented, ["request-1"]);
  await watcher.stop();
});

test("a decision omitted by a bounded page can reappear at the same revision", async () => {
  const transport = client();
  let presentations = 0;
  const watcher = new WorkflowDecisionWatcher({
    client: transport,
    sessionId: "s",
    present: async (_decision, signal) => {
      presentations += 1;
      if (presentations === 1) {
        await new Promise<void>((resolve) => signal.addEventListener("abort", () => resolve(), { once: true }));
      }
      return undefined;
    },
  });
  await watcher.start();
  transport.emit(sessionEvent([decisionRequest()]));
  await settle();
  transport.emit(sessionEvent([]));
  await settle();
  transport.emit(sessionEvent([decisionRequest()]));
  await settle();
  assert.equal(presentations, 2);
  assert.deepEqual(transport.recorded, []);
  await watcher.stop();
});

// Observe the actual durable command without exporting the private key helper.
async function answerCommandKey(
  requestId: string,
  revision: number,
  answer: DecisionAnswer,
): Promise<string> {
  let key: string | undefined;
  let answered!: () => void;
  const completed = new Promise<void>((resolve) => { answered = resolve; });
  const transport = client({
    requestDurable: async (options) => {
      key = options.idempotencyKey;
      answered();
      return { outcome: "accepted" };
    },
  });
  const watcher = new WorkflowDecisionWatcher({
    client: transport,
    sessionId: "session-1",
    present: async () => answer,
  });
  try {
    await watcher.start();
    transport.emit(sessionEvent([{ ...decisionRequest(), requestId, revision }]));
    await completed;
  } finally {
    await watcher.stop();
  }
  if (key === undefined) throw new Error("decision answer was not submitted");
  return key;
}

test("answer commands separate delimiter-bearing identity tuples", async () => {
  const first = await answerCommandKey("a", 1, { choice: "2:b" });
  const second = await answerCommandKey("a:1", 2, { choice: "b" });
  assert.notEqual(first, second);
});

test("answer identities remain bounded and stable across watcher restarts", async () => {
  const requestId = "x".repeat(256);
  const answer = { choice: "replan", input: { instructions: "🦀".repeat(4096) } };
  const first = await answerCommandKey(requestId, 1, answer);
  const retry = await answerCommandKey(requestId, 1, structuredClone(answer));
  assert.equal(first, retry);
  assert.ok(Buffer.byteLength(first) > 0 && Buffer.byteLength(first) <= 256);
  const revised = await answerCommandKey(requestId, 2, answer);
  assert.notEqual(first, revised);
});
