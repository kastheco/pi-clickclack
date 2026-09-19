import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DefaultResourceLoader, SettingsManager, getSelectListTheme } from "@earendil-works/pi-coding-agent";

import { bridgeAppendSystemPrompt, createEmbeddedPiRuntime, loadBridgeSystemPrompts } from "./pi-runtime.js";

test("bridge tells Pi how to work and narrate through ClickClack", () => {
  assert.match(bridgeAppendSystemPrompt, /already execute in the pinned project's current working directory/u);
  assert.match(bridgeAppendSystemPrompt, /Do not prepend `cd <project cwd> &&`/u);
  assert.match(bridgeAppendSystemPrompt, /Before each tool batch.*one or two short prose paragraphs/u);
  assert.match(bridgeAppendSystemPrompt, /Do not use terse status headings/u);
});

test("embedded Pi initializes a headless theme for connector extensions", () => {
  createEmbeddedPiRuntime({
    clickClack: {
      baseUrl: "http://localhost",
      workspaceId: "workspace",
      botToken: "token",
      ownerIds: [],
    },
    projects: new Map(),
    invocationBindings: [],
    pi: {
      model: "provider/model",
      thinkingLevel: "off",
      agentDir: "/tmp/pi-clickclack-test-agent",
    },
    statePath: "/tmp/pi-clickclack-test-state.sqlite",
  });

  assert.doesNotThrow(() => getSelectListTheme().selectedPrefix(">"));
});

test("loads the exact voice profile alongside bridge instructions without a model tool call", async () => {
  const root = mkdtempSync(join(tmpdir(), "bridge-voice-"));
  try {
    const path = join(root, "voice.md");
    const content = "# voice\n\nlowercase chat. Standard capitalization in documents.\n";
    writeFileSync(path, content);
    const prompts = loadBridgeSystemPrompts(path);
    assert.equal(prompts[0], bridgeAppendSystemPrompt);
    assert.ok(prompts[1]?.endsWith(content));
    assert.match(prompts[1] ?? "", /already loaded/u);
    const loader = new DefaultResourceLoader({
      cwd: root, agentDir: root, settingsManager: SettingsManager.inMemory(),
      noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
      appendSystemPrompt: prompts,
    });
    await loader.reload();
    assert.deepEqual(loader.getAppendSystemPrompt(), prompts);
    writeFileSync(path, "updated profile");
    await loader.reload();
    assert.deepEqual(loader.getAppendSystemPrompt(), prompts, "reload does not silently change the runtime's system prefix");
    assert.ok(loadBridgeSystemPrompts(path)[1]?.endsWith("updated profile"));
    assert.ok(prompts[1]?.endsWith(content), "an existing runtime retains its stable prompt snapshot");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("fails visibly rather than silently ignoring a missing or empty voice profile", () => {
  const root = mkdtempSync(join(tmpdir(), "bridge-voice-"));
  try {
    const path = join(root, "voice.md");
    assert.throws(() => loadBridgeSystemPrompts(path), /could not load.*voice profile/iu);
    writeFileSync(path, " \n ");
    assert.throws(() => loadBridgeSystemPrompts(path), /voice profile is empty/iu);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
