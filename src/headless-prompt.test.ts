import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createAgentSession, SessionManager } from "@oh-my-pi/pi-coding-agent";

test("headless tool reconciliation preserves the first-to-second turn system prefix and interactive requests", async () => {
  const root = mkdtempSync(join(tmpdir(), "bridge-headless-prefix-"));
  try {
    const { session } = await createAgentSession({
      cwd: root, agentDir: root, sessionManager: SessionManager.inMemory(root),
      disableExtensionDiscovery: true, hasUI: false, interactivePrompts: true,
      cacheWarming: false, bindProcessState: false,
      extensions: [
        (pi) => {
          pi.on("before_agent_start", async () => {
            const tools = pi.getActiveTools();
            if (tools.includes("web_search")) {
              await pi.setActiveTools(tools.filter((name) => name !== "web_search"));
            }
          });
        },
        (pi) => {
          pi.on("before_agent_start", (event) => ({ systemPrompt: [...event.systemPrompt, "Stable guidance."] }));
        },
      ],
    });
    try {
      const runner = session.extensionRunner;
      assert.ok(runner);
      const first = await runner.emitBeforeAgentStart("first", undefined, session.systemPrompt);
      const second = await runner.emitBeforeAgentStart("second", undefined, session.systemPrompt);
      assert.deepEqual(first?.systemPrompt, second?.systemPrompt, "tool reconciliation must not change subsequent prompt prefix");
      assert.equal(first?.systemPrompt?.at(-1), "Stable guidance.");
      assert.ok(session.getActiveToolNames().includes("ask"), "headless bridge still permits remote UI requests");
      await session.reload();
      assert.ok(session.getActiveToolNames().includes("ask"), "reload retains interactive request access");
    } finally { await session.dispose(); }
  } finally { rmSync(root, { recursive: true, force: true }); }
});
