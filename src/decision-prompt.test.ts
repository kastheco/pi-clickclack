import assert from "node:assert/strict";
import test from "node:test";

import {
  decisionTurnId,
  isDecisionTurnId,
  readDecisionReply,
  renderDecisionPrompt,
} from "./decision-prompt.js";
import type { ClaimedWorkflowDecision } from "./workflow-decisions.js";

function decision(): ClaimedWorkflowDecision {
  return {
    requestId: "request-1",
    runId: "run-1",
    revision: 3,
    title: "Approve the implementation plan",
    summary: "Review the implementation plan.",
    choices: [
      { key: "continue", label: "Yes, continue", expectsInput: false },
      { key: "stop", label: "No, stop", expectsInput: false },
      { key: "replan", label: "Replan", expectsInput: true },
    ],
  };
}

test("the prompt numbers every choice and marks the ones that take text", () => {
  const prompt = renderDecisionPrompt(decision());
  assert.match(prompt, /\*\*Approve the implementation plan\*\*/u);
  assert.match(prompt, /Review the implementation plan\./u);
  assert.match(prompt, /1\. Yes, continue$/mu);
  assert.match(prompt, /2\. No, stop$/mu);
  assert.match(prompt, /3\. Replan _\(reply with your answer after the number\)_/u);
});

test("a bare number answers a plain choice", () => {
  for (const body of ["1", "1.", "1)", " 2 "]) {
    const reply = readDecisionReply(decision(), body);
    assert.equal(reply.kind, "answer");
  }
  assert.deepEqual(readDecisionReply(decision(), "2"), {
    kind: "answer",
    answer: { choice: "stop" },
  });
});

test("a numbered choice that takes text carries the rest of the reply", () => {
  assert.deepEqual(readDecisionReply(decision(), "3 use the existing island"), {
    kind: "answer",
    answer: { choice: "replan", input: { instructions: "use the existing island" } },
  });
});

test("a text choice without any text is not an answer", () => {
  assert.deepEqual(readDecisionReply(decision(), "3"), { kind: "unmatched" });
});

test("an exact label or key answers a plain choice", () => {
  assert.deepEqual(readDecisionReply(decision(), "Yes, continue"), {
    kind: "answer",
    answer: { choice: "continue" },
  });
  assert.deepEqual(readDecisionReply(decision(), "stop"), {
    kind: "answer",
    answer: { choice: "stop" },
  });
});

test("a label match cannot answer a choice that needs text", () => {
  assert.deepEqual(readDecisionReply(decision(), "replan"), { kind: "unmatched" });
});

test("ordinary conversation is never read as an answer", () => {
  for (const body of ["", "what do you think?", "0", "9", "yes", "sounds good"]) {
    assert.deepEqual(readDecisionReply(decision(), body), { kind: "unmatched" }, body);
  }
});

test("an explicit dismissal leaves the decision pending", () => {
  for (const body of ["cancel", "Dismiss", "later", "SKIP"]) {
    assert.deepEqual(readDecisionReply(decision(), body), { kind: "dismissed" }, body);
  }
});

test("multiline instructions keep their body", () => {
  const reply = readDecisionReply(decision(), "3 rework the plan\nkeep the island");
  assert.deepEqual(reply, {
    kind: "answer",
    answer: { choice: "replan", input: { instructions: "rework the plan\nkeep the island" } },
  });
});

test("a decision turn is marked so the client can recognize it", () => {
  const turnId = decisionTurnId("request-1", 3);
  assert.equal(turnId, "decision:request-1:3");
  assert.equal(isDecisionTurnId(turnId), true);
});

test("an ordinary activity turn is not a decision", () => {
  for (const turnId of ["turn_abc", "", undefined]) {
    assert.equal(isDecisionTurnId(turnId), false, String(turnId));
  }
});

// Pins the bridge's marker against the copy ClickClack's web client matches on.
// The two sides live in separate repositories, so a silent rename here would
// leave the alert permanently quiet with both test suites still green.
test("the marker matches the prefix ClickClack detects", () => {
  assert.match(decisionTurnId("request-1", 3), /^decision:/u);
});
