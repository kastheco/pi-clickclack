#!/usr/bin/env bun
// run inside a bot container. drives the shared extension set through real
// model turns the way the bridge does: extension init with session_start, a
// forced context-mode tool call, a compaction, and a follow-up turn. pair with a
// before/after file listing of the writable mounts to see where extensions write.
//   bun scripts/smoke/extension-probe.ts <cwd>
import { createAgentSession, SessionManager } from "@oh-my-pi/pi-coding-agent";
import { initializeExtensions } from "@oh-my-pi/pi-coding-agent/modes/runtime-init";

const cwd = process.argv[2] ?? process.cwd();
const agentDir = process.env.PI_CODING_AGENT_DIR;
const { session, extensionsResult } = await createAgentSession({
  cwd,
  agentDir,
  sessionManager: SessionManager.create(cwd, `${agentDir}/sessions`),
  additionalExtensionPaths: JSON.parse(process.env.CLICKCLACK_OMP_EXTENSION_PATHS ?? "[]") as string[],
  disableExtensionDiscovery: true,
  modelPattern: process.env.CLICKCLACK_PI_MODEL,
  thinkingLevel: "low",
  hasUI: false,
} as Parameters<typeof createAgentSession>[0]);
const runtimeErrors: unknown[] = [];
await initializeExtensions(session, {
  mode: "rpc",
  reportSendError: (action, error) => runtimeErrors.push({ action, error: error.message }),
  reportRuntimeError: (error) => runtimeErrors.push(error),
});

const toolCalls: string[] = [];
session.subscribe((event) => {
  if (event.type === "tool_execution_start") toolCalls.push(event.toolName);
});
const reply = () => {
  const last = session.messages.at(-1) as { content?: Array<{ type: string; text?: string }> };
  return last?.content?.filter((part) => part.type === "text").map((part) => part.text).join(" ").slice(0, 200);
};

await session.prompt("call the ctx_execute tool with language shell and code `echo probe-ok`, then reply with its output only.");
const first = reply();
const compacted = await session.compact().then(() => true, (error: Error) => error.message);
await session.prompt("in one line: what did the earlier shell command print? no tools.");

console.log(JSON.stringify({
  loaded: session.extensionRunner?.getLoadedExtensions().map((extension) => extension.resolvedPath),
  loadErrors: extensionsResult?.errors,
  runtimeErrors,
  ctxAndLcmTools: session.getAllToolNames().filter((name) => /ctx_|lcm_/.test(name)),
  toolCalls,
  first,
  compacted,
  afterCompact: reply(),
  sessionFile: session.sessionFile,
}, null, 2));
await session.dispose();
process.exit(0);
