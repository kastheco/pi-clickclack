import assert from "node:assert/strict";
import test from "node:test";

import { createWorkflowClientProvider, type ManagedWorkflowClient } from "./workflow-client-provider.js";

function fakeClient(onClose: () => void): ManagedWorkflowClient {
  return {
    clientId: "test-client",
    ensureAvailable: async () => ({}) as never,
    watchSession: async () => async () => undefined,
    request: async () => ({ outcome: "accepted" }),
    requestDurable: async () => ({ outcome: "accepted" }),
    close: async () => onClose(),
  };
}

test("default provider creates the dedicated production client without starting the host", async () => {
  const provider = createWorkflowClientProvider();
  assert.equal(provider.get()?.clientId, "pi-clickclack");
  await provider.close();
});

test("workflow client provider is lazy, shared, and closed once", async () => {
  let created = 0;
  let closed = 0;
  const provider = createWorkflowClientProvider(() => {
    created += 1;
    return fakeClient(() => { closed += 1; });
  });

  assert.equal(created, 0);
  const first = provider.get();
  assert.equal(created, 1);
  assert.equal(provider.get(), first);
  assert.equal(created, 1);

  await provider.close();
  await provider.close();
  assert.equal(closed, 1);
  assert.equal(provider.get(), undefined);
  assert.equal(created, 1);
});
