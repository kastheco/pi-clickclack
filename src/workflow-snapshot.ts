import type { WorkflowSnapshot, WorkflowFiles } from "@clickclack/sdk-ts";
import type { WorkflowRunView } from "@osolmaz/pi-workflows/client";
import { isRecord, type WorkflowDecisionClient } from "./workflow-decisions.js";

// Host terminal errorMessage is arbitrary node text, not a safe operator projection.
// Only these audited, static host literals have provenance suitable for persistence.
const safeReasons = new Set([
  "An external effect needs explicit recovery.",
  "The workflow is durably paused.",
  "The workflow is waiting for origin-session input.",
  "The workflow is ready to resume.",
  "Complete workflow failure details are available.",
]);
const statuses = new Set(["queued", "running", "waiting", "paused", "completed", "failed", "timed_out", "cancelled", "ambiguous"]);
const outcomes = new Set(["ok", "timed_out", "failed", "cancelled"]);
const changes = new Set(["added", "modified", "deleted", "renamed", "copied", "type_changed", "unmerged", "untracked"]);
export function identifier(value: unknown): value is string {
  return typeof value === "string" && [...value].length > 0 && [...value].length <= 256 && !/[\p{C}]/u.test(value);
}
function check(condition: unknown): asserts condition {
  if (!condition) throw new Error("Invalid durable workflow projection");
}
function timestamp(value: unknown): value is string {
  return typeof value === "string" && value.length <= 64 && Number.isFinite(Date.parse(value));
}
function safePath(value: unknown): value is string {
  return typeof value === "string" && [...value].length <= 1024 && value.length > 0
    && !/[\\:\p{C}]/u.test(value) && value.split("/").every(part => part !== "" && part !== "." && part !== "..");
}
function filesProjection(files: WorkflowRunView["operatorArtifacts"]): WorkflowFiles | null {
  const value = files?.changedFiles;
  if (value == null) return null;
  check(value.source === "host-git" && value.basis === "cumulative-since-base" && identifier(value.baseRevision));
  check(["clean-baseline", "includes-preexisting-changes"].includes(value.attribution));
  check(typeof value.complete === "boolean" && typeof value.truncated === "boolean" && !(value.complete && value.truncated));
  check(Array.isArray(value.entries) && value.entries.length <= 500);
  return {
    source: value.source, basis: value.basis, baseRevision: value.baseRevision,
    attribution: value.attribution, complete: value.complete, truncated: value.truncated,
    entries: value.entries.map(entry => {
      check(safePath(entry.path) && changes.has(entry.change));
      check(entry.oldPath === undefined || safePath(entry.oldPath));
      return { path: entry.path, change: entry.change, ...(entry.oldPath === undefined ? {} : { oldPath: entry.oldPath }) };
    }),
  };
}

/** Fetch only attempt pages, never hydrate content references or compact graph history. */
export async function collectWorkflowSnapshot(client: WorkflowDecisionClient, sessionId: string, runId: string, discoveredSession = false): Promise<WorkflowSnapshot> {
  const response = await client.request({ operation: "view.run.get", runId, signal: AbortSignal.timeout(15_000) });
  check(response.outcome === "accepted" && isRecord(response.receipt));
  const raw = response.receipt;
  check(raw.schema === "pi-workflows.run-view.v1" && raw.runId === runId);
  // The exported host type names the trusted field; all serialized values are checked below.
  const view = raw as unknown as WorkflowRunView;
  check(identifier(sessionId) && identifier(runId) && identifier(view.queue.workflowName));
  check(view.queue.runId === runId && (view.queue.originSessionId === sessionId || (view.queue.originSessionId === null && discoveredSession)));
  check(Number.isSafeInteger(view.revision) && view.revision >= 0 && Number.isSafeInteger(view.stepTotal) && view.stepTotal >= 0);
  check(statuses.has(view.display.status) && typeof view.possiblyInterrupted === "boolean");
  check(view.display.reason === null || (typeof view.display.reason === "string" && [...view.display.reason].length <= 4096));
  check(view.queue.startedAt === null || timestamp(view.queue.startedAt));
  check(view.queue.finishedAt === null || timestamp(view.queue.finishedAt));
  const snapshot: WorkflowSnapshot = {
    schema: "clickclack.workflow-snapshot.v1",
    source: { provider: "pi-workflows", sessionId, runId, revision: view.revision },
    run: { workflowName: view.queue.workflowName, status: view.display.status, reason: view.display.reason !== null && safeReasons.has(view.display.reason) ? view.display.reason : null,
      possiblyInterrupted: view.possiblyInterrupted, startedAt: view.queue.startedAt, finishedAt: view.queue.finishedAt,
      stepTotal: view.stepTotal, stepsComplete: false },
    steps: [], files: filesProjection(view.operatorArtifacts),
  };
  const ids = new Set<string>();
  const limit = Math.min(view.stepTotal, 1000);
  let cursor = 0;
  while (cursor < limit) {
    const response = await client.request({ operation: "view.page", runId, expectedRevision: view.revision, payload: { kind: "steps", cursor }, signal: AbortSignal.timeout(15_000) });
    const page = response.receipt;
    check(response.outcome === "accepted" && isRecord(page));
    check(page.schema === "pi-workflows.run-page.v1" && page.runId === runId && page.revision === view.revision
      && page.kind === "steps" && page.cursor === cursor && Number.isSafeInteger(page.start) && page.total === view.stepTotal);
    const start = page.start as number;
    check(Array.isArray(page.items) && start >= 0 && start <= cursor && start + page.items.length > cursor && start + page.items.length <= view.stepTotal);
    // Host pages are centered windows and may overlap earlier pages. Consume only
    // the contiguous missing suffix, never duplicate overlapping attempts.
    for (const item of page.items.slice(cursor - start, limit - start)) {
      check(isRecord(item));
      check(identifier(item.attemptId) && identifier(item.nodeId) && identifier(item.nodeType));
      check(typeof item.outcome === "string" && outcomes.has(item.outcome) && timestamp(item.startedAt) && timestamp(item.finishedAt));
      check(!ids.has(item.attemptId)); ids.add(item.attemptId);
      snapshot.steps.push({ attemptId: item.attemptId, nodeId: item.nodeId, nodeType: item.nodeType,
        outcome: item.outcome as WorkflowSnapshot["steps"][number]["outcome"], startedAt: item.startedAt, finishedAt: item.finishedAt });
    }
    cursor = start + page.items.length;
  }
  // Deterministic oldest-first prefix, bounded by count AND serialized bytes.
  while (Buffer.byteLength(JSON.stringify(snapshot)) > 512 * 1024 && snapshot.steps.length > 0) snapshot.steps.pop();
  snapshot.run.stepsComplete = snapshot.steps.length === view.stepTotal;
  check(Buffer.byteLength(JSON.stringify(snapshot)) <= 512 * 1024);
  return snapshot;
}
