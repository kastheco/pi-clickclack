import assert from "node:assert/strict";
import test from "node:test";

import type { ClickClackBoundary } from "./clickclack.js";
import type { BridgeConfig, ProjectConfig } from "./config.js";
import { createLogger } from "./logger.js";
import type { EmbeddedPiRuntimeBoundary } from "./pi-runtime.js";
import { BridgeService } from "./service.js";
import { StateStore } from "./state/store.js";
import { toProjectAlias } from "./types.js";

test("service authenticates, starts no Pi sessions, and closes state cleanly", async () => {
  const alias = toProjectAlias("main");
  const project: ProjectConfig = { alias, cwd: "/tmp" };
  const config: BridgeConfig = {
    clickClack: {
      baseUrl: "https://clickclack.example.test",
      workspaceId: "wsp_test",
      botToken: "ccb_secret",
      ownerIds: ["usr_owner"],
    },
    projects: new Map([[alias, project]]),
    invocationBindings: [],
    pi: {
      model: "provider/model",
      thinkingLevel: "medium",
      agentDir: "/tmp",
    },
    statePath: ":memory:",
  };
  const clickClack = {
    me: async () => ({
      id: "usr_bot",
      kind: "bot" as const,
      display_name: "Bridge",
      handle: "bridge",
      avatar_url: "",
      created_at: "2026-01-01T00:00:00Z",
    }),
    workspaces: {
      get: async () => ({
        id: "wsp_test",
        route_id: "W1",
        name: "Test",
        slug: "test",
        icon_url: "",
        created_at: "2026-01-01T00:00:00Z",
      }),
    },
  } as unknown as ClickClackBoundary;
  let sessionsCreated = 0;
  const piRuntime: EmbeddedPiRuntimeBoundary = {
    kind: "embedded-pi-sdk",
    project: () => project,
    createSessionRuntime: async () => {
      sessionsCreated += 1;
      throw new Error("not used in KAS-732");
    },
  };
  const stateStore = new StateStore(":memory:");
  const lines: string[] = [];
  const service = new BridgeService(config, {
    clickClack,
    piRuntime,
    stateStore,
    logger: createLogger({ sink: (line) => lines.push(line) }),
  });

  await service.start();
  assert.equal(sessionsCreated, 0);
  assert.match(lines.join("\n"), /"sessionsStarted":0/u);
  service.stop();
  assert.throws(() => stateStore.database.prepare("SELECT 1"), /not open|closed/u);
});
