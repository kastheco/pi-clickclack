#!/usr/bin/env bun
// run inside a bot container. drives the shared extension set through real
// model turns the way the bridge does: extension init with session_start, a
// forced context-mode tool call, a compaction, and a follow-up turn. pair with a
// before/after file listing of the writable mounts to see where extensions write.
// exits 1 when any of those steps didn't happen.
//   bun scripts/smoke/extension-probe.ts <cwd>
import { createAgentSession, SessionManager } from "@oh-my-pi/pi-coding-agent";
import { initializeExtensions } from "@oh-my-pi/pi-coding-agent/modes/runtime-init";
import { cfgCompactionKeepRecentTokens } from "@oh-my-pi/pi-coding-agent/session/context-settings";

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

// extension tools are mounted as xd:// devices, so the model usually reaches
// ctx_execute through `write xd://ctx_execute`. count both dispatch shapes.
const toolCalls: string[] = [];
const ctxExecuteCalls = new Set<string>();
const ctxExecuteErrors: unknown[] = [];
session.subscribe((event) => {
  if (event.type === "tool_execution_start") {
    const device = event.toolName === "write" && typeof event.args?.path === "string" ? event.args.path : undefined;
    toolCalls.push(device ? `${event.toolName} ${device}` : event.toolName);
    if (event.toolName === "ctx_execute" || device === "xd://ctx_execute") ctxExecuteCalls.add(event.toolCallId);
  }
  if (event.type === "tool_execution_end" && ctxExecuteCalls.has(event.toolCallId) && event.isError) {
    ctxExecuteErrors.push(event.result);
  }
});
const reply = () => {
  const last = session.messages.at(-1) as { content?: Array<{ type: string; text?: string }> };
  return last?.content?.filter((part) => part.type === "text").map((part) => part.text).join(" ").slice(0, 200);
};

await session.prompt("call the ctx_execute tool with language shell and code `echo probe-ok`, then reply with its output only.");
const first = reply();
// a second turn plus a tiny runtime-only keepRecentTokens gives compaction a
// whole earlier turn to summarize. the default 20000 leaves a probe-sized
// session uncompactable. nothing is written to the bot's config.
await session.prompt("reply with the word second only. no tools.");
cfgCompactionKeepRecentTokens.override(session.settings, 1);
const compacted = await session.compact().then(() => true, (error: Error) => error.message);
await session.prompt("in one line: what did the earlier shell command print? no tools.");
const afterCompact = reply();

const result = {
  loaded: session.extensionRunner?.getLoadedExtensions().map((extension) => extension.resolvedPath),
  loadErrors: extensionsResult?.errors ?? [],
  runtimeErrors,
  ctxAndLcmTools: session.getAllToolNames().filter((name) => /ctx_|lcm_/.test(name)),
  toolCalls,
  ctxExecuteCalls: ctxExecuteCalls.size,
  ctxExecuteErrors,
  first,
  compacted,
  afterCompact,
  sessionFile: session.sessionFile,
};
const failures = [
  result.loadErrors.length > 0 && "extension load errors",
  runtimeErrors.length > 0 && "extension runtime errors",
  ctxExecuteCalls.size === 0 && "ctx_execute was never called",
  ctxExecuteErrors.length > 0 && "ctx_execute returned an error",
  !first?.includes("probe-ok") && "first reply lacks probe-ok",
  compacted !== true && "compaction did not run",
  !afterCompact?.includes("probe-ok") && "post-compaction reply lacks probe-ok",
].filter(Boolean);
console.log(JSON.stringify({ ...result, failures }, null, 2));
await session.dispose();
process.exit(failures.length ? 1 : 0);
