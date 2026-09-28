import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createAgentSession, SessionManager } from "@oh-my-pi/pi-coding-agent";
import { isPiResourceCommand, parseSlashInvocation, runtimeBotCommandMenu } from "./commands.js";

type RegisteredCommand = { name?: string; invocationName?: string; description?: string };
function runtime(commands: readonly RegisteredCommand[]): Parameters<typeof runtimeBotCommandMenu>[0] {
  return {
    extensionRunner: { getRegisteredCommands: () => commands },
    promptTemplates: [],
  } as unknown as Parameters<typeof runtimeBotCommandMenu>[0];
}

test("a namespaced command reaches the ClickClack command menu", () => {
  const menu = runtimeBotCommandMenu(runtime([
    { name: "kas", description: "Run the lifecycle" },
    { name: "kas:cook", description: "Run the full lifecycle" },
    { name: "kas:check", description: "Review only" },
    { name: "kas-runs", description: "Report the active run" },
  ]));
  assert.deepEqual(menu.map((entry) => entry.command), ["kas", "kas:cook", "kas:check", "kas-runs"]);
});

test("a name ClickClack cannot represent is dropped rather than published", () => {
  const menu = runtimeBotCommandMenu(runtime([
    { name: "kas", description: "keep" },
    { name: "kas:", description: "empty namespace" },
    { name: "kas:cook:extra", description: "nested namespace" },
    { name: "kas cook", description: "space" },
    { name: "Kas", description: "uppercase" },
    { name: "skill:review", description: "skill namespace" },
  ]));
  assert.deepEqual(menu.map((entry) => entry.command), ["kas", "skill:review"]);
});

test("a namespaced command parses as one invocation with its arguments", () => {
  assert.deepEqual(parseSlashInvocation("/kas:cook add a health endpoint"), { raw: "/kas:cook add a health endpoint", name: "kas:cook", args: "add a health endpoint" });
  assert.deepEqual(parseSlashInvocation("/kas:cook"), { raw: "/kas:cook", name: "kas:cook", args: "" });
});
test("an offline OMP extension command appears in the live ClickClack menu and dispatch registry", async () => {
  const root = mkdtempSync(join(tmpdir(), "omp-command-menu-"));
  try {
    const { session } = await createAgentSession({
      cwd: root, agentDir: root, sessionManager: SessionManager.inMemory(root),
      disableExtensionDiscovery: true, cacheWarming: false, bindProcessState: false,
      extensions: [(pi) => pi.registerCommand("kas:cook", { description: "Run the lifecycle", handler: async () => {} })],
    });
    try {
      assert.deepEqual(runtimeBotCommandMenu(session).filter((item) => item.command === "kas:cook"), [
        { command: "kas:cook", description: "Run the lifecycle" },
      ]);
      const invocation = parseSlashInvocation("/kas:cook review this change");
      assert.ok(invocation);
      assert.equal(isPiResourceCommand(session, invocation), true);
    } finally { await session.dispose(); }
  } finally { rmSync(root, { recursive: true, force: true }); }
});
