import { ClickClackClient } from "@clickclack/sdk-ts";

import type { BridgeConfig } from "./config.js";

export type ClickClackBoundary = Pick<
  ClickClackClient,
  "me" | "workspaces" | "bots" | "messages" | "uploads" | "channels" | "dms" | "events"
>;

export function createClickClackClient(config: BridgeConfig): ClickClackClient {
  return new ClickClackClient({
    baseUrl: config.clickClack.baseUrl,
    token: config.clickClack.botToken,
  });
}
