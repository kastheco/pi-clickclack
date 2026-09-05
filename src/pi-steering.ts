import type { AgentSession, PromptOptions } from "@earendil-works/pi-coding-agent";

const intercepting = new WeakSet<object>();

/** Pi 0.85.1 enqueues synchronously and emits the same user object at message_start.
 * Capture identity only: cloned/asynchronously enqueued messages remain unconfirmed.
 */
export function steerWithReceipt(
  session: AgentSession,
  text: string,
  images: PromptOptions["images"],
  capture: (message: object) => void,
): Promise<void> {
  const agent = session.agent;
  if (intercepting.has(agent)) throw new Error("reentrant steering receipt capture");
  const original = agent.steer;
  const messages: object[] = [];
  intercepting.add(agent);
  agent.steer = function (...args) {
    messages.push(args[0]);
    return original.apply(this, args);
  };
  try {
    const operation = session.steer(text, images);
    // queue_update listeners can reenter the SDK directly. Ambiguous captures
    // confirm nothing rather than assigning another caller's message a receipt.
    if (messages.length === 1) capture(messages[0]!);
    return operation;
  } finally {
    agent.steer = original;
    intercepting.delete(agent);
  }
}
