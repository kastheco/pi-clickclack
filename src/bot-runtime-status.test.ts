import assert from "node:assert/strict";
import test from "node:test";

import { fastModeFromBetterOpenAIStatus } from "./bot-runtime-status.js";

test("reads fast mode from pi-better-openai status text", () => {
  assert.equal(fastModeFromBetterOpenAIStatus("gpt-5.6 fast · 5h 42%"), true);
  assert.equal(fastModeFromBetterOpenAIStatus("gpt-5.6 · 5h 42%"), false);
  assert.equal(fastModeFromBetterOpenAIStatus("fast"), true);
  assert.equal(fastModeFromBetterOpenAIStatus(undefined), null);
  assert.equal(fastModeFromBetterOpenAIStatus("breakfast · 5h 42%"), false);
});
