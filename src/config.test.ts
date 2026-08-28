import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { ConfigurationError, loadConfig } from "./config.js";

function fixture(): { root: string; environment: Record<string, string> } {
  const root = mkdtempSync(join(tmpdir(), "pi-clickclack-config-"));
  const project = join(root, "project");
  const agentDir = join(root, "agent");
  mkdirSync(project);
  mkdirSync(agentDir);
  return {
    root,
    environment: {
      CLICKCLACK_URL: "https://clickclack.example.test",
      CLICKCLACK_WORKSPACE_ID: "wsp_test",
      CLICKCLACK_BOT_TOKEN: "ccb_super_secret_value",
      CLICKCLACK_OWNER_IDS: "usr_owner",
      CLICKCLACK_PI_PROJECTS: JSON.stringify([{ alias: "main", cwd: project }]),
      CLICKCLACK_PI_INVOCATIONS: JSON.stringify([
        { conversationType: "channel", conversationId: "chn_one", mode: "mention" },
        { conversationType: "direct", conversationId: "dcn_one", mode: "auto" },
      ]),
      CLICKCLACK_PI_MODEL: "openai-codex/gpt-test",
      CLICKCLACK_PI_THINKING_LEVEL: "high",
      CLICKCLACK_PI_STATE_PATH: join(root, "state", "bridge.sqlite"),
      CLICKCLACK_PI_AGENT_DIR: agentDir,
    },
  };
}

test("loads a typed bridge configuration", () => {
  const { root, environment } = fixture();
  try {
    const config = loadConfig(environment);
    assert.equal(config.clickClack.baseUrl, "https://clickclack.example.test");
    assert.deepEqual(config.clickClack.ownerIds, ["usr_owner"]);
    assert.equal(config.projects.get("main" as never)?.cwd, join(root, "project"));
    assert.equal(config.invocationBindings.length, 2);
    assert.equal(config.pi.thinkingLevel, "high");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("rejects missing owners without exposing the bot token", () => {
  const { root, environment } = fixture();
  try {
    environment.CLICKCLACK_OWNER_IDS = "";
    assert.throws(
      () => loadConfig(environment),
      (error: unknown) => {
        assert.ok(error instanceof ConfigurationError);
        assert.match(error.message, /CLICKCLACK_OWNER_IDS/u);
        assert.doesNotMatch(error.message, /ccb_super_secret_value/u);
        return true;
      },
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("rejects duplicate aliases and invalid project paths", () => {
  const { root, environment } = fixture();
  try {
    environment.CLICKCLACK_PI_PROJECTS = JSON.stringify([
      { alias: "main", cwd: join(root, "missing") },
      { alias: "main", cwd: join(root, "project") },
    ]);
    assert.throws(
      () => loadConfig(environment),
      (error: unknown) => {
        assert.ok(error instanceof ConfigurationError);
        assert.match(error.message, /duplicate alias main/u);
        assert.match(error.message, /must point to an existing directory/u);
        return true;
      },
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("rejects malformed invocation bindings before startup", () => {
  const { root, environment } = fixture();
  try {
    environment.CLICKCLACK_PI_INVOCATIONS = JSON.stringify([
      { conversationType: "channel", conversationId: "chn_one", mode: "auto" },
      { conversationType: "direct", conversationId: "dcn_one", mode: "always" },
      { conversationType: "channel", conversationId: "chn_one", mode: "mention" },
    ]);
    assert.throws(
      () => loadConfig(environment),
      (error: unknown) => {
        assert.ok(error instanceof ConfigurationError);
        assert.match(error.message, /channel:chn_one must use mention or always mode/u);
        assert.match(error.message, /direct:dcn_one must use auto mode/u);
        assert.match(error.message, /duplicate conversation channel:chn_one/u);
        return true;
      },
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
