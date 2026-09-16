/** Host-side external decision watching for the latest Pi Workflows protocol.
 * The subscription advertises external presentation without taking agent coordination.
 * Message publication is nonce-deduplicated by ClickClack; answers remain revision-fenced.
 */
export type WorkflowInteractiveRequest = {
  requestId: string;
  runId: string;
  revision: number;
  kind: "agent" | "assistant" | "decision";
  status: "pending" | "settled" | "cancelled";
  contract: unknown;
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
  hostIdentity?: string;
  ensureAvailable(): Promise<unknown>;
  watchSession(
    sessionId: string,
    listener: (event: unknown) => void,
    options?: { externalPresenter?: boolean },
  ): Promise<() => Promise<void>>;
  request(options: {
    operation: string;
    requestId?: string;
    idempotencyKey?: string;
    runId?: string;
    expectedRevision?: number;
    signal?: AbortSignal;
    payload?: unknown;
  }): Promise<{ outcome: string; revision?: number; error?: string; receipt?: unknown }>;
  requestDurable(options: {
    operation: string;
    idempotencyKey: string;
    runId?: string;
    expectedRevision?: number;
    signal?: AbortSignal;
    payload?: unknown;
  }): Promise<{ outcome: string; revision?: number; error?: string; receipt?: unknown }>;
};

export type WorkflowDecisionWatcherOptions = {
  client: WorkflowDecisionClient;
  sessionId: string;
  /** Presents one claimed decision. Resolves to the chosen key, or undefined to release it. */
  present: (decision: ClaimedWorkflowDecision, signal: AbortSignal) => Promise<DecisionAnswer | undefined>;
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
  private activePresentation: { key: string; abort: AbortController } | undefined;
  private readonly presented = new Set<string>();
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
    }, { externalPresenter: true });
    if (generation === this.generation) this.unwatch = unwatch;
    else await unwatch();
  }

  async stop(): Promise<void> {
    this.generation += 1;
    this.activePresentation?.abort.abort("stopped");
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
    const active = this.activePresentation;
    if (active && !interactions.some(interaction => interaction.kind === "decision" && interaction.status === "pending" && `${interaction.requestId}:${interaction.revision}` === active.key)) active.abort.abort("stale");
    if (generation !== this.generation) return;
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
      if (interaction.status !== "pending") continue;
      const key = `${interaction.requestId}:${interaction.revision}`;
      if (this.presented.has(key)) continue;
      const decision = decisionForOperator(interaction);
      if (decision === undefined) continue;

      this.activeRequestId = interaction.requestId;
      try {
        const abort = new AbortController();
        this.activePresentation = { key, abort };
        this.presented.add(key);
        if (generation !== this.generation) return;
        const answer = await this.options.present(decision, abort.signal);
        if (abort.signal.reason === "stale") { this.presented.delete(key); return; }
        if (answer === undefined) return;
        // A chosen answer is durably submitted even if shutdown began meanwhile.
        await this.answer(interaction, interaction.revision, answer);
      } catch (error) {
        this.presented.delete(key);
        this.options.onError?.(error);
      } finally {
        this.activePresentation?.abort.abort("finished");
        this.activePresentation = undefined;
        if (this.activeRequestId === interaction.requestId) this.activeRequestId = undefined;
      }
      return;
    }
  }

  /**
   * Answers one presented decision.
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
