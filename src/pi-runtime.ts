import { join } from "node:path";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";

import {
  createAgentSession,
  SessionManager,
  type AgentSession,
  type CreateAgentSessionOptions,
  type ExtensionUIContext,
  type FileEntry,
} from "@oh-my-pi/pi-coding-agent";

import type { BridgeConfig, ProjectConfig } from "./config.js";
import { toProjectAlias } from "./types.js";

const toolUISetters = new WeakMap<AgentSession, (context: ExtensionUIContext, hasUI: boolean) => void>();

export function setSessionToolUIContext(session: AgentSession, context: ExtensionUIContext, hasUI: boolean): void {
  toolUISetters.get(session)?.(context, hasUI);
}

export type PiRuntimeRequest = { projectAlias: string; sessionFile?: string; forkEntries?: FileEntry[] };
export type EmbeddedPiRuntimeBoundary = { readonly kind: "embedded-omp-sdk"; project(projectAlias: string): ProjectConfig; createSessionRuntime(request: PiRuntimeRequest): Promise<AgentSession> };

export const bridgeAppendSystemPrompt = [
  "Shell tools already execute in the pinned project's current working directory.",
  "Do not prepend `cd <project cwd> &&` to shell commands unless the command genuinely needs a different directory.",
  "Before each tool batch, tell the user what you found and what you are doing next in one or two short prose paragraphs.",
  "Write these progress updates as natural commentary, like a direct coding-agent session. Do not use terse status headings or narrate every individual tool call.",
  "When you create a user-facing artifact with the write tool, mention its project-relative path in the final answer so ClickClack can attach it.",
].join(" ");
export function loadBridgeSystemPrompts(voiceProfilePath = join(homedir(), ".config", "unslop", "kas-voice-profile.md")): string[] {
  let profile: string;
  try { profile = readFileSync(voiceProfilePath, "utf8"); }
  catch (cause) { throw new Error(`Could not load the bridge voice profile: ${voiceProfilePath}`, { cause }); }
  if (!profile.trim()) throw new Error(`Bridge voice profile is empty: ${voiceProfilePath}`);
  return [bridgeAppendSystemPrompt, "The user's standing voice profile is already loaded below. Apply it from the first reply; no separate file-read tool call is required. Preserve its distinction between chat and document registers.\n\n" + profile];
}

export function createEmbeddedPiRuntime(config: BridgeConfig): EmbeddedPiRuntimeBoundary {
  process.env.PI_CODING_AGENT_DIR = config.pi.agentDir;
  const project = (aliasValue: string): ProjectConfig => {
    const configured = config.projects.get(toProjectAlias(aliasValue));
    if (!configured) throw new Error(`unknown project alias ${aliasValue}`);
    return configured;
  };
  const sessionDirectory = join(config.pi.agentDir, "sessions");
  return {
    kind: "embedded-omp-sdk",
    project,
    async createSessionRuntime(request): Promise<AgentSession> {
      const selectedProject = project(request.projectAlias);
      const sessionManager = request.forkEntries
        ? SessionManager.inMemory(selectedProject.cwd)
        : request.sessionFile
          ? await SessionManager.open(request.sessionFile, sessionDirectory)
          : SessionManager.create(selectedProject.cwd, sessionDirectory);
      if (request.sessionFile && sessionManager.getCwd() !== selectedProject.cwd) throw new Error(`omp session cwd does not match project alias ${request.projectAlias}`);
      if (request.forkEntries) {
        for (const entry of request.forkEntries) if (entry.type === "message") sessionManager.appendMessage(entry.message as never);
      }
      const result = await createAgentSession({
        cwd: selectedProject.cwd,
        agentDir: config.pi.agentDir,
        sessionManager,
        modelPattern: config.pi.model,
        // The configured literals match OMP Effort values; its string enum is nominal in TypeScript.
        thinkingLevel: config.pi.thinkingLevel as NonNullable<CreateAgentSessionOptions["thinkingLevel"]>,
        disableExtensionDiscovery: true,
        additionalExtensionPaths: [...(config.pi.extensionPaths ?? [])],
        appendSystemPrompt: loadBridgeSystemPrompts().join("\n\n"),
        hasUI: false,
        interactivePrompts: true,
      });
      toolUISetters.set(result.session, result.setToolUIContext);
      return result.session;
    },
  };
}
