/**
 * Publishes a conversation's workflow run state to ClickClack.
 *
 * The host emits a session view on every change to that session, most of which
 * do not change anything an operator can see: a revision bump, a trace append,
 * a settings scope. Forwarding all of them would put a frame on the socket for
 * every internal write.
 *
 * So this holds the last published frame per conversation and publishes only on
 * a visible difference. `revision` is deliberately excluded from that
 * comparison, because it moves on writes that change nothing visible.
 *
 * Frames are ephemeral. They are the live state of a run, not a record of it,
 * and a client that reconnects gets the next frame rather than a replay.
 */

import type { RunView } from "./workflow-run-view.js";

/** Publishes one run frame to one conversation. */
export type RunFramePublisher = (run: RunView | null) => Promise<void>;

export type WorkflowRunReporterOptions = {
  publish: RunFramePublisher;
  /** Publishing is cosmetic, so a failure is reported and swallowed. */
  onError?: (error: unknown) => void;
};

/**
 * Tracks one conversation's run and publishes it when it visibly changes.
 *
 * Not restart-safe by design: after a bridge restart the first observed view
 * publishes, because the client has nothing either.
 */
export class WorkflowRunReporter {
  private readonly options: WorkflowRunReporterOptions;
  /**
   * Fingerprint of the last frame published, or undefined before anything has
   * been sent.
   *
   * Distinct from the fingerprint of "no run": a session that never had a run
   * must publish nothing at all, while a run that ends must publish a frame
   * clearing it.
   */
  private published: string | undefined;
  private stopped = false;

  constructor(options: WorkflowRunReporterOptions) {
    this.options = options;
  }

  /**
   * Reports the current run, publishing only when the operator-visible state
   * differs from the last frame sent.
   */
  report(run: RunView | undefined): void {
    if (this.stopped) return;
    const next = fingerprint(run);
    if (next === this.published) return;
    // Nothing has been published, and there is no run: the client already agrees
    // that this conversation has none, so an empty frame would say nothing.
    if (this.published === undefined && run === undefined) return;
    this.published = next;
    void this.options.publish(run ?? null).catch((error) => {
      // The frame did not land, so forget it: the next report must retry rather
      // than assume the client already has this state.
      if (this.published === next) this.published = undefined;
      this.options.onError?.(error);
    });
  }

  /**
   * Stops reporting and clears the conversation's run.
   *
   * A conversation whose watcher goes away would otherwise leave its last frame
   * on screen forever, since nothing else ever contradicts it.
   */
  stop(): void {
    if (this.stopped) return;
    this.stopped = true;
    if (this.published === undefined) return;
    this.published = undefined;
    void this.options.publish(null).catch((error) => this.options.onError?.(error));
  }
}

/**
 * Reduces a run to the operator-visible state a frame carries.
 *
 * Step identity and outcome are included, so a step finishing publishes, while
 * `revision` is excluded because it moves on writes that change nothing here.
 */
function fingerprint(run: RunView | undefined): string {
  if (run === undefined) return "none";
  return JSON.stringify([
    run.runId,
    run.workflowName,
    run.status,
    run.reason,
    run.live,
    run.possiblyInterrupted,
    run.startedAt,
    run.finishedAt,
    run.stepTotal,
    run.steps.map((step) => [step.attemptId, step.nodeId, step.outcome, step.finishedAt]),
  ]);
}
