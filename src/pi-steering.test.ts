import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createAssistantMessageEventStream, type AssistantMessage } from "@oh-my-pi/pi-ai";
import { createAgentSession, SessionManager, type AgentSession } from "@oh-my-pi/pi-coding-agent";
import { steerWithReceipt } from "./pi-steering.js";

function barrier() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

test("OMP consumes identical steering objects before prompt settles without network", { timeout: 15000 }, async () => {
  const directory = mkdtempSync(join(tmpdir(), "omp-steering-sdk-"));
  let session: AgentSession | undefined;
  const firstStream = barrier();
  const releaseFirst = barrier();
  const correctionsConsumed = barrier();
  const releaseLast = barrier();
  try {
    ({ session } = await createAgentSession({
      cwd: directory, agentDir: directory, sessionManager: SessionManager.inMemory(directory),
      disableExtensionDiscovery: true, cacheWarming: false, bindProcessState: false,
      extensions: [(pi) => {
        pi.on("input", async (event) => {
          if (event.text !== "identical correction") return;
          await new Promise<void>((resolve) => setImmediate(resolve));
          return { text: "transformed correction" };
        });
      }],
    }));
    const model = session.model;
    assert.ok(model);
    let calls = 0;
    session.agent.streamFn = (_model, context) => {
      calls += 1;
      const call = calls;
      const answer: AssistantMessage = {
        role: "assistant", content: [{ type: "text", text: "fixture answer" }],
        api: model.api, provider: model.provider, model: model.id, stopReason: "stop",
        usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }, timestamp: Date.now(),
      };
      const stream = createAssistantMessageEventStream();
      void (async () => {
        stream.push({ type: "start", partial: answer });
        if (call === 1) { firstStream.resolve(); await releaseFirst.promise; }
        if (call === 3) {
          assert.equal(context.messages.filter((m) => m.role === "user").length, 3);
          correctionsConsumed.resolve(); await releaseLast.promise;
        }
        stream.push({ type: "done", reason: "stop", message: answer });
        stream.end(answer);
      })().catch((error: unknown) => stream.fail(error));
      return stream;
    };
    const identities = new WeakMap<object, number>();
    const consumed: number[] = [];
    let steerAtSettlement = false;
    let boundaryConsumed: boolean | undefined;
    let lateSteering: Promise<void> | undefined;
    session.subscribe((event) => {
      if (event.type === "message_start") {
        const id = identities.get(event.message);
        if (id !== undefined) consumed.push(id);
      }
      if (event.type === "agent_end" && steerAtSettlement) {
        steerAtSettlement = false;
        assert.equal(session!.isStreaming, true);
        lateSteering = steerWithReceipt(session!, "at the settlement boundary", undefined, (object, alreadyConsumed) => {
          boundaryConsumed = alreadyConsumed;
          if (alreadyConsumed) consumed.push(3);
          else identities.set(object, 3);
        });
      }
    });
    let settled = false;
    const run = session.prompt("original").finally(() => { settled = true; });
    await firstStream.promise;
    assert.equal(session.isStreaming, true);
    const originalSteer = session.agent.steer;
    for (const id of [1, 2]) {
      await steerWithReceipt(session, "identical correction", undefined, (object, alreadyConsumed) => {
        assert.deepEqual("content" in object ? object.content : undefined, [{ type: "text", text: "identical correction" }], "OMP steering bypasses interactive input transforms");
        if (alreadyConsumed) consumed.push(id);
        else identities.set(object, id);
      });
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
    assert.equal(boundaryConsumed, undefined, "a resolved steer without enqueue is not a delivery receipt");
    assert.deepEqual(consumed, [1, 2]);
    assert.equal(session.agent.peekSteeringQueue().length, 0, "OMP drops the agent_end boundary correction");
    await session.prompt("next turn");
    assert.deepEqual(consumed, [1, 2], "the dropped correction does not reappear in the next turn");
    assert.equal(calls, 4);
  } finally {
    releaseFirst.resolve(); releaseLast.resolve();
    session?.dispose();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("steering receipt interceptor restores on rejection and guards reentrancy", async () => {
  const original = () => {};
  const agent = { steer: original };
  const session = { agent, steer() { throw new Error("rejected"); } } as unknown as AgentSession;
  await assert.rejects(steerWithReceipt(session, "text", undefined, () => {}), /rejected/);
  assert.equal(agent.steer, original);
  session.steer = () => steerWithReceipt(session, "nested", undefined, () => {});
  await assert.rejects(steerWithReceipt(session, "text", undefined, () => {}), /reentrant/);
  assert.equal(agent.steer, original);
});

test("asynchronous enqueue captures exact identity, never a clone", async () => {
  const messages: object[] = [];
  const identities = new WeakSet<object>();
  const session = {
    agent: { steer(message: object) { messages.push(message); } },
    async steer() { await Promise.resolve(); session.agent.steer({ role: "user", content: "text", timestamp: 0 }); },
  } as unknown as AgentSession;
  await steerWithReceipt(session, "text", undefined, (message) => identities.add(message));
  assert.equal(identities.has(messages[0]!), true);
  assert.equal(identities.has({ ...messages[0] }), false);
});


test("an enqueue followed by rejection still captures the queued identity", async () => {
  const queued = { role: "user" };
  const session = { agent: { steer(_message: object) {} }, async steer() {
    session.agent.steer(queued as never);
    throw new Error("after enqueue");
  } } as unknown as AgentSession;
  const captures: object[] = [];
  const original = session.agent.steer;
  await assert.rejects(steerWithReceipt(session, "text", undefined, (message) => captures.push(message)), /after enqueue/);
  assert.deepEqual(captures, [queued]);
  assert.equal(session.agent.steer, original);
});

test("receipt scope excludes independent calls and hook-owned messages, including handled input", async () => {
  for (const handled of [false, true]) {
    const entered = barrier();
    const release = barrier();
    const queued: object[] = [];
    const owned = { role: "user", content: "transformed" };
    const agent = { steer(message: object) { queued.push(message); } };
    const runner = { async emitInput() {
      entered.resolve(); await release.promise;
      agent.steer({ role: "user", content: "hook-owned" });
      return { action: handled ? "handled" : "transform" };
    } };
    const input = runner.emitInput;
    const session = { agent, extensionRunner: runner, async steer() {
      const result = await runner.emitInput();
      if (result.action !== "handled") agent.steer(owned);
    } } as unknown as AgentSession;
    const captures: object[] = [];
    const operation = steerWithReceipt(session, "text", undefined, (message) => captures.push(message));
    await entered.promise;
    agent.steer({ role: "user", content: "independent" });
    release.resolve(); await operation;
    assert.deepEqual(captures, handled ? [] : [owned]);
    assert.equal(queued.length, handled ? 2 : 3);
    assert.equal(runner.emitInput, input);
  }
});

test("receipt records consumption before async steer resolves and blocks late enqueue", async () => {
  const listeners = new Set<(event: any) => void>();
  let allowed = true;
  let queued = 0;
  const session = {
    subscribe(callback: (event: any) => void) { listeners.add(callback); return () => { listeners.delete(callback); }; },
    agent: { steer(message: object) {
      queued++;
      for (const listener of listeners) listener({ type: "message_start", message });
    } },
    async steer(this: AgentSession) { await Promise.resolve(); this.agent.steer({ role: "user", content: "text", timestamp: 0 }); },
  } as unknown as AgentSession;
  const receipts: boolean[] = [];
  await steerWithReceipt(session, "text", undefined, (_, consumed) => receipts.push(consumed), () => allowed);
  assert.deepEqual(receipts, [true]);
  allowed = false;
  await assert.rejects(steerWithReceipt(session, "text", undefined, () => assert.fail(), () => allowed), /settled/);
  assert.equal(queued, 1);
  assert.equal(listeners.size, 0);
});

test("steering interceptor forwards this; ambiguous reentrant captures confirm nothing", async () => {
  const queued: object[] = [];
  const agent = { steer(message: object) { assert.equal(this, agent); queued.push(message); } };
  const first = { role: "user" };
  const second = { role: "user" };
  const operation = Promise.resolve();
  const session = { agent, steer() { agent.steer(first); agent.steer(second); return operation; } } as unknown as AgentSession;
  const captures: object[] = [];
  await steerWithReceipt(session, "text", undefined, (message) => captures.push(message));
  assert.deepEqual(queued, [first, second]);
  assert.deepEqual(captures, []);
});
