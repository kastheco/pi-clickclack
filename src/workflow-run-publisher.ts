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
 * Publication is serialized through one chain. Frames describe absolute state
 * rather than deltas, so two in flight at once could land out of order and
 * leave the client showing a run that has already moved on. The dangerous case
 * is a clear racing an earlier frame: the clear lands, the stale run lands
 * after it, and a conversation whose watcher has stopped shows a live run
 * forever.
 *
 * Frames are ephemeral. They are the live state of a run, not a record of it,
 * and there is no replay: a client that reconnects sees nothing for a run whose
 * visible state never changes again. That is a real gap rather than a design
 * choice, and a reconnect-triggered republish belongs here later.
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
  /**
   * Serializes publication so frames land in the order they were decided.
   *
   * Always resolves: a failed publish is recorded and reported, never rethrown
   * into the chain, so one failure cannot strand every later frame.
   */
  private chain: Promise<void> = Promise.resolve();

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
    // Recorded before the publish resolves, so the next report compares against
    // the frame already queued rather than re-sending it.
    this.published = next;
    this.enqueue(run ?? null, next);
  }

  /** Resolves after every frame queued so far has settled. */
  drain(): Promise<void> {
    return this.chain;
  }

  /**
   * Stops reporting and clears the conversation's run.
   *
   * A conversation whose watcher goes away would otherwise leave its last frame
   * on screen forever, since nothing else ever contradicts it.
   */
  stop(): Promise<void> {
    if (this.stopped) return this.chain;
    this.stopped = true;
    if (this.published === undefined) return this.chain;
    this.published = undefined;
    // Queued behind everything already in flight, so the clear cannot land
    // before a frame decided earlier and then be overwritten by it.
    this.enqueue(null, undefined);
    return this.chain;
  }

  /** Queues one frame behind the frames already in flight. */
  private enqueue(run: RunView | null, sent: string | undefined): void {
    this.chain = this.chain.then(async () => {
      try {
        await this.options.publish(run);
      } catch (error) {
        // The frame did not land, so forget it: the next report must retry
        // rather than assume the client has this state. Only when it is still
        // the newest decision, or this would discard a frame queued after it.
        if (this.published === sent) this.published = undefined;
        this.options.onError?.(error);
      }
    });
  }
}

/**
 * Reduces a run to the operator-visible state a frame carries.
 *
 * Every field the frame carries is included, so nothing visible can change
 * without publishing. `revision` is the one exclusion, because it moves on
 * writes that change nothing here.
 */
function fingerprint(run: RunView | undefined): string {
  if (run === undefined) return "none";
  const { revision: _revision, ...visible } = run;
  return JSON.stringify(visible);
}
