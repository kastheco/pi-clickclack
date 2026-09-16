import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { basename, resolve } from "node:path";
import { promisify } from "node:util";

import type { TurnId } from "./types.js";

const execFileAsync = promisify(execFile);

export type GitAction = "commit" | "push" | "merge";
export type GitOutcome = "succeeded" | "failed";

// Compact tool-row classification retained for the existing inline activity
// stream. The durable channel publisher below intentionally handles only the
// high-signal commit/push/merge subset.
export type GitActivity = {
  subcommand: string;
  rest: string;
  repository?: string;
  mutating: boolean;
};

const mutatingSubcommands = new Set([
  "add", "am", "apply", "branch", "checkout", "cherry-pick", "clean", "clone",
  "commit", "fetch", "init", "merge", "mv", "pull", "push", "rebase", "reset",
  "restore", "revert", "rm", "stash", "switch", "tag",
]);

export type GitOperation = {
  action: GitAction;
  cwd: string;
};

export type GitActivityRecord = {
  v: 1;
  action: GitAction;
  outcome: GitOutcome;
  repository: {
    name: string;
    url?: string;
  };
  branch?: string;
  commit?: {
    sha: string;
    subject: string;
    url?: string;
  };
  project: string;
  session: {
    id: string;
    turnId: TurnId;
  };
  occurredAt: string;
};

export type GitActivityContext = {
  operation: GitOperation;
  outcome: GitOutcome;
  projectAlias: string;
  projectCwd: string;
  sessionId: string;
  turnId: TurnId;
};

export function classifyGitCommand(command: string): GitActivity | undefined {
  const found: GitActivity[] = [];
  for (const segment of splitShellSegments(command)) {
    const tokens = tokenizeShell(segment);
    const gitIndex = skipCommandPrefixes(tokens);
    if (tokens[gitIndex] !== "git") continue;
    let index = gitIndex + 1;
    let repository: string | undefined;
    while (index < tokens.length) {
      const token = tokens[index];
      if (!token || !token.startsWith("-")) break;
      if (token === "-C" && tokens[index + 1]) {
        repository = tokens[index + 1];
        index += 2;
        continue;
      }
      if (token.startsWith("-C") && token.length > 2) {
        repository = token.startsWith("-C=") ? token.slice(3) : token.slice(2);
      }
      if (["-c", "--config-env", "--exec-path", "--git-dir", "--work-tree", "--namespace"].includes(token)) index += 2;
      else index += 1;
    }
    const subcommand = tokens[index];
    if (!subcommand || subcommand.startsWith("-")) continue;
    found.push({
      subcommand,
      rest: tokens.slice(index + 1).join(" "),
      ...(repository ? { repository } : {}),
      mutating: mutatingSubcommands.has(subcommand),
    });
  }
  return found.find((activity) => activity.mutating) ?? found[0];
}

export function formatGitActivity(activity: GitActivity): string {
  const heading = activity.repository
    ? `**git ${activity.subcommand}** · ${activity.repository}`
    : `**git ${activity.subcommand}**`;
  const rest = activity.rest.replace(/\s+/gu, " ").trim().slice(0, 200);
  return rest ? `${heading}\n\n${rest}` : heading;
}

/**
 * Finds durable git actions inside a shell tool invocation.
 *
 * The scanner understands command chains, `cd`, `git -C`, and the common
 * `bash -lc "..."` wrapper. Read-only git commands and dry runs are ignored.
 */
export function classifyGitOperations(
  toolName: string,
  args: unknown,
  projectCwd: string,
): GitOperation[] {
  const command = commandFromArgs(args);
  if (!command || !isShellTool(toolName)) return [];
  return scanShell(command, projectCwd, 0);
}

/** Collects repository metadata after the git command has finished. */
export async function collectGitActivity(context: GitActivityContext): Promise<GitActivityRecord> {
  const root = await gitOutput(context.operation.cwd, ["rev-parse", "--show-toplevel"])
    ?? context.projectCwd;
  const [branch, sha, subject, remote] = await Promise.all([
    gitOutput(root, ["branch", "--show-current"]),
    gitOutput(root, ["rev-parse", "HEAD"]),
    gitOutput(root, ["log", "-1", "--format=%s"]),
    gitOutput(root, ["remote", "get-url", "origin"]),
  ]);
  const repositoryUrl = remote ? repositoryWebUrl(remote) : undefined;
  const commit = context.outcome === "succeeded" && sha
    ? {
        sha,
        subject: subject ?? "",
        ...(repositoryUrl ? { url: commitWebUrl(repositoryUrl, sha) } : {}),
      }
    : undefined;

  return {
    v: 1,
    action: context.operation.action,
    outcome: context.outcome,
    repository: {
      name: basename(root),
      ...(repositoryUrl ? { url: repositoryUrl } : {}),
    },
    ...(branch ? { branch } : {}),
    ...(commit ? { commit } : {}),
    project: context.projectAlias,
    session: { id: context.sessionId, turnId: context.turnId },
    occurredAt: new Date().toISOString(),
  };
}

/** Renders a human fallback followed by a machine-readable ClickClack block. */
export function renderGitActivity(record: GitActivityRecord): string {
  const repository = record.repository.url
    ? `[${record.repository.name}](${record.repository.url})`
    : `\`${record.repository.name}\``;
  const context = [repository, record.branch ? `\`${record.branch}\`` : undefined]
    .filter(Boolean)
    .join(" · ");
  const commit = record.commit
    ? `${record.commit.url ? `[\`${record.commit.sha.slice(0, 7)}\`](${record.commit.url})` : `\`${record.commit.sha.slice(0, 7)}\``}${record.commit.subject ? ` ${record.commit.subject}` : ""}`
    : undefined;
  return [
    `**git ${record.action} ${record.outcome}**`,
    context,
    commit,
    `session \`${shortSession(record.session.id)}\` · project \`${record.project}\``,
    "",
    "```clickclack-git-activity",
    JSON.stringify(record),
    "```",
  ].filter((line) => line !== undefined).join("\n");
}

export function gitActivityNonce(
  sessionId: string,
  toolCallId: string,
  actionIndex: number,
): string {
  return createHash("sha256")
    .update(`pi-clickclack:git:${sessionId}:${toolCallId}:${actionIndex}`)
    .digest("hex")
    .slice(0, 32);
}

function commandFromArgs(args: unknown): string | undefined {
  if (!args || typeof args !== "object") return undefined;
  const value = (args as Record<string, unknown>).command;
  return typeof value === "string" ? value : undefined;
}

function isShellTool(toolName: string): boolean {
  const normalized = toolName.toLowerCase();
  return normalized === "bash" || normalized === "shell" || normalized === "exec" || normalized === "run_in_terminal";
}

function scanShell(command: string, initialCwd: string, depth: number): GitOperation[] {
  if (depth > 2) return [];
  let cwd = initialCwd;
  const operations: GitOperation[] = [];
  for (const segment of splitShellSegments(command)) {
    const tokens = tokenizeShell(segment);
    if (tokens.length === 0) continue;
    const executableIndex = skipCommandPrefixes(tokens);
    const executable = tokens[executableIndex]?.split("/").at(-1)?.toLowerCase();
    if (executable === "cd") {
      const target = tokens[executableIndex + 1];
      if (target && target !== "-") cwd = resolve(cwd, target.replace(/^~(?=\/|$)/u, process.env.HOME ?? "~"));
      continue;
    }
    if (["bash", "sh", "zsh"].includes(executable ?? "")) {
      const commandIndex = tokens.findIndex((token, index) => index > executableIndex && /^-[^-]*c[^-]*$/u.test(token));
      const nested = commandIndex >= 0 ? tokens[commandIndex + 1] : undefined;
      if (nested) operations.push(...scanShell(nested, cwd, depth + 1));
      continue;
    }
    if (executable !== "git") continue;
    const parsed = parseGit(tokens.slice(executableIndex + 1), cwd);
    if (parsed) operations.push(parsed);
  }
  return operations;
}

function parseGit(args: string[], initialCwd: string): GitOperation | undefined {
  let cwd = initialCwd;
  let index = 0;
  while (index < args.length) {
    const token = args[index];
    if (!token) break;
    const next = args[index + 1];
    if (token === "-C" && next) {
      cwd = resolve(cwd, next);
      index += 2;
      continue;
    }
    if (token.startsWith("-C") && token.length > 2) {
      cwd = resolve(cwd, token.startsWith("-C=") ? token.slice(3) : token.slice(2));
      index += 1;
      continue;
    }
    if (["-c", "--config-env", "--exec-path", "--git-dir", "--work-tree", "--namespace"].includes(token)) {
      index += 2;
      continue;
    }
    if (token.startsWith("-")) {
      index += 1;
      continue;
    }
    break;
  }
  const action = args[index]?.toLowerCase();
  const actionArgs = args.slice(index + 1);
  if (action !== "commit" && action !== "push" && action !== "merge") return undefined;
  if (actionArgs.includes("--dry-run") || (action === "push" && actionArgs.includes("-n"))) return undefined;
  if (action === "merge" && actionArgs.includes("--abort")) return undefined;
  return { action, cwd };
}

function skipCommandPrefixes(tokens: string[]): number {
  let index = 0;
  if (tokens[index] === "sudo") index += 1;
  if (tokens[index] === "env") index += 1;
  while (index < tokens.length && /^[A-Za-z_][A-Za-z0-9_]*=/u.test(tokens[index] ?? "")) index += 1;
  return index;
}

function splitShellSegments(command: string): string[] {
  const segments: string[] = [];
  let current = "";
  let quote: "'" | '"' | undefined;
  let escaped = false;
  for (let index = 0; index < command.length; index += 1) {
    const character = command[index];
    if (escaped) {
      current += character;
      escaped = false;
      continue;
    }
    if (character === "\\" && quote !== "'") {
      current += character;
      escaped = true;
      continue;
    }
    if (character === "'" || character === '"') {
      if (quote === character) quote = undefined;
      else if (!quote) quote = character;
      current += character;
      continue;
    }
    if (!quote && (character === ";" || character === "\n" || character === "|" || character === "&")) {
      if (current.trim()) segments.push(current.trim());
      current = "";
      if ((character === "|" || character === "&") && command[index + 1] === character) index += 1;
      continue;
    }
    current += character;
  }
  if (current.trim()) segments.push(current.trim());
  return segments;
}

function tokenizeShell(command: string): string[] {
  const tokens: string[] = [];
  let current = "";
  let quote: "'" | '"' | undefined;
  let escaped = false;
  const flush = () => {
    if (current) tokens.push(current);
    current = "";
  };
  for (const character of command) {
    if (escaped) {
      current += character;
      escaped = false;
      continue;
    }
    if (character === "\\" && quote !== "'") {
      escaped = true;
      continue;
    }
    if (character === "'" || character === '"') {
      if (quote === character) quote = undefined;
      else if (!quote) quote = character;
      else current += character;
      continue;
    }
    if (!quote && /\s/u.test(character)) {
      flush();
      continue;
    }
    current += character;
  }
  flush();
  return tokens;
}

async function gitOutput(cwd: string, args: string[]): Promise<string | undefined> {
  try {
    const { stdout } = await execFileAsync("git", ["-C", cwd, ...args], {
      encoding: "utf8",
      timeout: 5_000,
      maxBuffer: 1024 * 1024,
    });
    return stdout.trim() || undefined;
  } catch {
    return undefined;
  }
}

function repositoryWebUrl(remote: string): string | undefined {
  const trimmed = remote.trim().replace(/\.git$/u, "");
  const scp = trimmed.match(/^git@([^:]+):(.+)$/u);
  if (scp) return `https://${scp[1]}/${scp[2]}`;
  try {
    const url = new URL(trimmed);
    if (url.protocol === "http:" || url.protocol === "https:") {
      url.username = "";
      url.password = "";
      url.search = "";
      url.hash = "";
      return url.toString().replace(/\/$/u, "");
    }
    if (url.protocol === "ssh:") return `https://${url.hostname}${url.pathname}`.replace(/\/$/u, "");
  } catch {
    return undefined;
  }
  return undefined;
}

function commitWebUrl(repositoryUrl: string, sha: string): string {
  const url = new URL(repositoryUrl);
  return url.hostname.toLowerCase().includes("gitlab")
    ? `${repositoryUrl}/-/commit/${sha}`
    : `${repositoryUrl}/commit/${sha}`;
}

function shortSession(sessionId: string): string {
  return sessionId.length > 16 ? `${sessionId.slice(0, 8)}…${sessionId.slice(-6)}` : sessionId;
}
