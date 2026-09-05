import { ClickClackClient } from "@clickclack/sdk-ts";

import type { BridgeConfig } from "./config.js";

export type ClickClackBoundary = Pick<
  ClickClackClient,
  "me" | "workspaces" | "bots" | "messages" | "uploads" | "channels" | "dms" | "events"
> & Partial<Pick<ClickClackClient, "workflowRuns">>;

export function createClickClackClient(config: BridgeConfig): ClickClackClient {
  return new ClickClackClient({
    baseUrl: config.clickClack.baseUrl,
    token: config.clickClack.botToken,
    // Durable retries must not be stranded behind an indefinitely hung request.
    // Leave all existing chat/decision transport behavior unchanged.
    fetch: (input, init) => {
      const url = new URL(typeof input === "string" || input instanceof URL ? input : input.url);
      if (url.pathname !== "/api/workflow-runs") return fetch(input, init);
      const timeout = AbortSignal.timeout(15_000);
      const signal = init?.signal ? AbortSignal.any([init.signal, timeout]) : timeout;
      return fetch(input, { ...init, signal });
    },
  });
}
