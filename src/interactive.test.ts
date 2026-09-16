import assert from "node:assert/strict";
import test from "node:test";

import { readInteractiveReply, renderInteractivePrompt } from "./interactive.js";

test("renders and parses confirmations without treating arbitrary chat as consent", () => {
  const request = { kind: "confirmation" as const, title: "Deploy?", message: "Ship the release." };
  assert.match(renderInteractivePrompt(request), /Reply `yes` or `no`/u);
  assert.deepEqual(readInteractiveReply(request, "yes"), { kind: "answer", value: true });
  assert.deepEqual(readInteractiveReply(request, "NO."), { kind: "answer", value: false });
  assert.equal(readInteractiveReply(request, "go ahead when ready").kind, "unmatched");
});

test("parses selections by one-based number or exact option", () => {
  const request = { kind: "selection" as const, title: "Choose", options: ["alpha", "Beta"] };
  assert.deepEqual(readInteractiveReply(request, "2"), { kind: "answer", value: "Beta" });
  assert.deepEqual(readInteractiveReply(request, "beta"), { kind: "answer", value: "Beta" });
  assert.equal(readInteractiveReply(request, "3").kind, "unmatched");
});

test("accepts free text and keeps cancellation distinct", () => {
  const request = { kind: "editor" as const, title: "Edit", prefill: "before" };
  assert.match(renderInteractivePrompt(request), /Current text/u);
  assert.deepEqual(readInteractiveReply(request, "after\ntext"), { kind: "answer", value: "after\ntext" });
  assert.deepEqual(readInteractiveReply(request, "/cancel"), { kind: "cancel" });
});
