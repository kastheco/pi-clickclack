import { WorkflowClient } from "@osolmaz/pi-workflows/client";

import type { WorkflowDecisionClient } from "./workflow-decisions.js";

export type ManagedWorkflowClient = WorkflowDecisionClient & {
  close(): Promise<void>;
};

export type WorkflowClientProvider = {
  get(): WorkflowDecisionClient | undefined;
  close(): Promise<void>;
};

/**
 * Owns the bridge process's one Pi Workflows client.
 *
 * The provider constructs on first get; durable publication calls get at service
 * startup to establish stable host identity. Construction does not start the host.
 * Watchers and persisted due publications may ensureAvailable and autostart it.
 */
export function createWorkflowClientProvider(
  createClient: () => ManagedWorkflowClient = createDefaultWorkflowClient,
): WorkflowClientProvider {
  let client: ManagedWorkflowClient | undefined;
  let closed = false;

  return {
    get() {
      if (closed) return undefined;
      client ??= createClient();
      return client;
    },
    async close() {
      if (closed) return;
      closed = true;
      const current = client;
      client = undefined;
      await current?.close();
    },
  };
}

function createDefaultWorkflowClient(): ManagedWorkflowClient {
  const client = new WorkflowClient({ clientId: "pi-clickclack" });
  return {
    clientId: client.clientId,
    hostIdentity: client.databasePath,
    ensureAvailable: async () => await client.ensureAvailable(),
    watchSession: async (sessionId, listener) =>
      await client.watchSession(sessionId, listener as Parameters<WorkflowClient["watchSession"]>[1]),
    request: async (options) =>
      await client.request(options as Parameters<WorkflowClient["request"]>[0]),
    requestDurable: async (options) =>
      await client.requestDurable(options as Parameters<WorkflowClient["requestDurable"]>[0]),
    close: async () => await client.close(),
  };
}
