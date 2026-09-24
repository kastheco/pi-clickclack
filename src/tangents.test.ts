import assert from "node:assert/strict";
import test from "node:test";

import type { RealtimeEvent } from "@clickclack/sdk-ts";
import type { AgentSessionRuntime, FileEntry } from "@earendil-works/pi-coding-agent";

import type { Logger } from "./logger.js";
import {
  TangentHost,
  forkEntriesFromSessionText,
  unboundTangentReply,
  type TangentHostOptions,
  type TangentRecord,
  type TangentTransport,
} from "./tangents.js";

const quiet: Logger = {
  debug() {},
  info() {},
  warn() {},
  error() {},
  child() {
    return quiet;
  },
};

const sessionText = [
  JSON.stringify({ type: "session", version: 3, id: "main-session", timestamp: "2026-01-01T00:00:00Z", cwd: "/proj" }),
  JSON.stringify({ type: "message", id: "e1", parentId: null, timestamp: "2026-01-01T00:00:01Z", message: { role: "user", content: "refactor the sidebar" } }),
  "",
].join("\n");

test("a fork copies the history under a new session id that points at its source", () => {
  const entries = forkEntriesFromSessionText(sessionText, "/sessions/main.jsonl", new Date("2026-02-02T00:00:00Z"), "fork-id");
  assert.ok(entries);
  const header = entries[0] as FileEntry & { id: string; parentSession?: string; timestamp: string; cwd: string };
  assert.equal(header.id, "fork-id");
  assert.equal(header.parentSession, "/sessions/main.jsonl");
  assert.equal(header.timestamp, "2026-02-02T00:00:00.000Z");
  assert.equal(header.cwd, "/proj");
  assert.equal(entries.length, 2);
  assert.equal((entries[1] as { id: string }).id, "e1");
  assert.equal(forkEntriesFromSessionText("", "/x"), undefined);
});

type Harness = {
  host: TangentHost;
  calls: string[];
  posts: Array<[string, string]>;
  forks: Array<{ projectAlias: string; entries: FileEntry[] | undefined }>;
  runtimes: FakeRuntime[];
  release: () => void;
};

type FakeRuntime = { aborted: number; disposed: number; prompts: string[] };

const tangent = (overrides: Partial<TangentRecord> = {}): TangentRecord => ({
  id: "tng_1",
  workspace_id: "ws_1",
  channel_id: "chn_1",
  owner_user_id: "usr_owner",
  bot_user_id: "usr_bot",
  created_at: "2026-01-01T00:00:00Z",
  ...overrides,
});

function harness(options: Partial<TangentHostOptions> & { hold?: boolean; bound?: boolean; remote?: TangentRecord } = {}): Harness {
  const calls: string[] = [];
  const posts: Array<[string, string]> = [];
  const forks: Harness["forks"] = [];
  const runtimes: FakeRuntime[] = [];
  let release = () => {};
  const gate = options.hold ? new Promise<void>((resolve) => (release = resolve)) : Promise.resolve();
  const transport: TangentTransport = {
    async get(id) {
      calls.push(`get:${id}`);
      return options.remote?.id === id ? options.remote : undefined;
    },
    async post(id, body) {
      calls.push(`post:${body}`);
      posts.push([id, body]);
    },
    async activity(_id, state) {
      calls.push(`activity:${state}`);
    },
  };
  const host = new TangentHost({
    transport,
    workspaceId: "ws_1",
    ownerIds: ["usr_owner"],
    selfId: () => "usr_bot",
    resolveSource: () => (options.bound === false ? undefined : { projectAlias: "proj", sessionFile: "/sessions/main.jsonl" }),
    readSessionFile: () => sessionText,
    createRuntime: async (projectAlias, entries) => {
      forks.push({ projectAlias, entries });
      const fake: FakeRuntime = { aborted: 0, disposed: 0, prompts: [] };
      runtimes.push(fake);
      return {
        session: { abort: async () => void (fake.aborted += 1) },
        dispose: async () => void (fake.disposed += 1),
        fake,
      } as unknown as AgentSessionRuntime;
    },
    runTurn: async (runtime, prompt) => {
      const fake = (runtime as unknown as { fake: FakeRuntime }).fake;
      fake.prompts.push(prompt);
      calls.push(`turn:${prompt}`);
      await gate;
      return `answer to ${prompt}`;
    },
    logger: quiet,
    ...options,
  });
  return { host, calls, posts, forks, runtimes, release: () => release() };
}

const event = (type: string, payload: Record<string, unknown>, workspace = "ws_1"): RealtimeEvent =>
  ({ id: "eph_1", cursor: "", type, workspace_id: workspace, created_at: "", payload }) as unknown as RealtimeEvent;

const opened = (record = tangent()) => event("tangent.opened", { tangent: record, tangent_id: record.id });
const said = (body: string, author = "usr_owner", tangentId = "tng_1") =>
  event("tangent.message", { tangent_id: tangentId, message: { id: `tgm_${body}`, tangent_id: tangentId, author_id: author, body } });

test("an owner's question runs on a fork of the bound session and the answer goes back to the tangent", async () => {
  const { host, calls, posts, forks } = harness();
  assert.equal(await host.handle(opened()), true);
  assert.equal(forks.length, 1, "forks as soon as the tangent opens");
  assert.equal(forks[0]?.projectAlias, "proj");
  assert.equal((forks[0]?.entries?.[0] as { parentSession?: string }).parentSession, "/sessions/main.jsonl");

  await host.handle(said("what's the plan?"));
  await host.handle(said("answer to what's the plan?", "usr_bot"));
  await host.waitForIdle();
  assert.deepEqual(calls, ["activity:working", "turn:what's the plan?", "post:answer to what's the plan?", "activity:idle"]);
  assert.deepEqual(posts, [["tng_1", "answer to what's the plan?"]]);
});

test("frames for another bot, owner, or workspace are ignored, and other events pass through", async () => {
  const { host, calls, forks } = harness();
  assert.equal(await host.handle(event("message.created", {})), false);
  await host.handle(opened(tangent({ bot_user_id: "usr_other_bot" })));
  await host.handle(opened(tangent({ id: "tng_2", owner_user_id: "usr_stranger" })));
  await host.handle(event("tangent.opened", { tangent: tangent({ id: "tng_3" }) }, "ws_other"));
  assert.equal(forks.length, 0);
  assert.equal(host.size, 0);

  await host.handle(opened());
  await host.handle(said("sneaky", "usr_stranger"));
  await host.waitForIdle();
  assert.deepEqual(calls, []);
});

test("an unbound conversation gets told how to bind instead of a fork", async () => {
  const { host, posts, forks } = harness({ bound: false });
  await host.handle(opened());
  await host.handle(said("hello?"));
  await host.waitForIdle();
  assert.equal(forks.length, 0);
  assert.deepEqual(posts, [["tng_1", unboundTangentReply]]);
});

test("a tangent opened while the bridge was away is recovered on its first message", async () => {
  const { host, calls, posts } = harness({ remote: tangent({ id: "tng_late" }) });
  await host.handle(said("still there?", "usr_owner", "tng_late"));
  await host.waitForIdle();
  assert.equal(calls[0], "get:tng_late");
  assert.deepEqual(posts, [["tng_late", "answer to still there?"]]);

  await host.handle(said("unknown", "usr_owner", "tng_missing"));
  await host.waitForIdle();
  assert.equal(posts.length, 1);
});

test("a running turn never blocks other events, and turns in one tangent stay in order", async () => {
  const { host, calls, release } = harness({ hold: true });
  await host.handle(opened());
  // handle() must resolve while the turn is still running.
  await host.handle(said("first"));
  await host.handle(said("second"));
  assert.deepEqual(calls, ["activity:working", "turn:first"]);
  release();
  await host.waitForIdle();
  assert.deepEqual(calls, [
    "activity:working", "turn:first", "post:answer to first", "activity:idle",
    "activity:working", "turn:second", "post:answer to second", "activity:idle",
  ]);
});

test("closing aborts the fork, disposes it, and drops the late answer", async () => {
  const { host, calls, runtimes, release } = harness({ hold: true });
  await host.handle(opened());
  await host.handle(said("long question"));
  await host.handle(event("tangent.closed", { tangent_id: "tng_1", reason: "closed" }));
  assert.equal(runtimes[0]?.aborted, 1);
  assert.equal(runtimes[0]?.disposed, 1);
  assert.equal(host.size, 0);
  release();
  await new Promise((resolve) => setImmediate(resolve));
  assert.ok(!calls.some((call) => call.startsWith("post:")), `late answer was posted: ${calls.join(", ")}`);
});
