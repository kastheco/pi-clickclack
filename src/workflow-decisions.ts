/**
 * Surfaces Pi Workflows human decisions in ClickClack.
 *
 * A workflow that reaches a `humanDecision` node stops and waits for a person.
 * Pi Workflows 0.16.0 delivers those through one versioned client protocol: a
 * presenter watches a session, claims one pending decision at an exact
 * revision, presents it, then answers. A claim held by another presenter is
 * skipped rather than contested, so the Pi TUI and this bridge can watch the
 * same session without stealing decisions from each other.
 *
 * This module owns only the watch-and-claim half. Rendering the decision into a
 * conversation and collecting the operator's reply belong to the service, which
 * already owns ClickClack transport and the durable turn claim.
 */

/**
 * Mirrors `ClientInteractiveRequest` from `@osolmaz/pi-workflows/client`.
 *
 * Pi Workflows 0.16.0 defines the type in `dist/client/view.d.ts` but omits it
 * from the `./client` barrel, and package exports block the deep path. Only the
 * fields this watcher reads are declared. Replace this with the upstream import
 * once the barrel re-exports it.
 */
export type WorkflowInteractiveRequest = {
  requestId: string;
  runId: string;
  revision: number;
  kind: "agent" | "assistant" | "decision";
  status: "pending" | "presenting" | "settled" | "cancelled";
  contract: unknown;
  presentationClaimExpiresAt: string | null;
};

/** One decision this bridge has claimed and must now present. */
export type ClaimedWorkflowDecision = {
  requestId: string;
  runId: string;
  revision: number;
  /** Short operator-facing title, always present on a v1 request. */
  title: string;
  /** One-line summary shown before any detail blocks. */
  summary: string;
  /** Ordered choice keys and their operator-facing labels. */
  choices: readonly { key: string; label: string; expectsInput: boolean }[];
};

export type WorkflowDecisionClient = {
  clientId: string;
  ensureAvailable(): Promise<unknown>;
  watchSession(
    sessionId: string,
    listener: (event: unknown) => void,
  ): Promise<() => Promise<void>>;
  request(options: {
    operation: string;
    requestId?: string;
    idempotencyKey?: string;
    runId?: string;
    expectedRevision?: number;
    payload?: unknown;
  }): Promise<{ outcome: string; revision?: number; error?: string }>;
  requestDurable(options: {
    operation: string;
    idempotencyKey: string;
    runId?: string;
    expectedRevision?: number;
    payload?: unknown;
  }): Promise<{ outcome: string; revision?: number; error?: string }>;
};

export type WorkflowDecisionWatcherOptions = {
  client: WorkflowDecisionClient;
  sessionId: string;
  /** Presents one claimed decision. Resolves to the chosen key, or undefined to release it. */
  present: (decision: ClaimedWorkflowDecision) => Promise<DecisionAnswer | undefined>;
  /**
   * Reports the session's run state on every view event.
   *
   * The session view carries the run alongside its pending interactions, so
   * observing it here costs nothing beyond a callback: a second subscription
   * for the same events would double the host's work and could disagree with
   * this one about ordering. `undefined` means the session has no run.
   *
   * Reporting must not throw. A failure to publish run state is cosmetic, while
   * an exception here would abandon the decision pass that shares this event.
   */
  onRun?: (event: unknown) => void;
  onError?: (error: unknown) => void;
};

export type DecisionAnswer = {
  choice: string;
  input?: Record<string, string>;
};

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Stable identity for one answer to one decision revision.
 *
 * Includes the collected input, so correcting a replan instruction is a new
 * attempt rather than a repeat of the previous one under the same key.
 */
function answerKey(
  interaction: WorkflowInteractiveRequest,
  answer: DecisionAnswer,
): string {
  const input = answer.input === undefined ? "" : JSON.stringify(answer.input);
  return `${interaction.requestId}:${interaction.revision}:${answer.choice}:${input}`;
}

/** True when another presenter holds an unexpired claim on this decision. */
export function claimIsLive(
  interaction: WorkflowInteractiveRequest,
  now: number = Date.now(),
): boolean {
  const expiry = interaction.presentationClaimExpiresAt;
  return expiry !== null && Date.parse(expiry) > now;
}

/** Extracts the view carried by one real or test session subscription event. */
export function workflowSessionView(event: unknown): Record<string, unknown> | undefined {
  if (!isRecord(event)) return undefined;
  if (event.type === "event") {
    if (event.event !== "session_snapshot" || !isRecord(event.payload)) return undefined;
    return event.payload;
  }
  return isRecord(event.view) ? event.view : undefined;
}

/** Extracts pending interactions from one session-view subscription event. */
export function sessionInteractions(event: unknown): WorkflowInteractiveRequest[] | undefined {
  const view = workflowSessionView(event);
  if (view === undefined) return undefined;
  const pending = view.pendingInteractions;
  if (!Array.isArray(pending)) return undefined;
  return pending.filter((entry): entry is WorkflowInteractiveRequest =>
    isRecord(entry)
    && typeof entry.requestId === "string"
    && typeof entry.runId === "string"
    && typeof entry.revision === "number"
  );
}

/**
 * Reads the operator-facing parts of a human decision request.
 *
 * The canonical `subject` is deliberately not read. A channel must render the
 * presentation the workflow author wrote, never derive one from subject data,
 * because subject can hold detail the operator was not meant to see.
 */
export function decisionForOperator(
  interaction: WorkflowInteractiveRequest,
): ClaimedWorkflowDecision | undefined {
  if (interaction.kind !== "decision") return undefined;
  const contract = isRecord(interaction.contract) ? interaction.contract : undefined;
  if (contract === undefined) return undefined;
  const request = isRecord(contract.request) ? contract.request : contract;

  const title = typeof request.title === "string" ? request.title : undefined;
  const presentation = isRecord(request.presentation) ? request.presentation : undefined;
  const summary = typeof presentation?.summary === "string" ? presentation.summary : undefined;
  const rawChoices = isRecord(request.choices) ? request.choices : undefined;
  if (title === undefined || summary === undefined || rawChoices === undefined) return undefined;

  const choices = Object.entries(rawChoices).flatMap(([key, value]) => {
    if (!isRecord(value) || typeof value.label !== "string") return [];
    return [{ key, label: value.label, expectsInput: value.input !== undefined }];
  });
  if (choices.length === 0) return undefined;

  return {
    requestId: interaction.requestId,
    runId: interaction.runId,
    revision: interaction.revision,
    title,
    summary,
    choices,
  };
}

/**
 * Watches one Pi session and presents its human decisions through ClickClack.
 *
 * Only one decision is presented at a time. Others stay pending and arrive on a
 * later subscription event, so a burst cannot open several conversations at
 * once.
 */
export class WorkflowDecisionWatcher {
  private readonly options: WorkflowDecisionWatcherOptions;
  private unwatch: (() => Promise<void>) | undefined;
  private activeRequestId: string | undefined;
  private activeConsume: Promise<void> | undefined;
  private pendingInteractions: readonly WorkflowInteractiveRequest[] | undefined;
  private claimRetryTimer: NodeJS.Timeout | undefined;
  private generation = 0;

  constructor(options: WorkflowDecisionWatcherOptions) {
    this.options = options;
  }

  async start(): Promise<void> {
    const generation = this.generation;
    await this.options.client.ensureAvailable();
    const unwatch = await this.options.client.watchSession(this.options.sessionId, (event) => {
      if (generation !== this.generation) return;
      // Run state first, and defensively: a throwing observer must not cost the
      // operator a decision that arrived on the same event.
      try {
        this.options.onRun?.(event);
      } catch (error) {
        this.options.onError?.(error);
      }
      const interactions = sessionInteractions(event);
      if (interactions !== undefined) this.queueInteractions(interactions, generation);
    });
    if (generation === this.generation) this.unwatch = unwatch;
    else await unwatch();
  }

  async stop(): Promise<void> {
    this.generation += 1;
    if (this.claimRetryTimer !== undefined) clearTimeout(this.claimRetryTimer);
    this.claimRetryTimer = undefined;
    this.pendingInteractions = undefined;
    const activeConsume = this.activeConsume;
    if (activeConsume !== undefined) await activeConsume;
    this.activeRequestId = undefined;
    const unwatch = this.unwatch;
    this.unwatch = undefined;
    if (unwatch !== undefined) await unwatch();
  }

  private queueInteractions(
    interactions: readonly WorkflowInteractiveRequest[],
    generation: number,
  ): void {
    if (this.claimRetryTimer !== undefined) clearTimeout(this.claimRetryTimer);
    this.claimRetryTimer = undefined;

    const now = Date.now();
    const retryAt = interactions.reduce<number | undefined>((earliest, interaction) => {
      if (interaction.kind !== "decision") return earliest;
      if (interaction.status !== "pending" && interaction.status !== "presenting") return earliest;
      const expiry = interaction.presentationClaimExpiresAt;
      if (expiry === null) return earliest;
      const timestamp = Date.parse(expiry);
      if (!Number.isFinite(timestamp) || timestamp <= now) return earliest;
      return earliest === undefined ? timestamp : Math.min(earliest, timestamp);
    }, undefined);
    if (retryAt !== undefined) {
      const delayMs = Math.min(2_147_483_647, Math.max(1, retryAt - now + 1));
      this.claimRetryTimer = setTimeout(() => {
        this.claimRetryTimer = undefined;
        if (generation !== this.generation) return;
        // Re-evaluate the lease in case the clock moved backward or a timeout
        // longer than Node's maximum delay was chunked.
        this.queueInteractions(interactions, generation);
      }, delayMs);
    }

    this.pendingInteractions = interactions;
    this.startConsumeLoop();
  }

  private startConsumeLoop(): void {
    if (this.activeConsume !== undefined) return;
    const consume = this.drainInteractions();
    this.activeConsume = consume;
    void consume.finally(() => {
      if (this.activeConsume === consume) this.activeConsume = undefined;
      if (this.pendingInteractions !== undefined) this.startConsumeLoop();
    }).catch(() => undefined);
  }

  private async drainInteractions(): Promise<void> {
    while (this.pendingInteractions !== undefined) {
      const interactions = this.pendingInteractions;
      this.pendingInteractions = undefined;
      await this.consume(interactions);
    }
  }

  private async consume(interactions: readonly WorkflowInteractiveRequest[]): Promise<void> {
    if (this.activeRequestId !== undefined) return;
    const generation = this.generation;

    for (const interaction of interactions) {
      if (interaction.kind !== "decision") continue;
      if (interaction.status !== "pending" && interaction.status !== "presenting") continue;
      if (claimIsLive(interaction)) continue;
      const decision = decisionForOperator(interaction);
      if (decision === undefined) continue;

      this.activeRequestId = interaction.requestId;
      try {
        const presentationRevision = await this.claim(interaction);
        if (presentationRevision === undefined) return;
        if (generation !== this.generation) return;

        const answer = await this.options.present(decision);
        if (answer === undefined) return;
        // Once the operator has answered, persist it even if shutdown or a
        // session replacement starts before this continuation runs.
        await this.answer(interaction, presentationRevision, answer);
      } catch (error) {
        this.options.onError?.(error);
      } finally {
        if (this.activeRequestId === interaction.requestId) this.activeRequestId = undefined;
      }
      return;
    }
  }

  /** Claims one decision. Resolves false when another presenter won the race. */
  private async claim(interaction: WorkflowInteractiveRequest): Promise<number | undefined> {
    const key =
      `claim-presentation-${interaction.requestId}-${interaction.revision}-${this.options.client.clientId}`;
    const response = await this.options.client.request({
      operation: "interaction.update",
      requestId: key,
      idempotencyKey: key,
      runId: interaction.runId,
      expectedRevision: interaction.revision,
      payload: { requestId: interaction.requestId, claimPresentation: true },
    });
    if (response.outcome === "conflict") return undefined;
    if (response.outcome !== "accepted" && response.outcome !== "adopted") {
      throw new Error(response.error ?? "workflow host rejected the presentation claim");
    }
    if (response.revision === undefined) {
      throw new Error("workflow presentation claim has no revision");
    }
    return response.revision;
  }

  /**
   * Answers one claimed decision.
   *
   * The host derives its acceptance attempt id from the idempotency key and
   * treats a repeat of the same key as the same answer, so the key is derived
   * from the request, its revision, and the chosen answer. A retry of the same
   * answer is then idempotent, while a different answer to the same decision is
   * a distinct attempt the host can accept or reject on its own terms rather
   * than silently adopting the first one.
   */
  private async answer(
    interaction: WorkflowInteractiveRequest,
    presentationRevision: number,
    answer: DecisionAnswer,
  ): Promise<void> {
    const submissionId = answerKey(interaction, answer);
    const settled = await this.options.client.requestDurable({
      operation: "decision.answer",
      idempotencyKey: submissionId,
      runId: interaction.runId,
      expectedRevision: presentationRevision,
      payload: {
        requestId: interaction.requestId,
        submissionId,
        response: answer.input === undefined
          ? { choice: answer.choice }
          : { choice: answer.choice, input: answer.input },
      },
    });
    if (settled.outcome !== "accepted" && settled.outcome !== "adopted") {
      throw new Error(settled.error ?? "workflow host rejected decision.answer");
    }
  }
}
