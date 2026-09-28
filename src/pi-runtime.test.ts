import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createAgentSession, SessionManager } from "@oh-my-pi/pi-coding-agent";

import { bridgeAppendSystemPrompt, createEmbeddedPiRuntime, loadBridgeSystemPrompts } from "./pi-runtime.js";

test("bridge tells Pi how to work and narrate through ClickClack", () => {
  assert.match(bridgeAppendSystemPrompt, /already execute in the pinned project's current working directory/u);
  assert.match(bridgeAppendSystemPrompt, /Do not prepend `cd <project cwd> &&`/u);
  assert.match(bridgeAppendSystemPrompt, /Before each tool batch.*one or two short prose paragraphs/u);
  assert.match(bridgeAppendSystemPrompt, /Do not use terse status headings/u);
});

test("embedded OMP initializes a headless session with UI requests and no model call", async () => {
  const root = mkdtempSync(join(tmpdir(), "bridge-headless-"));
  try {
    const { session } = await createAgentSession({
      cwd: root, agentDir: root, sessionManager: SessionManager.inMemory(root),
      disableExtensionDiscovery: true, hasUI: false, interactivePrompts: true,
      cacheWarming: false, bindProcessState: false,
    });
    try {
      assert.ok(session.getActiveToolNames().includes("ask"), "a remote UI request remains available without a terminal");
      assert.equal(session.messages.length, 0);
    } finally { await session.dispose(); }
  } finally { rmSync(root, { recursive: true, force: true }); }
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
    const { session } = await createAgentSession({
      cwd: root, agentDir: root, sessionManager: SessionManager.inMemory(root),
      disableExtensionDiscovery: true, appendSystemPrompt: prompts.join("\n\n"),
      cacheWarming: false, bindProcessState: false,
    });
    try {
      const first = session.systemPrompt.join("\n");
      assert.match(first, /lowercase chat/u);
      writeFileSync(path, "updated profile");
      await session.reload();
      assert.equal(session.systemPrompt.join("\n"), first, "reload keeps the existing session's stable prompt snapshot");
      assert.ok(loadBridgeSystemPrompts(path)[1]?.endsWith("updated profile"));
      assert.ok(prompts[1]?.endsWith(content));
    } finally { await session.dispose(); }
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
