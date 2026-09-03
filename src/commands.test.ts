import assert from "node:assert/strict";
import test from "node:test";

import { parseSlashInvocation, runtimeBotCommandMenu } from "./commands.js";

type RegisteredCommand = { invocationName: string; description?: string };

function runtime(commands: readonly RegisteredCommand[]): Parameters<typeof runtimeBotCommandMenu>[0] {
  return {
    session: {
      extensionRunner: {
        getRegisteredCommands: () => commands,
      },
      promptTemplates: [],
    },
  } as unknown as Parameters<typeof runtimeBotCommandMenu>[0];
}

test("a namespaced command reaches the ClickClack command menu", () => {
  const menu = runtimeBotCommandMenu(runtime([
    { invocationName: "kas", description: "Run the lifecycle" },
    { invocationName: "kas:cook", description: "Run the full lifecycle" },
    { invocationName: "kas:check", description: "Review only" },
    { invocationName: "kas-runs", description: "Report the active run" },
  ]));

  assert.deepEqual(menu.map((entry) => entry.command), [
    "kas",
    "kas:cook",
    "kas:check",
    "kas-runs",
  ]);
});

test("a name ClickClack cannot represent is dropped rather than published", () => {
  const menu = runtimeBotCommandMenu(runtime([
    { invocationName: "kas", description: "keep" },
    { invocationName: "kas:", description: "empty namespace" },
    { invocationName: "kas:cook:extra", description: "nested namespace" },
    { invocationName: "kas cook", description: "space" },
    { invocationName: "Kas", description: "uppercase" },
    { invocationName: "skill:review", description: "skill namespace" },
  ]));

  assert.deepEqual(menu.map((entry) => entry.command), ["kas", "skill:review"]);
});

test("a namespaced command parses as one invocation with its arguments", () => {
  assert.deepEqual(parseSlashInvocation("/kas:cook add a health endpoint"), {
    raw: "/kas:cook add a health endpoint",
    name: "kas:cook",
    args: "add a health endpoint",
  });
  assert.deepEqual(parseSlashInvocation("/kas:cook"), {
    raw: "/kas:cook",
    name: "kas:cook",
    args: "",
  });
});
