import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import {
  createAgentSession, DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager,
  type AgentSession,
} from "@earendil-works/pi-coding-agent";
import { steerWithReceipt } from "./pi-steering.js";

function barrier() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

test("Pi 0.85.1 consumes identical steering objects before prompt settles without model calls", { timeout: 5000 }, async () => {
  const manifest = JSON.parse(readFileSync(join(dirname(fileURLToPath(import.meta.resolve("@earendil-works/pi-coding-agent"))), "../package.json"), "utf8"));
  assert.equal(manifest.version, "0.85.1", "review synchronous steering identity compatibility before upgrading");
  const directory = mkdtempSync(join(tmpdir(), "pi-steering-sdk-"));
  const settingsManager = SettingsManager.inMemory({ compaction: { enabled: false }, retry: { enabled: false } });
  const loader = new DefaultResourceLoader({
    cwd: directory, agentDir: directory, settingsManager,
    noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
  });
  let session: AgentSession | undefined;
  const firstStream = barrier();
  const releaseFirst = barrier();
  const correctionsConsumed = barrier();
  const releaseLast = barrier();
  try {
    await loader.reload();
    const models = await ModelRuntime.create({
      authPath: join(directory, "auth.json"), modelsPath: join(directory, "models.json"),
      modelsStorePath: join(directory, "models-store.json"), allowModelNetwork: false,
    });
    await models.setRuntimeApiKey("anthropic", "fixture-not-a-credential");
    const model = models.getModel("anthropic", "claude-sonnet-4-5");
    assert.ok(model);
    ({ session } = await createAgentSession({
      cwd: directory, agentDir: directory, modelRuntime: models, model,
      resourceLoader: loader, settingsManager, sessionManager: SessionManager.inMemory(directory), noTools: "all",
    }));
    let calls = 0;
    session.agent.streamFunction = (_model, context) => {
      calls += 1;
      const call = calls;
      const answer = {
        role: "assistant" as const, content: [{ type: "text" as const, text: "fixture answer" }],
        api: model.api, provider: model.provider, model: model.id, stopReason: "stop" as const,
        usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }, timestamp: Date.now(),
      };
      return {
        async *[Symbol.asyncIterator]() {
          yield { type: "start", partial: answer };
          if (call === 1) { firstStream.resolve(); await releaseFirst.promise; }
          if (call === 3) {
            assert.equal(context.messages.filter((m) => m.role === "user").length, 3);
            correctionsConsumed.resolve(); await releaseLast.promise;
          }
          yield { type: "done", reason: "stop", message: answer };
        },
        result: async () => answer,
      } as unknown as Awaited<ReturnType<AgentSession["agent"]["streamFunction"]>>;
    };
    const identities = new WeakMap<object, number>();
    const consumed: number[] = [];
    let steerAtSettlement = false;
    let lateSteering: Promise<void> | undefined;
    session.subscribe((event) => {
      if (event.type === "message_start") {
        const id = identities.get(event.message);
        if (id !== undefined) consumed.push(id);
      }
      if (event.type === "agent_end" && steerAtSettlement) {
        steerAtSettlement = false;
        assert.equal(session!.isStreaming, true);
        lateSteering = steerWithReceipt(session!, "at the settlement boundary", undefined, (object) => identities.set(object, 3));
      }
    });
    let settled = false;
    const run = session.prompt("original").finally(() => { settled = true; });
    await firstStream.promise;
    assert.equal(session.isStreaming, true);
    const originalSteer = session.agent.steer;
    for (const id of [1, 2]) {
      await steerWithReceipt(session, "identical correction", undefined, (object) => identities.set(object, id));
      assert.equal(session.agent.steer, originalSteer);
    }
    assert.deepEqual(consumed, [], "SDK polls after the current assistant response, not mid-token");
    releaseFirst.resolve();
    await correctionsConsumed.promise;
    assert.deepEqual(consumed, [1, 2]);
    assert.equal(settled, false);
    steerAtSettlement = true;
    releaseLast.resolve();
    await run;
    await lateSteering;
    assert.deepEqual(consumed, [1, 2, 3], "agent_end steering continues the same SDK prompt rather than becoming stranded");
    assert.equal(calls, 4);
  } finally {
    releaseFirst.resolve(); releaseLast.resolve();
    session?.dispose();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("steering receipt interceptor restores on synchronous throw and guards reentrancy", () => {
  const original = () => {};
  const agent = { steer: original };
  const session = { agent, steer() { throw new Error("rejected"); } } as unknown as AgentSession;
  assert.throws(() => steerWithReceipt(session, "text", undefined, () => {}), /rejected/);
  assert.equal(agent.steer, original);
  session.steer = () => steerWithReceipt(session, "nested", undefined, () => {});
  assert.throws(() => steerWithReceipt(session, "text", undefined, () => {}), /reentrant/);
  assert.equal(agent.steer, original);
});

test("asynchronous enqueue and cloned events cannot falsely confirm a receipt", async () => {
  const messages: object[] = [];
  const identities = new WeakSet<object>();
  const session = {
    agent: { steer(message: object) { messages.push(message); } },
    async steer() { await Promise.resolve(); session.agent.steer({ role: "user", content: "text", timestamp: 0 }); },
  } as unknown as AgentSession;
  await steerWithReceipt(session, "text", undefined, (message) => identities.add(message));
  assert.equal(identities.has(messages[0]!), false);
  assert.equal(identities.has({ ...messages[0] }), false);
});


test("steering interceptor forwards this and return value; ambiguous reentrant captures confirm nothing", async () => {
  const queued: object[] = [];
  const agent = { steer(message: object) { assert.equal(this, agent); queued.push(message); } };
  const first = { role: "user" };
  const second = { role: "user" };
  const operation = Promise.resolve();
  const session = { agent, steer() { agent.steer(first); agent.steer(second); return operation; } } as unknown as AgentSession;
  const captures: object[] = [];
  assert.equal(steerWithReceipt(session, "text", undefined, (message) => captures.push(message)), operation);
  await operation;
  assert.deepEqual(queued, [first, second]);
  assert.deepEqual(captures, []);
});
