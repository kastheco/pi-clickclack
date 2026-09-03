/**
 * Reads the operator-facing state of a workflow run.
 *
 * The bridge already subscribes to each bound session's view to find human
 * decisions. That same event carries the run: status, the steps taken, and what
 * the run is waiting on. This module reads the part an operator can be shown
 * and drops the rest, so a status surface never has to talk to the workflow
 * host on its own.
 *
 * What is dropped matters as much as what is kept. A step record carries the
 * full agent prompt and the raw node output, and the run view carries workflow
 * state and manifest. None of that was written for an operator to read, and the
 * same reasoning already keeps `decisionForOperator` off the decision subject:
 * present what the workflow author meant to show, never derive a view from
 * execution detail.
 */

import { isRecord } from "./workflow-decisions.js";

/** Operator-facing status of a run, as the host itself describes it. */
export type RunStatus =
  | "queued"
  | "running"
  | "waiting"
  | "paused"
  | "completed"
  | "failed"
  | "timed_out"
  | "cancelled"
  | "ambiguous";

const runStatuses = new Set<string>([
  "queued",
  "running",
  "waiting",
  "paused",
  "completed",
  "failed",
  "timed_out",
  "cancelled",
  "ambiguous",
]);

/** How one attempted step finished. */
export type StepOutcome = "ok" | "timed_out" | "failed" | "cancelled";

const stepOutcomes = new Set<string>(["ok", "timed_out", "failed", "cancelled"]);

/** One step a run has taken. Identity and timing only, never its content. */
export type RunStep = {
  attemptId: string;
  nodeId: string;
  nodeType: string;
  outcome: StepOutcome;
  startedAt: string;
  finishedAt: string;
};

/** One run, reduced to what an operator can be shown. */
export type RunView = {
  runId: string;
  workflowName: string;
  revision: number;
  status: RunStatus;
  /**
   * Why the run is in this status, when the host offers a reason.
   *
   * Host-authored and operator-facing. `reasonContent` is deliberately not
   * read: it is structured execution detail, not display copy.
   */
  reason: string | null;
  /** True while the host still considers this run live. */
  live: boolean;
  /**
   * True when the host cannot confirm the run survived its last write.
   *
   * Worth surfacing rather than hiding: a run in this state may need an
   * operator to look at it.
   */
  possiblyInterrupted: boolean;
  startedAt: string | null;
  finishedAt: string | null;
  /** Steps taken so far, oldest first. May be a window, not the whole run. */
  steps: RunStep[];
  /** Total steps the run has taken, which can exceed `steps.length`. */
  stepTotal: number;
};

/**
 * Reads the run from one session-view subscription event.
 *
 * Returns undefined for an event carrying no run, which is the ordinary case
 * for a session that has never started one. Anything malformed also reads as
 * undefined rather than as a partial run: a status view showing half a run is
 * worse than showing none.
 */
export function sessionRun(event: unknown): RunView | undefined {
  if (!isRecord(event)) return undefined;
  const view = event.view;
  if (!isRecord(view)) return undefined;
  return readRunView(view.run);
}

/** Reads one run view, as delivered by the host. */
export function readRunView(value: unknown): RunView | undefined {
  if (!isRecord(value)) return undefined;

  const runId = typeof value.runId === "string" ? value.runId : undefined;
  const revision = typeof value.revision === "number" ? value.revision : undefined;
  if (runId === undefined || revision === undefined) return undefined;

  const display = isRecord(value.display) ? value.display : undefined;
  const status = typeof display?.status === "string" && runStatuses.has(display.status)
    ? display.status as RunStatus
    : undefined;
  if (status === undefined) return undefined;

  const queue = isRecord(value.queue) ? value.queue : undefined;
  const workflowName = typeof queue?.workflowName === "string" ? queue.workflowName : undefined;
  if (workflowName === undefined) return undefined;

  return {
    runId,
    workflowName,
    revision,
    status,
    reason: typeof display?.reason === "string" ? display.reason : null,
    live: value.live === true,
    possiblyInterrupted: value.possiblyInterrupted === true,
    startedAt: typeof queue?.startedAt === "string" ? queue.startedAt : null,
    finishedAt: typeof queue?.finishedAt === "string" ? queue.finishedAt : null,
    steps: readSteps(value.graphSteps),
    stepTotal: typeof value.stepTotal === "number" ? value.stepTotal : 0,
  };
}

/**
 * Reads the step records a run has produced.
 *
 * Only identity, outcome, and timing are taken. `prompt` and `output` are left
 * behind deliberately: they hold the agent's full prompt text and raw node
 * results, which no status view should be able to leak by accident.
 */
function readSteps(value: unknown): RunStep[] {
  if (!Array.isArray(value)) return [];
  const steps: RunStep[] = [];
  for (const entry of value) {
    if (!isRecord(entry)) continue;
    const { attemptId, nodeId, nodeType, outcome, startedAt, finishedAt } = entry;
    if (typeof attemptId !== "string") continue;
    if (typeof nodeId !== "string") continue;
    if (typeof nodeType !== "string") continue;
    if (typeof outcome !== "string" || !stepOutcomes.has(outcome)) continue;
    if (typeof startedAt !== "string" || typeof finishedAt !== "string") continue;
    steps.push({
      attemptId,
      nodeId,
      nodeType,
      outcome: outcome as StepOutcome,
      startedAt,
      finishedAt,
    });
  }
  return steps;
}
