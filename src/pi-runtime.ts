import { join } from "node:path";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";

import {
  type AgentSessionRuntime,
  type CreateAgentSessionRuntimeFactory,
  ModelRuntime,
  SessionManager,
  createAgentSessionFromServices,
  createAgentSessionRuntime,
  createAgentSessionServices,
  initTheme,
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
  "Before each tool batch, tell the user what you found and what you are doing next in one or two short prose paragraphs.",
  "Write these progress updates as natural commentary, like a direct Pi session. Do not use terse status headings or narrate every individual tool call.",
  "When you create a user-facing artifact with the write tool, mention its project-relative path in the final answer so ClickClack can attach it.",
].join(" ");

// ClickClack bridges extension dialogs after the runtime is bound, but it does
// not expose the model-callable question tool. Exclude that tool before prompt
// construction so another extension cannot capture a stale prompt override.
export const bridgeExcludedTools: string[] = ["ask_user_question"];

export function loadBridgeSystemPrompts(
  voiceProfilePath = join(homedir(), ".config", "unslop", "kas-voice-profile.md"),
): string[] {
  let profile: string;
  try {
    profile = readFileSync(voiceProfilePath, "utf8");
  } catch (cause) {
    throw new Error(`Could not load the bridge voice profile: ${voiceProfilePath}`, { cause });
  }
  if (!profile.trim()) throw new Error(`Bridge voice profile is empty: ${voiceProfilePath}`);
  return [
    bridgeAppendSystemPrompt,
    "The user's standing voice profile is already loaded below. Apply it from the first reply; "
      + "no separate file-read tool call is required. Preserve its distinction between chat and document registers.\n\n"
      + profile,
  ];
}

/**
 * Constructs the embedded SDK boundary only. No ModelRuntime, resource loader,
 * SessionManager, or AgentSession is created until createSessionRuntime is called
 * by a later routing issue.
 */
export function createEmbeddedPiRuntime(config: BridgeConfig): EmbeddedPiRuntimeBoundary {
  // The CLI initializes this global before loading extensions. Embedded SDK hosts
  // must do it themselves, including in headless mode, or connector UIs throw
  // "Theme not initialized" before exposing their tools.
  initTheme(undefined, false);

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
            appendSystemPrompt: loadBridgeSystemPrompts(),
          },
        });
        return {
          ...(await createAgentSessionFromServices({
            services,
            sessionManager,
            excludeTools: bridgeExcludedTools,
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
