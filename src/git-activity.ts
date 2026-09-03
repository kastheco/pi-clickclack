/**
 * Recognizes git invocations inside `bash` tool calls so they can be rendered
 * as something more readable than one more indistinguishable shell line.
 *
 * This only classifies and formats. It never gates: whether a git command is
 * allowed to run is a separate concern from making it visible.
 */

export type GitActivity = {
  /** Subcommand, e.g. "commit", "push", "status". */
  subcommand: string;
  /** Everything after the subcommand, normalized to single spaces. */
  rest: string;
  /** Repository the command targets, when `git -C <path>` names one. */
  repository?: string;
  /** True when the command changes repository or remote state. */
  mutating: boolean;
};

// Subcommands that write: to the working tree, the object store, refs, or a
// remote. Everything else is treated as inspection. Keeping this an explicit
// allowlist means an unfamiliar subcommand reads as non-mutating rather than
// being wrongly announced as a write.
const mutatingSubcommands = new Set([
  "add",
  "am",
  "apply",
  "branch",
  "checkout",
  "cherry-pick",
  "clean",
  "clone",
  "commit",
  "fetch",
  "init",
  "merge",
  "mv",
  "pull",
  "push",
  "rebase",
  "reset",
  "restore",
  "revert",
  "rm",
  "stash",
  "switch",
  "tag",
]);

// Options that appear before the subcommand and consume the following token.
const valueOptionsBeforeSubcommand = new Set(["-C", "-c", "--git-dir", "--work-tree", "--namespace"]);

/**
 * Splits a command line on whitespace while keeping quoted runs together.
 * This is not a shell parser; it exists so a quoted commit message does not
 * fragment into separate tokens.
 */
function tokenize(command: string): string[] {
  const tokens: string[] = [];
  let current = "";
  let quote: '"' | "'" | undefined;

  for (const char of command) {
    if (quote) {
      if (char === quote) quote = undefined;
      else current += char;
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      continue;
    }
    if (/\s/u.test(char)) {
      if (current) tokens.push(current);
      current = "";
      continue;
    }
    current += char;
  }
  if (current) tokens.push(current);
  return tokens;
}

/**
 * Splits a command line into separately executed segments.
 *
 * A single bash call often chains several commands, and the git one is
 * frequently not the first: `cd repo && git commit -m x`. Classifying only
 * the leading token would miss most real invocations.
 */
function segments(command: string): string[] {
  return command
    .split(/(?:&&|\|\||[;|\n])/gu)
    .map((segment) => segment.trim())
    .filter(Boolean);
}

function classifySegment(segment: string): GitActivity | undefined {
  const tokens = tokenize(segment);
  let index = 0;

  // Skip a leading environment assignment prefix, e.g. `GIT_AUTHOR_NAME=x git ...`.
  while (index < tokens.length && /^[A-Za-z_][A-Za-z0-9_]*=/u.test(tokens[index] ?? "")) index += 1;
  if (tokens[index] !== "git") return undefined;
  index += 1;

  let repository: string | undefined;
  while (index < tokens.length) {
    const token = tokens[index] ?? "";
    if (!token.startsWith("-")) break;

    const [flag, inlineValue] = token.includes("=")
      ? [token.slice(0, token.indexOf("=")), token.slice(token.indexOf("=") + 1)]
      : [token, undefined];

    if (valueOptionsBeforeSubcommand.has(flag)) {
      const value = inlineValue ?? tokens[index + 1];
      if (flag === "-C" && value) repository = value;
      index += inlineValue === undefined ? 2 : 1;
      continue;
    }
    index += 1;
  }

  const subcommand = tokens[index];
  if (!subcommand || subcommand.startsWith("-")) return undefined;

  const rest = tokens.slice(index + 1).join(" ");
  return {
    subcommand,
    rest,
    ...(repository ? { repository } : {}),
    mutating: mutatingSubcommands.has(subcommand),
  };
}

/**
 * Returns the git invocation in a command line, or undefined when there is
 * none. When a chained command runs several, the first mutating one wins so a
 * `git status && git commit` reads as the commit it performed.
 */
export function classifyGitCommand(command: string): GitActivity | undefined {
  const found = segments(command)
    .map(classifySegment)
    .filter((activity): activity is GitActivity => activity !== undefined);
  if (found.length === 0) return undefined;
  return found.find((activity) => activity.mutating) ?? found[0];
}

const maximumRestLength = 200;

/**
 * Formats a classified git invocation for a durable activity row.
 *
 * The subcommand leads so it is legible without expanding the preamble, which
 * is the entire point: a commit should not look like thirty reads.
 */
export function formatGitActivity(activity: GitActivity): string {
  const heading = activity.repository
    ? `**git ${activity.subcommand}** · ${activity.repository}`
    : `**git ${activity.subcommand}**`;
  const rest = activity.rest.replace(/\s+/gu, " ").trim().slice(0, maximumRestLength);
  return rest ? `${heading}\n\n${rest}` : heading;
}
