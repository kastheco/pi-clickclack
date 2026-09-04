import type { BridgeConfig } from "./config.js";
import { BridgeService, type BridgeServiceDependencies } from "./service.js";
import {
  createWorkflowClientProvider,
  type ManagedWorkflowClient,
  type WorkflowClientProvider,
} from "./workflow-client-provider.js";
import { registerExternalWorkflowDecisionPresenter } from "./workflow-presentation-authority.js";

export type BridgeApplicationDependencies = BridgeServiceDependencies & {
  workflowClientFactory?: () => ManagedWorkflowClient;
  shutdownTimeoutMs?: number;
  forcedCleanupTimeoutMs?: number;
};

export type BridgeStopResult = "completed" | "failed" | "timed_out";

export type BridgeApplication = {
  service: BridgeService;
  workflowClients: WorkflowClientProvider;
  stop(): Promise<BridgeStopResult>;
};

/** Composes the production bridge with one lazy, process-owned workflow client. */
export function createBridgeApplication(
  config: BridgeConfig,
  dependencies: BridgeApplicationDependencies = {},
): BridgeApplication {
  const {
    workflowClientFactory,
    shutdownTimeoutMs = 5_000,
    forcedCleanupTimeoutMs = 4_000,
    ...serviceDependencies
  } = dependencies;
  const workflowClients = createWorkflowClientProvider(workflowClientFactory);
  const service = new BridgeService(config, {
    ...serviceDependencies,
    workflowClient: serviceDependencies.workflowClient ?? workflowClients.get,
  });
  const unregisterExternalPresenter = registerExternalWorkflowDecisionPresenter();
  let stopTask: Promise<BridgeStopResult> | undefined;
  const stop = (): Promise<BridgeStopResult> => {
    stopTask ??= stopApplication();
    return stopTask;
  };

  return { service, workflowClients, stop };

  async function stopApplication(): Promise<BridgeStopResult> {
    try {
      service.stop();
      const cleanup = service.waitForStop();
      const graceful = await settlementWithin(cleanup, shutdownTimeoutMs);
      if (graceful === "timed_out") {
        service.logger.warn("bridge cleanup exceeded its shutdown deadline", { shutdownTimeoutMs });
      }
      await workflowClients.close();
      if (graceful !== "timed_out") return graceful;

      const forced = await settlementWithin(cleanup, forcedCleanupTimeoutMs);
      if (forced === "timed_out") {
        service.logger.error("bridge cleanup remained stuck after closing the workflow client", {
          forcedCleanupTimeoutMs,
        });
      }
      return forced;
    } finally {
      unregisterExternalPresenter();
    }
  }
}

async function settlementWithin(
  task: Promise<void>,
  timeoutMs: number,
): Promise<BridgeStopResult> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      task.then(
        () => "completed" as const,
        () => "failed" as const,
      ),
      new Promise<"timed_out">((resolve) => {
        timer = setTimeout(() => resolve("timed_out"), Math.max(0, timeoutMs));
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
