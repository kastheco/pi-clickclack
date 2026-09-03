import assert from "node:assert/strict";
import test from "node:test";

import { classifyGitCommand, formatGitActivity } from "./git-activity.js";

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
  const activity = classifyGitCommand("git some-custom-alias");
  assert.equal(activity?.subcommand, "some-custom-alias");
  assert.equal(activity?.mutating, false);
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
  const activity = classifyGitCommand("git status --short && git commit -m x && git log -1");
  assert.equal(activity?.subcommand, "commit");
});

test("keeps a quoted commit message intact", () => {
  const activity = classifyGitCommand('git commit -m "fix: keep the message together"');
  assert.equal(activity?.rest, "-m fix: keep the message together");
});

test("ignores an environment assignment prefix", () => {
  const activity = classifyGitCommand("GIT_AUTHOR_NAME=kas git commit -m x");
  assert.equal(activity?.subcommand, "commit");
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
