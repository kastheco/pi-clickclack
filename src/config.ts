import { statSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, resolve } from "node:path";

import * as v from "valibot";

import {
  conversationTypes,
  invocationModes,
  toConversationId,
  toProjectAlias,
  type ConversationId,
  type ConversationType,
  type InvocationMode,
  type ProjectAlias,
} from "./types.js";

export const thinkingLevels = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;
export type ThinkingLevel = (typeof thinkingLevels)[number];

export type ProjectConfig = {
  alias: ProjectAlias;
  cwd: string;
};

export type InvocationBindingConfig = {
  conversationType: ConversationType;
  conversationId: ConversationId;
  mode: InvocationMode;
};

export type BridgeConfig = {
  clickClack: {
    baseUrl: string;
    workspaceId: string;
    botToken: string;
    ownerIds: readonly string[];
  };
  projects: ReadonlyMap<ProjectAlias, ProjectConfig>;
  invocationBindings: readonly InvocationBindingConfig[];
  pi: {
    model: string;
    thinkingLevel: ThinkingLevel;
    agentDir: string;
  };
  statePath: string;
};

export class ConfigurationError extends Error {
  readonly issues: readonly string[];

  constructor(issues: readonly string[]) {
    super(`invalid bridge configuration:\n${issues.map((issue) => `- ${issue}`).join("\n")}`);
    this.name = "ConfigurationError";
    this.issues = issues;
  }
}

type Environment = Readonly<Record<string, string | undefined>>;

const requiredString = v.pipe(v.string(), v.trim(), v.nonEmpty("is required"));
const projectSchema = v.strictObject({
  alias: v.pipe(v.string(), v.trim(), v.regex(/^[a-z][a-z0-9-]{0,62}$/u, "must be a lowercase alias")),
  cwd: requiredString,
});
const invocationSchema = v.strictObject({
  conversationType: v.picklist(conversationTypes),
  conversationId: requiredString,
  mode: v.picklist(invocationModes),
});

export function loadConfig(environment: Environment = process.env): BridgeConfig {
  const issues: string[] = [];
  const required = (name: string): string => {
    const value = environment[name]?.trim();
    if (!value) issues.push(`${name} is required`);
    return value ?? "";
  };

  const rawUrl = required("CLICKCLACK_URL");
  const workspaceId = required("CLICKCLACK_WORKSPACE_ID");
  const botToken = required("CLICKCLACK_BOT_TOKEN");
  const model = required("CLICKCLACK_PI_MODEL");

  const baseUrl = parseBaseUrl(rawUrl, issues);
  const ownerIds = parseOwnerIds(required("CLICKCLACK_OWNER_IDS"), issues);
  const projects = parseProjects(required("CLICKCLACK_PI_PROJECTS"), issues);
  const invocationBindings = parseInvocationBindings(
    environment.CLICKCLACK_PI_INVOCATIONS?.trim() || "[]",
    issues,
  );

  const thinkingRaw = environment.CLICKCLACK_PI_THINKING_LEVEL?.trim() || "medium";
  const thinkingResult = v.safeParse(v.picklist(thinkingLevels), thinkingRaw);
  if (!thinkingResult.success) {
    issues.push(`CLICKCLACK_PI_THINKING_LEVEL must be one of ${thinkingLevels.join(", ")}`);
  }

  if (/\s/u.test(model)) issues.push("CLICKCLACK_PI_MODEL must not contain whitespace");
  if (botToken && !botToken.startsWith("ccb_")) {
    issues.push("CLICKCLACK_BOT_TOKEN must be a ClickClack bot token");
  }

  const statePath = absolutePath(
    "CLICKCLACK_PI_STATE_PATH",
    environment.CLICKCLACK_PI_STATE_PATH?.trim() || resolve(homedir(), ".local/state/pi-clickclack/state.sqlite"),
    issues,
    false,
  );
  const agentDir = absolutePath(
    "CLICKCLACK_PI_AGENT_DIR",
    environment.CLICKCLACK_PI_AGENT_DIR?.trim() || resolve(homedir(), ".pi/agent"),
    issues,
    true,
  );

  if (issues.length > 0 || !thinkingResult.success) throw new ConfigurationError(issues);

  return {
    clickClack: {
      baseUrl,
      workspaceId,
      botToken,
      ownerIds,
    },
    projects,
    invocationBindings,
    pi: {
      model,
      thinkingLevel: thinkingResult.output,
      agentDir,
    },
    statePath,
  };
}

function parseBaseUrl(raw: string, issues: string[]): string {
  if (!raw) return "";
  try {
    const url = new URL(raw);
    if (url.protocol !== "http:" && url.protocol !== "https:") {
      issues.push("CLICKCLACK_URL must use http or https");
    }
    if (url.username || url.password) issues.push("CLICKCLACK_URL must not contain credentials");
    if (url.search || url.hash) issues.push("CLICKCLACK_URL must not contain a query or fragment");
    return url.toString().replace(/\/+$/u, "");
  } catch {
    issues.push("CLICKCLACK_URL must be a valid absolute URL");
    return "";
  }
}

function parseOwnerIds(raw: string, issues: string[]): readonly string[] {
  const owners = raw.split(",").map((owner) => owner.trim()).filter(Boolean);
  if (owners.length === 0) issues.push("CLICKCLACK_OWNER_IDS must contain at least one owner ID");
  if (new Set(owners).size !== owners.length) issues.push("CLICKCLACK_OWNER_IDS contains duplicate owner IDs");
  return owners;
}

function parseProjects(raw: string, issues: string[]): ReadonlyMap<ProjectAlias, ProjectConfig> {
  const parsed = parseJson("CLICKCLACK_PI_PROJECTS", raw, issues);
  const result = v.safeParse(v.array(projectSchema), parsed);
  if (!result.success) {
    issues.push(...formatValidationIssues("CLICKCLACK_PI_PROJECTS", result.issues));
    return new Map();
  }
  if (result.output.length === 0) issues.push("CLICKCLACK_PI_PROJECTS must contain at least one project");

  const projects = new Map<ProjectAlias, ProjectConfig>();
  for (const project of result.output) {
    const alias = toProjectAlias(project.alias);
    if (projects.has(alias)) {
      issues.push(`CLICKCLACK_PI_PROJECTS contains duplicate alias ${project.alias}`);
      continue;
    }
    const cwd = absolutePath(`project ${project.alias} cwd`, project.cwd, issues, true);
    projects.set(alias, { alias, cwd });
  }
  return projects;
}

function parseInvocationBindings(raw: string, issues: string[]): readonly InvocationBindingConfig[] {
  const parsed = parseJson("CLICKCLACK_PI_INVOCATIONS", raw, issues);
  const result = v.safeParse(v.array(invocationSchema), parsed);
  if (!result.success) {
    issues.push(...formatValidationIssues("CLICKCLACK_PI_INVOCATIONS", result.issues));
    return [];
  }

  const seen = new Set<string>();
  const bindings: InvocationBindingConfig[] = [];
  for (const binding of result.output) {
    const key = `${binding.conversationType}:${binding.conversationId}`;
    if (seen.has(key)) {
      issues.push(`CLICKCLACK_PI_INVOCATIONS contains duplicate conversation ${key}`);
      continue;
    }
    seen.add(key);
    if (binding.conversationType === "channel" && binding.mode === "auto") {
      issues.push(`CLICKCLACK_PI_INVOCATIONS ${key} must use mention or always mode`);
      continue;
    }
    if (binding.conversationType === "direct" && binding.mode !== "auto") {
      issues.push(`CLICKCLACK_PI_INVOCATIONS ${key} must use auto mode`);
      continue;
    }
    bindings.push({
      conversationType: binding.conversationType,
      conversationId: toConversationId(binding.conversationId),
      mode: binding.mode,
    });
  }
  return bindings;
}

function parseJson(name: string, raw: string, issues: string[]): unknown {
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    issues.push(`${name} must be valid JSON`);
    return [];
  }
}

function absolutePath(name: string, path: string, issues: string[], mustBeDirectory: boolean): string {
  if (!isAbsolute(path)) {
    issues.push(`${name} must be an absolute path`);
    return path;
  }
  if (mustBeDirectory) {
    try {
      if (!statSync(path).isDirectory()) issues.push(`${name} must point to a directory`);
    } catch {
      issues.push(`${name} must point to an existing directory`);
    }
  }
  return path;
}

function formatValidationIssues(name: string, validationIssues: readonly v.BaseIssue<unknown>[]): string[] {
  return validationIssues.map((issue) => {
    const path = issue.path?.map((item) => String(item.key)).join(".");
    return `${name}${path ? `.${path}` : ""} ${issue.message}`;
  });
}
