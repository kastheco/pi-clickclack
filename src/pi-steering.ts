import { AsyncLocalStorage } from "node:async_hooks";
import type { AgentSession, PromptOptions } from "@oh-my-pi/pi-coding-agent";

const intercepting = new WeakSet<object>();
const receiptScope = new AsyncLocalStorage<object | undefined>();

/** Omp queues the same message object it emits in message_start. Capture only the
 * object submitted by this steer call, excluding input-hook-owned messages. */
export async function steerWithReceipt(
  session: AgentSession,
  text: string,
  images: PromptOptions["images"],
  capture: (message: object, consumed: boolean) => void,
  canEnqueue: () => boolean = () => true,
): Promise<void> {
  const agent = session.agent;
  if (intercepting.has(agent)) throw new Error("reentrant steering receipt capture");
  const scope = {};
  const original = agent.steer;
  const runner = session.extensionRunner;
  const originalInput = runner?.emitInput;
  const messages: object[] = [];
  const consumed = new WeakSet<object>();
  let capturing = true;
  const unsubscribe = session.subscribe?.((event) => {
    if (event.type === "message_start") consumed.add(event.message);
  });
  const intercept: typeof original = function (this: typeof agent, ...args) {
    if (capturing && receiptScope.getStore() === scope) {
      if (!canEnqueue()) throw new Error("steering turn settled before enqueue");
      messages.push(args[0]);
    }
    return original.apply(this, args);
  };
  const input: typeof originalInput = originalInput && function (this: NonNullable<typeof runner>, ...args) {
    return receiptScope.run(undefined, () => originalInput.apply(this, args));
  };
  intercepting.add(agent);
  agent.steer = intercept;
  if (runner && input) runner.emitInput = input;
  try {
    await receiptScope.run(scope, () => session.steer(text, images));
  } finally {
    capturing = false;
    if (agent.steer === intercept) agent.steer = original;
    if (runner && input && runner.emitInput === input) runner.emitInput = originalInput!;
    intercepting.delete(agent);
    unsubscribe?.();
    if (messages.length === 1) capture(messages[0]!, consumed.has(messages[0]!));
  }
}
