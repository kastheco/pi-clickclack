#!/usr/bin/env node
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const repository = fileURLToPath(new URL("..", import.meta.url));
const orkastrator = resolve(process.env.ORKASTRATOR_ROOT ?? join(repository, "../orkastrator"));
const orkastratorPackage = join(orkastrator, "package.json");
if (!existsSync(orkastratorPackage)) {
  throw new Error(`Orkastrator package not found at ${orkastrator}; set ORKASTRATOR_ROOT`);
}

const temporary = mkdtempSync(join(tmpdir(), "pi-clickclack-workflow-integration-"));
const packed = join(temporary, "packed");
const packageConsumer = join(temporary, "package-consumer");
mkdirSync(packed, { recursive: true });
mkdirSync(packageConsumer, { recursive: true });
const packedResult = JSON.parse(execFileSync(
  "npm",
  ["pack", "--json", "--pack-destination", packed],
  { cwd: orkastrator, encoding: "utf8" },
));
assert.equal(packedResult.length, 1, "npm pack should produce one Orkastrator archive");
writeFileSync(join(packageConsumer, "package.json"), `${JSON.stringify({
  name: "pi-clickclack-orkastrator-integration",
  version: "1.0.0",
  private: true,
  dependencies: {
    "@earendil-works/pi-coding-agent": "0.84.3",
    "@earendil-works/pi-tui": "0.84.3",
  },
}, null, 2)}\n`);
execFileSync("npm", [
  "install",
  "--legacy-peer-deps",
  "--no-package-lock",
  "--no-audit",
  "--no-fund",
  join(packed, packedResult[0].filename),
], { cwd: packageConsumer, stdio: "inherit" });

execFileSync("pnpm", ["build"], { cwd: repository, stdio: "inherit" });
const { createBridgeApplication } = await import(pathToFileURL(join(repository, "dist/application.js")).href);
const { createLogger } = await import(pathToFileURL(join(repository, "dist/logger.js")).href);
const { createEmbeddedPiRuntime } = await import(pathToFileURL(join(repository, "dist/pi-runtime.js")).href);
const { toProjectAlias } = await import(pathToFileURL(join(repository, "dist/types.js")).href);
const { startScriptedModelServer } = await import(
  pathToFileURL(join(orkastrator, "scripts/lib/scripted-model-server.mjs")).href
);
const installedOrkastrator = join(packageConsumer, "node_modules/orkastrator-pi");
const orkastratorRequire = createRequire(join(installedOrkastrator, "package.json"));
const workflowsRoot = resolve(dirname(orkastratorRequire.resolve("@osolmaz/pi-workflows")), "../..");
const workflowLibraryUrl = pathToFileURL(join(workflowsRoot, "dist/workflows/index.js")).href;
const { WorkflowRunStore } = await import(
  pathToFileURL(join(workflowsRoot, "dist/workflows/store.js")).href
);
const { WorkflowClient } = await import(
  pathToFileURL(join(workflowsRoot, "dist/client/index.js")).href
);

const home = join(temporary, "home");
const agentDir = join(home, ".pi", "agent");
const project = join(temporary, "project");
const runtimeDir = join(temporary, "runtime");
const databasePath = join(agentDir, "workflows", "state.sqlite");
const previousEnvironment = new Map();
const model = await startScriptedModelServer(
  () => ({ kind: "text", text: "workflow completed" }),
);
let application;
let failed = false;

function setEnvironment(name, value) {
  previousEnvironment.set(name, process.env[name]);
  process.env[name] = value;
}

function restoreEnvironment() {
  for (const [name, value] of previousEnvironment) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
}

function waitFor(predicate, description, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolveWait, reject) => {
    const inspect = async () => {
      try {
        const value = await predicate();
        if (value) {
          resolveWait(value);
          return;
        }
        if (Date.now() >= deadline) {
          reject(new Error(`timed out waiting for ${description}`));
          return;
        }
        setTimeout(inspect, 25);
      } catch (error) {
        reject(error);
      }
    };
    void inspect();
  });
}

try {
  mkdirSync(join(agentDir, "sessions"), { recursive: true });
  mkdirSync(join(project, ".pi", "workflows"), { recursive: true });
  mkdirSync(runtimeDir, { recursive: true, mode: 0o700 });
  writeFileSync(join(agentDir, "models.json"), `${JSON.stringify({
    providers: {
      scripted: {
        name: "Scripted integration model",
        baseUrl: model.baseUrl,
        api: "openai-completions",
        apiKey: "scripted-key",
        compat: { supportsDeveloperRole: false, supportsReasoningEffort: false },
        models: [{ id: "integration-model", contextWindow: 32_000, maxTokens: 2_000 }],
      },
    },
  }, null, 2)}\n`);
  writeFileSync(join(agentDir, "auth.json"), "{}\n");
  writeFileSync(join(agentDir, "settings.json"), `${JSON.stringify({
    defaultProvider: "scripted",
    defaultModel: "integration-model",
    defaultProjectTrust: "always",
    quietStartup: true,
    enableInstallTelemetry: false,
    packages: [installedOrkastrator],
  }, null, 2)}\n`);
  const workflowPath = join(project, ".pi", "workflows", "external-decision.workflow.ts");
  writeFileSync(workflowPath, [
    `import { choice, compute, defineHumanChoices, defineWorkflow, humanDecision, humanDecisionEdge } from ${JSON.stringify(workflowLibraryUrl)};`,
    "const choices = defineHumanChoices({ continue: choice({ label: 'Continue' }), stop: choice({ label: 'Stop' }) });",
    "export default defineWorkflow({",
    "  source: import.meta.url,",
    "  name: 'external-decision',",
    "  startAt: 'approval',",
    "  exits: { completed: { from: 'completed', validate: (value) => value }, stopped: { from: 'stopped', validate: (value) => value } },",
    "  nodes: {",
    "    approval: humanDecision({ audience: 'operator', choices, request: () => ({ title: 'Approve external presentation', subject: {}, presentation: { schema: 'pi-workflows.decision-presentation.v1', summary: 'This prompt must be delivered by ClickClack.', blocks: [] } }) }),",
    "    completed: compute({ run: () => ({ status: 'completed' }) }),",
    "    stopped: compute({ run: () => ({ status: 'stopped' }) }),",
    "  },",
    "  edges: [humanDecisionEdge({ from: 'approval', choices, cases: { continue: 'completed', stop: 'stopped' } })],",
    "});",
    "",
  ].join("\n"));

  setEnvironment("HOME", home);
  setEnvironment("PI_CODING_AGENT_DIR", agentDir);
  setEnvironment("XDG_CONFIG_HOME", join(home, ".config"));
  setEnvironment("XDG_RUNTIME_DIR", runtimeDir);
  setEnvironment("PI_OFFLINE", "1");
  setEnvironment("PI_SKIP_VERSION_CHECK", "1");
  delete process.env.HERDR_PANE_ID;

  const messages = new Map();
  const sent = [];
  const activity = [];
  const ephemeral = [];
  let onEvent;
  const clickClack = {
    me: async () => ({ id: "usr_bot", kind: "bot", display_name: "Bridge", handle: "bridge", avatar_url: "", created_at: new Date().toISOString() }),
    workspaces: { get: async () => ({ id: "wsp_test", route_id: "W1", name: "Test", slug: "test", icon_url: "", created_at: new Date().toISOString() }) },
    bots: { setCommands: async () => [] },
    messages: {
      get: async (messageId) => messages.get(messageId),
      update: async (messageId, input) => {
        const row = activity.find((candidate) => candidate.id === messageId);
        if (row) row.body = input.body;
        return { id: messageId };
      },
    },
    channels: { sendMessage: async () => { throw new Error("unexpected channel message"); } },
    dms: {
      sendMessage: async (conversationId, input) => {
        const id = `out_${sent.length + activity.length + 1}`;
        if (input.kind === "agent_commentary" || input.kind === "agent_tool") {
          activity.push({ id, conversationId, ...input });
        } else {
          sent.push({ id, conversationId, ...input });
        }
        return { id };
      },
    },
    events: {
      list: async () => ({ events: [], tailCursor: "cur_0" }),
      subscribe: (options) => {
        onEvent = options.onEvent;
        return { close() {} };
      },
      publishEphemeral: async (input) => {
        ephemeral.push(input);
        return { id: `eph_${ephemeral.length}` };
      },
    },
  };
  const config = {
    clickClack: {
      baseUrl: "https://clickclack.example.test",
      workspaceId: "wsp_test",
      botToken: "ccb_test",
      ownerIds: ["usr_owner"],
    },
    projects: new Map([[toProjectAlias("fixture"), { alias: toProjectAlias("fixture"), cwd: project }]]),
    invocationBindings: [],
    pi: { model: "scripted/integration-model", thinkingLevel: "off", agentDir },
    statePath: ":memory:",
  };
  const embeddedPiRuntime = createEmbeddedPiRuntime(config);
  let createdRuntime;
  const piRuntime = {
    kind: embeddedPiRuntime.kind,
    project: (projectAlias) => embeddedPiRuntime.project(projectAlias),
    createSessionRuntime: async (request) => {
      createdRuntime = await embeddedPiRuntime.createSessionRuntime(request);
      return createdRuntime;
    },
  };
  const rawWorkflowClient = new WorkflowClient({
    clientId: "pi-clickclack-integration",
    databasePath,
  });
  const delayedWorkflowClient = {
    clientId: rawWorkflowClient.clientId,
    ensureAvailable: (options) => rawWorkflowClient.ensureAvailable(options),
    request: (options) => rawWorkflowClient.request(options),
    requestDurable: (options) => rawWorkflowClient.requestDurable(options),
    watchSession: async (options, onEvent) => {
      let active = true;
      const timers = new Set();
      const unwatch = await rawWorkflowClient.watchSession(options, (event) => {
        const timer = setTimeout(() => {
          timers.delete(timer);
          if (active) onEvent(event);
        }, 1_000);
        timers.add(timer);
      });
      return async () => {
        active = false;
        for (const timer of timers) clearTimeout(timer);
        timers.clear();
        await unwatch();
      };
    },
    close: () => rawWorkflowClient.close(),
  };
  application = createBridgeApplication(config, {
    clickClack,
    piRuntime,
    logger: createLogger({ sink() {} }),
    workflowClientFactory: () => delayedWorkflowClient,
  });
  const service = application.service;
  service.state.upsertBinding({
    conversationType: "direct",
    conversationId: "dm_test",
    projectAlias: toProjectAlias("fixture"),
    invocationMode: "auto",
  });

  const sourceMessage = (id, body) => ({
    id,
    workspace_id: "wsp_test",
    direct_conversation_id: "dm_test",
    author_id: "usr_owner",
    thread_root_id: id,
    body,
    body_format: "markdown",
    created_at: new Date().toISOString(),
    kind: "message",
  });
  const emit = (message, cursor) => {
    messages.set(message.id, message);
    onEvent({
      id: `evt_${message.id}`,
      cursor,
      type: "message.created",
      workspace_id: "wsp_test",
      created_at: new Date().toISOString(),
      payload: { message_id: message.id, author_id: "usr_owner", direct_conversation_id: "dm_test" },
    });
  };

  await service.start();
  emit(sourceMessage("msg_start", `/workflow ${workflowPath}`), "cur_1");
  await service.waitForIdle();
  const decision = await waitFor(
    () => activity.find((row) => row.body.includes("Approve external presentation")),
    "the external decision prompt in ClickClack",
    60_000,
  );
  assert.match(decision.turn_id, /^decision:/u);
  assert.doesNotMatch(
    JSON.stringify(createdRuntime?.session.messages ?? []),
    /pi-workflows-interaction/u,
    "the embedded presenter must not write its own decision prompt",
  );

  emit(sourceMessage("msg_answer", "1"), "cur_2");
  await service.waitForIdle();
  await waitFor(() => {
    if (!existsSync(databasePath)) return undefined;
    const store = new WorkflowRunStore(databasePath, { readOnly: true });
    try {
      return store.listRuns().some((run) =>
        run.state.workflowName === "external-decision" && run.state.status === "completed"
      ) || undefined;
    } finally {
      store.close();
    }
  }, "the externally answered workflow to complete", 60_000);

  assert.ok(sent.some((row) => row.body === "answer recorded, resuming the workflow."));
  assert.ok(ephemeral.length > 0, "workflow run state should be published to ClickClack");
  assert.equal(model.errors.length, 0, JSON.stringify(model.errors));
  console.log("orkastrator decision integration passed");
} catch (error) {
  failed = true;
  throw error;
} finally {
  await application?.stop().catch(() => undefined);
  const cleanup = new WorkflowClient({ clientId: "pi-clickclack-integration-cleanup", databasePath });
  try {
    if (existsSync(databasePath)) {
      await cleanup.request({ operation: "host.stop", signal: AbortSignal.timeout(2_000) });
    }
  } catch {
    // Host was already stopped or never started.
  } finally {
    await cleanup.close().catch(() => undefined);
  }
  await model.close();
  restoreEnvironment();
  if (!failed) rmSync(temporary, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  else console.error(`integration artifacts retained at ${temporary}`);
}
