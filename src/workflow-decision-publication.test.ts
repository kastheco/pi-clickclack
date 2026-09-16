import assert from "node:assert/strict";
import test from "node:test";
import { decisionPublicationNonce } from "./workflow-decision-publication.js";
const source = { hostIdentity: "host", producerId: "bot", workspaceId: "w", targetType: "channel", targetId: "c", decision: {runId:"r",requestId:"q",revision:1} };
test("publication nonce survives reconnect and isolates producer, host, target and revision", () => {
  const nonce = decisionPublicationNonce(source);
  assert.equal(nonce,decisionPublicationNonce(structuredClone(source)));
  assert.equal(nonce.length,76);
  for (const key of ["hostIdentity","producerId","workspaceId","targetType","targetId"] as const) assert.notEqual(nonce,decisionPublicationNonce({...source,[key]:"different"}));
  for (const key of ["runId","requestId"] as const) assert.notEqual(nonce,decisionPublicationNonce({...source,decision:{...source.decision,[key]:"different"}}));
  assert.notEqual(nonce,decisionPublicationNonce({...source,decision:{...source.decision,revision:2}}));
});
