import { join } from "node:path";

import {
  type AgentSessionRuntime,
  type CreateAgentSessionRuntimeFactory,
  ModelRuntime,
  SessionManager,
  createAgentSessionFromServices,
  createAgentSessionRuntime,
  createAgentSessionServices,
  resolveCliModel,
} from "@earendil-works/pi-coding-agent";

import type { BridgeConfig, ProjectConfig } from "./config.js";
import { toProjectAlias } from "./types.js";

export type PiRuntimeRequest = {
  projectAlias: string;
  sessionFile?: string;
};

export type EmbeddedPiRuntimeBoundary = {
  readonly kind: "embedded-pi-sdk";
  project(projectAlias: string): ProjectConfig;
  createSessionRuntime(request: PiRuntimeRequest): Promise<AgentSessionRuntime>;
};

export const bridgeAppendSystemPrompt = [
  "Shell tools already execute in the pinned project's current working directory.",
  "Do not prepend `cd <project cwd> &&` to shell commands unless the command genuinely needs a different directory.",
].join(" ");

/**
 * Constructs the embedded SDK boundary only. No ModelRuntime, resource loader,
 * SessionManager, or AgentSession is created until createSessionRuntime is called
 * by a later routing issue.
 */
export function createEmbeddedPiRuntime(config: BridgeConfig): EmbeddedPiRuntimeBoundary {
  let modelRuntimePromise: Promise<ModelRuntime> | undefined;
  const sessionDirectory = join(config.pi.agentDir, "sessions");

  const project = (aliasValue: string): ProjectConfig => {
    const configured = config.projects.get(toProjectAlias(aliasValue));
    if (!configured) throw new Error(`unknown project alias ${aliasValue}`);
    return configured;
  };

  const modelRuntime = (): Promise<ModelRuntime> => {
    modelRuntimePromise ??= ModelRuntime.create({
      authPath: join(config.pi.agentDir, "auth.json"),
      modelsPath: join(config.pi.agentDir, "models.json"),
      modelsStorePath: join(config.pi.agentDir, "models-store.json"),
      allowModelNetwork: false,
    });
    return modelRuntimePromise;
  };

  return {
    kind: "embedded-pi-sdk",
    project,
    async createSessionRuntime(request): Promise<AgentSessionRuntime> {
      const selectedProject = project(request.projectAlias);
      const models = await modelRuntime();
      const resolved = resolveCliModel({
        cliModel: config.pi.model,
        cliThinking: config.pi.thinkingLevel,
        modelRuntime: models,
      });
      if (resolved.error || !resolved.model) {
        throw new Error(`configured Pi model could not be resolved: ${resolved.error ?? "model not found"}`);
      }
      const model = resolved.model;

      const initialSessionManager = request.sessionFile
        ? SessionManager.open(request.sessionFile, sessionDirectory)
        : SessionManager.create(selectedProject.cwd, sessionDirectory);
      if (request.sessionFile && initialSessionManager.getCwd() !== selectedProject.cwd) {
        throw new Error(`Pi session cwd does not match project alias ${request.projectAlias}`);
      }

      const createRuntime: CreateAgentSessionRuntimeFactory = async ({ cwd, sessionManager, sessionStartEvent }) => {
        if (cwd !== selectedProject.cwd) {
          throw new Error(`Pi runtime refused cwd outside project alias ${request.projectAlias}`);
        }
        const services = await createAgentSessionServices({
          cwd,
          agentDir: config.pi.agentDir,
          modelRuntime: models,
          resourceLoaderOptions: {
            appendSystemPrompt: [bridgeAppendSystemPrompt],
          },
        });
        return {
          ...(await createAgentSessionFromServices({
            services,
            sessionManager,
            ...(sessionStartEvent ? { sessionStartEvent } : {}),
            model,
            thinkingLevel: resolved.thinkingLevel ?? config.pi.thinkingLevel,
          })),
          services,
          diagnostics: services.diagnostics,
        };
      };

      return createAgentSessionRuntime(createRuntime, {
        cwd: selectedProject.cwd,
        agentDir: config.pi.agentDir,
        sessionManager: initialSessionManager,
      });
    },
  };
}
