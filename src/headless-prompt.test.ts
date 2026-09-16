import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  createAgentSession, DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager,
  type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { bridgeExcludedTools } from "./pi-runtime.js";

test("headless reconciliation cannot change the first-to-second turn system prefix", async () => {
  const root = mkdtempSync(join(tmpdir(), "bridge-headless-prefix-"));
  let dispose: (() => void) | undefined;
  try {
    const models = await ModelRuntime.create({
      authPath: join(root, "auth.json"), modelsPath: join(root, "models.json"),
      modelsStorePath: join(root, "models-store.json"), allowModelNetwork: false,
    });
    const loader = new DefaultResourceLoader({
      cwd: root, agentDir: root, settingsManager: SettingsManager.inMemory(),
      noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
      extensionFactories: [
        (pi) => {
          pi.registerTool({
            name: "ask_user_question", label: "Ask", description: "Ask a question",
            promptSnippet: "Ask a question", promptGuidelines: ["Use ask_user_question for clarification."],
            parameters: { type: "object", properties: {} } as ToolDefinition["parameters"],
            async execute() { return { content: [{ type: "text", text: "unused" }], details: {} }; },
          });
          // Same ordering as the installed question-tool reconciler and LCM:
          // tool removal refreshes the base, then an override uses event.systemPrompt.
          pi.on("before_agent_start", (_event, ctx) => {
            const tools = pi.getActiveTools();
            if (!ctx.hasUI && tools.includes("ask_user_question")) {
              pi.setActiveTools(tools.filter((name) => name !== "ask_user_question"));
            }
          });
        },
        (pi) => {
          pi.on("before_agent_start", (event) => ({ systemPrompt: `${event.systemPrompt}\nStable LCM guidance.` }));
        },
      ],
    });
    await loader.reload();
    const { session } = await createAgentSession({
      cwd: root, agentDir: root, modelRuntime: models, resourceLoader: loader,
      sessionManager: SessionManager.inMemory(root), excludeTools: bridgeExcludedTools,
    });
    dispose = () => session.dispose();
    await session.bindExtensions({ mode: "rpc" });
    const runner = session.extensionRunner;
    const first = await runner.emitBeforeAgentStart("first", undefined, session.systemPrompt, { cwd: root });
    const second = await runner.emitBeforeAgentStart("second", undefined, session.systemPrompt, { cwd: root });
    assert.equal(first?.systemPrompt, second?.systemPrompt, "headless tool removal must not leave a stale first-turn override");
    assert.doesNotMatch(first?.systemPrompt ?? "", /ask_user_question/u);
    assert.ok(session.getActiveToolNames().includes("read"), "other tools remain enabled");
    assert.ok(!session.getActiveToolNames().includes("ask_user_question"));
    await session.reload();
    assert.ok(!session.getActiveToolNames().includes("ask_user_question"), "reload preserves the exclusion");
  } finally {
    dispose?.();
    rmSync(root, { recursive: true, force: true });
  }
});
