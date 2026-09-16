import assert from "node:assert/strict";
import test from "node:test";

import {
  classifyGitCommand,
  classifyGitOperations,
  formatGitActivity,
  gitActivityNonce,
  renderGitActivity,
  type GitActivityRecord,
} from "./git-activity.js";
import { toTurnId } from "./types.js";

test("classifies a plain git invocation", () => {
  const activity = classifyGitCommand("git status --short");
  assert.equal(activity?.subcommand, "status");
  assert.equal(activity?.rest, "--short");
  assert.equal(activity?.mutating, false);
  assert.equal(activity?.repository, undefined);
});

test("marks writing subcommands as mutating", () => {
  for (const command of ["git commit -m x", "git push origin main", "git reset --hard"]) {
    assert.equal(classifyGitCommand(command)?.mutating, true, command);
  }
  for (const command of ["git log --oneline", "git diff", "git show HEAD"]) {
    assert.equal(classifyGitCommand(command)?.mutating, false, command);
  }
});

test("treats an unfamiliar subcommand as inspection rather than a write", () => {
  assert.equal(classifyGitCommand("git some-custom-alias")?.mutating, false);
});

test("extracts the repository from -C in either form", () => {
  assert.equal(classifyGitCommand("git -C /repo/vault commit -m x")?.repository, "/repo/vault");
  assert.equal(classifyGitCommand("git -C=/repo/vault status")?.repository, "/repo/vault");
});

test("skips pre-subcommand options without mistaking their values for subcommands", () => {
  const activity = classifyGitCommand("git -c user.name=kas commit -m x");
  assert.equal(activity?.subcommand, "commit");
  assert.equal(activity?.mutating, true);
});

test("finds git when it is not the first command in the line", () => {
  const activity = classifyGitCommand("cd /repo && git commit -m 'fix the thing'");
  assert.equal(activity?.subcommand, "commit");
  assert.equal(activity?.rest, "-m fix the thing");
});

test("prefers the mutating command when a line chains several", () => {
  assert.equal(
    classifyGitCommand("git status --short && git commit -m x && git log -1")?.subcommand,
    "commit",
  );
});

test("keeps a quoted commit message intact", () => {
  assert.equal(
    classifyGitCommand('git commit -m "fix: keep the message together"')?.rest,
    "-m fix: keep the message together",
  );
});

test("ignores an environment assignment prefix", () => {
  assert.equal(classifyGitCommand("GIT_AUTHOR_NAME=kas git commit -m x")?.subcommand, "commit");
});

test("returns nothing for commands that are not git", () => {
  for (const command of ["rg git src/", "echo 'git commit'", "node scripts/git-helper.mjs", "gitk"]) {
    assert.equal(classifyGitCommand(command), undefined, command);
  }
});

test("returns nothing for git with no subcommand", () => {
  assert.equal(classifyGitCommand("git --version"), undefined);
  assert.equal(classifyGitCommand("git"), undefined);
});

test("formats the subcommand into the heading so it reads while collapsed", () => {
  assert.equal(
    formatGitActivity({ subcommand: "commit", rest: "-m x", mutating: true }),
    "**git commit**\n\n-m x",
  );
  assert.equal(
    formatGitActivity({ subcommand: "status", rest: "", mutating: false }),
    "**git status**",
  );
  assert.equal(
    formatGitActivity({ subcommand: "push", rest: "origin main", repository: "/repo/vault", mutating: true }),
    "**git push** · /repo/vault\n\norigin main",
  );
});

test("classifies commit, push, and merge operations in command order", () => {
  assert.deepEqual(
    classifyGitOperations(
      "bash",
      { command: "git commit -m 'ship it' && git push origin kas/main; git merge origin/main" },
      "/repo",
    ),
    [
      { action: "commit", cwd: "/repo" },
      { action: "push", cwd: "/repo" },
      { action: "merge", cwd: "/repo" },
    ],
  );
});

test("tracks cd and git -C repository context", () => {
  assert.deepEqual(
    classifyGitOperations(
      "exec",
      { command: "cd packages/app && git -C ../api commit -m api" },
      "/repo",
    ),
    [{ action: "commit", cwd: "/repo/packages/api" }],
  );
});

test("finds git actions inside a bash -lc wrapper", () => {
  assert.deepEqual(
    classifyGitOperations(
      "shell",
      { command: "bash -lc \"cd /srv/app && git push origin main\"" },
      "/repo",
    ),
    [{ action: "push", cwd: "/srv/app" }],
  );
});

test("ignores read-only commands, dry runs, and merge aborts", () => {
  for (const command of [
    "git status",
    "git log -1",
    "git push --dry-run origin main",
    "git merge --abort",
  ]) {
    assert.deepEqual(classifyGitOperations("bash", { command }, "/repo"), [], command);
  }
});

test("does not mistake quoted git text for a command", () => {
  assert.deepEqual(
    classifyGitOperations("bash", { command: "printf '%s\\n' 'git commit -m nope'" }, "/repo"),
    [],
  );
});

test("renders a fallback and versioned machine block", () => {
  const record: GitActivityRecord = {
    v: 1,
    action: "commit",
    outcome: "succeeded",
    repository: { name: "clickclack", url: "https://github.com/example/clickclack" },
    branch: "kas/main",
    commit: {
      sha: "0123456789abcdef",
      subject: "add git activity cards",
      url: "https://github.com/example/clickclack/commit/0123456789abcdef",
    },
    project: "clickclack",
    session: { id: "session_0123456789abcdef", turnId: toTurnId("turn_1") },
    occurredAt: "2026-03-20T12:00:00.000Z",
  };
  const body = renderGitActivity(record);
  assert.match(body, /\*\*git commit succeeded\*\*/u);
  assert.match(body, /\[clickclack\]\(https:\/\/github\.com\/example\/clickclack\)/u);
  assert.match(body, /```clickclack-git-activity\n\{"v":1/u);
  assert.match(body, /add git activity cards/u);
});

test("git activity nonces are stable per action and distinct across actions", () => {
  const first = gitActivityNonce("session_1", "tool_1", 0);
  assert.equal(first, gitActivityNonce("session_1", "tool_1", 0));
  assert.notEqual(first, gitActivityNonce("session_1", "tool_1", 1));
  assert.equal(first.length, 32);
});
