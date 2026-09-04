import assert from "node:assert/strict";
import test from "node:test";

import {
  hasExternalWorkflowDecisionPresenter,
  registerExternalWorkflowDecisionPresenter,
} from "./workflow-presentation-authority.js";

test("external workflow presentation authority is process-local and reference counted", () => {
  assert.equal(hasExternalWorkflowDecisionPresenter(), false);
  const unregisterFirst = registerExternalWorkflowDecisionPresenter();
  const unregisterSecond = registerExternalWorkflowDecisionPresenter();
  assert.equal(hasExternalWorkflowDecisionPresenter(), true);

  unregisterFirst();
  unregisterFirst();
  assert.equal(hasExternalWorkflowDecisionPresenter(), true);

  unregisterSecond();
  assert.equal(hasExternalWorkflowDecisionPresenter(), false);
});
