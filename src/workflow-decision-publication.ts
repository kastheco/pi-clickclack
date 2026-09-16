import { createHash } from "node:crypto";

/** Author-scoped ClickClack nonce: deterministic across retries, isolated across targets and hosts. */
export function decisionPublicationNonce(input: {
  hostIdentity: string; producerId: string; workspaceId: string; targetType: string; targetId: string;
  decision: { runId: string; requestId: string; revision: number };
}): string {
  return `pi-decision-${createHash("sha256").update(JSON.stringify([
    input.hostIdentity, input.producerId, input.workspaceId, input.targetType, input.targetId,
    input.decision.runId, input.decision.requestId, input.decision.revision,
  ])).digest("hex")}`;
}
