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
  }): Promise<{ outcome: string; error?: string }>;
  requestDurable(options: {
    operation: string;
    idempotencyKey: string;
    runId?: string;
    expectedRevision?: number;
    payload?: unknown;
  }): Promise<{ outcome: string; error?: string }>;
};

export type WorkflowDecisionWatcherOptions = {
  client: WorkflowDecisionClient;
  sessionId: string;
  /** Presents one claimed decision. Resolves to the chosen key, or undefined to release it. */
  present: (decision: ClaimedWorkflowDecision) => Promise<DecisionAnswer | undefined>;
  onError?: (error: unknown) => void;
};

export type DecisionAnswer = {
  choice: string;
  input?: Record<string, string>;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** True when another presenter holds an unexpired claim on this decision. */
export function claimIsLive(
  interaction: WorkflowInteractiveRequest,
  now: number = Date.now(),
): boolean {
  const expiry = interaction.presentationClaimExpiresAt;
  return expiry !== null && Date.parse(expiry) > now;
}

/** Extracts pending interactions from one session-view subscription event. */
export function sessionInteractions(event: unknown): WorkflowInteractiveRequest[] | undefined {
  if (!isRecord(event)) return undefined;
  const view = event.view;
  if (!isRecord(view)) return undefined;
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
  private generation = 0;

  constructor(options: WorkflowDecisionWatcherOptions) {
    this.options = options;
  }

  async start(): Promise<void> {
    const generation = this.generation;
    await this.options.client.ensureAvailable();
    const unwatch = await this.options.client.watchSession(this.options.sessionId, (event) => {
      if (generation !== this.generation) return;
      const interactions = sessionInteractions(event);
      if (interactions !== undefined) void this.consume(interactions);
    });
    if (generation === this.generation) this.unwatch = unwatch;
    else await unwatch();
  }

  async stop(): Promise<void> {
    this.generation += 1;
    this.activeRequestId = undefined;
    const unwatch = this.unwatch;
    this.unwatch = undefined;
    if (unwatch !== undefined) await unwatch();
  }

  private async consume(interactions: readonly WorkflowInteractiveRequest[]): Promise<void> {
    if (this.activeRequestId !== undefined) return;
    const generation = this.generation;

    for (const interaction of interactions) {
      if (interaction.kind !== "decision" || interaction.status !== "pending") continue;
      if (claimIsLive(interaction)) continue;
      const decision = decisionForOperator(interaction);
      if (decision === undefined) continue;

      this.activeRequestId = interaction.requestId;
      try {
        if (!await this.claim(interaction)) return;
        if (generation !== this.generation) return;

        const answer = await this.options.present(decision);
        if (answer === undefined || generation !== this.generation) return;
        await this.answer(interaction, answer);
      } catch (error) {
        this.options.onError?.(error);
      } finally {
        if (this.activeRequestId === interaction.requestId) this.activeRequestId = undefined;
      }
      return;
    }
  }

  /** Claims one decision. Resolves false when another presenter won the race. */
  private async claim(interaction: WorkflowInteractiveRequest): Promise<boolean> {
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
    if (response.outcome === "conflict") return false;
    if (response.outcome !== "accepted" && response.outcome !== "adopted") {
      throw new Error(response.error ?? "workflow host rejected the presentation claim");
    }
    return true;
  }

  private async answer(
    interaction: WorkflowInteractiveRequest,
    answer: DecisionAnswer,
  ): Promise<void> {
    const submissionId = `${interaction.requestId}-${interaction.revision}-${answer.choice}`;
    const settled = await this.options.client.requestDurable({
      operation: "decision.answer",
      idempotencyKey: submissionId,
      runId: interaction.runId,
      expectedRevision: interaction.revision,
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
