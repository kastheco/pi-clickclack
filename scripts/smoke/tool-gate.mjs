import { isDeepStrictEqual } from 'node:util';

// Pi 0.85.1's public Agent.beforeToolCall blocks before execute(), unlike
// tool_execution_start (an observational event). Preserve AgentSession's hook
// so installed extension tool_call handlers still run for the permitted read.
// Check again afterwards: those handlers may mutate the validated arguments.
export function installSmokeToolGate(agent, expectedPath) {
  const previous = agent.beforeToolCall;
  let reads = 0;
  const violations = [];
  const allowed = ({ toolCall, args }) => toolCall.name === 'read'
    && isDeepStrictEqual(toolCall.arguments, { path: expectedPath })
    && isDeepStrictEqual(args, { path: expectedPath });
  const block = () => {
    const reason = 'smoke permits only one read of the exact repository package.json';
    violations.push(reason);
    return { block: true, reason, terminate: true };
  };
  const gate = async (context, signal) => {
    if (reads !== 0 || !allowed(context)) return block();
    const result = await previous?.call(agent, context, signal);
    if (result?.block) return result;
    if (reads !== 0 || !allowed(context)) return block();
    reads++;
    return result;
  };
  agent.beforeToolCall = gate;
  return {
    violations,
    assertInstalled() {
      if (agent.beforeToolCall !== gate) throw new Error('smoke execution gate was replaced');
    },
  };
}
