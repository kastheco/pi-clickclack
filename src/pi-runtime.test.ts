import assert from "node:assert/strict";
import test from "node:test";

import { bridgeAppendSystemPrompt } from "./pi-runtime.js";

test("bridge tells Pi that shell tools already use the pinned project cwd", () => {
  assert.match(bridgeAppendSystemPrompt, /already execute in the pinned project's current working directory/u);
  assert.match(bridgeAppendSystemPrompt, /Do not prepend `cd <project cwd> &&`/u);
});
