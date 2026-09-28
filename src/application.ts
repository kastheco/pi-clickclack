import type { BridgeConfig } from "./config.js";
import { BridgeService, type BridgeServiceDependencies } from "./service.js";

export type BridgeApplicationDependencies = BridgeServiceDependencies & {
  shutdownTimeoutMs?: number;
  forcedCleanupTimeoutMs?: number;
};

export type BridgeStopResult = "completed" | "failed" | "timed_out";

export type BridgeApplication = {
  service: BridgeService;
  stop(): Promise<BridgeStopResult>;
};

export function createBridgeApplication(
  config: BridgeConfig,
  dependencies: BridgeApplicationDependencies = {},
): BridgeApplication {
  const {
    shutdownTimeoutMs = 5_000,
    forcedCleanupTimeoutMs = 4_000,
    ...serviceDependencies
  } = dependencies;
  const service = new BridgeService(config, serviceDependencies);
  let stopTask: Promise<BridgeStopResult> | undefined;
  const stop = (): Promise<BridgeStopResult> => {
    stopTask ??= stopApplication();
    return stopTask;
  };

  return { service, stop };

  async function stopApplication(): Promise<BridgeStopResult> {
    service.stop();
    const cleanup = service.waitForStop();
    const graceful = await settlementWithin(cleanup, shutdownTimeoutMs);
    if (graceful === "timed_out") {
      service.logger.warn("bridge cleanup exceeded its shutdown deadline", { shutdownTimeoutMs });
    }
    if (graceful !== "timed_out") return graceful;

    const forced = await settlementWithin(cleanup, forcedCleanupTimeoutMs);
    if (forced === "timed_out") {
      service.logger.error("bridge cleanup remained stuck after its forced cleanup deadline", {
        forcedCleanupTimeoutMs,
      });
    }
    return forced;
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
