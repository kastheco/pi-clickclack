import type { User, Workspace } from "@clickclack/sdk-ts";

import { createClickClackClient, type ClickClackBoundary } from "./clickclack.js";
import type { BridgeConfig } from "./config.js";
import { createLogger, environmentSecretValues, type Logger } from "./logger.js";
import { createEmbeddedPiRuntime, type EmbeddedPiRuntimeBoundary } from "./pi-runtime.js";
import { StateStore } from "./state/store.js";

export type BridgeServiceDependencies = {
  logger?: Logger;
  stateStore?: StateStore;
  clickClack?: ClickClackBoundary;
  piRuntime?: EmbeddedPiRuntimeBoundary;
};

export class BridgeService {
  readonly state: StateStore;
  readonly clickClack: ClickClackBoundary;
  readonly piRuntime: EmbeddedPiRuntimeBoundary;
  readonly logger: Logger;

  private started = false;
  private stopped = false;
  private identity?: User;
  private workspace?: Workspace;

  constructor(
    readonly config: BridgeConfig,
    dependencies: BridgeServiceDependencies = {},
  ) {
    this.logger = dependencies.logger ?? createLogger({
      secretValues: [config.clickClack.botToken, ...environmentSecretValues()],
    });
    this.state = dependencies.stateStore ?? new StateStore(config.statePath);
    this.clickClack = dependencies.clickClack ?? createClickClackClient(config);
    this.piRuntime = dependencies.piRuntime ?? createEmbeddedPiRuntime(config);
  }

  async start(): Promise<void> {
    if (this.stopped) throw new Error("cannot start a stopped bridge service");
    if (this.started) return;

    const [identity, workspace] = await Promise.all([
      this.clickClack.me(),
      this.clickClack.workspaces.get(this.config.clickClack.workspaceId),
    ]);
    if (identity.kind !== "bot") throw new Error("CLICKCLACK_BOT_TOKEN did not authenticate as a bot");
    if (workspace.id !== this.config.clickClack.workspaceId) {
      throw new Error("ClickClack returned the wrong configured workspace");
    }

    this.identity = identity;
    this.workspace = workspace;
    this.started = true;
    this.logger.info("bridge service started", {
      botUserId: identity.id,
      botHandle: identity.handle,
      workspaceId: workspace.id,
      projectAliases: [...this.config.projects.keys()],
      piRuntime: this.piRuntime.kind,
      sessionsStarted: 0,
    });
  }

  stop(): void {
    if (this.stopped) return;
    this.stopped = true;
    this.state.close();
    this.logger.info("bridge service stopped", {
      started: this.started,
      botUserId: this.identity?.id,
      workspaceId: this.workspace?.id,
    });
  }
}
