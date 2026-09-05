import { createHash } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import type { PublishWorkflowSnapshotRequest, PublishWorkflowSnapshotResponse } from "@clickclack/sdk-ts";
import { isRecord, workflowSessionView, type WorkflowDecisionClient } from "./workflow-decisions.js";
import { collectWorkflowSnapshot, identifier } from "./workflow-snapshot.js";

export type WorkflowTarget = { workspace_id: string; channel_id?: string; direct_conversation_id?: string };
type Job = { target: string; discovery: string; session_id: string; run_id: string; revision: number; digest: string | null;
  payload: string | null; delivered: number; terminal: number; attempts: number; retry_at: number };
const terminal = new Set(["completed", "failed", "timed_out", "cancelled"]);
/** Sorted JSON makes object key order irrelevant, while preserving attempt/file order. */
export function workflowDigest(value: unknown): string {
  function canonical(value: unknown): unknown {
    if (Array.isArray(value)) return value.map(canonical);
    if (isRecord(value)) return Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])]));
    return value;
  }
  return createHash("sha256").update(JSON.stringify(canonical(value))).digest("hex");
}

/** Process-owned replay queue. Identity discovery is synchronous and durable before any I/O.
 * No binding foreign key: replacement, unbind, null and shutdown must not erase history.
 */
export class DurableWorkflowPublisher {
  private timer: NodeJS.Timeout | undefined;
  private active: Promise<void> | undefined;
  private stopped = false;
  readonly scope: string;
  constructor(private readonly options: {
    database: DatabaseSync; endpoint: string; hostIdentity: string; producerId: string; workspaceId: string;
    client: () => WorkflowDecisionClient | undefined;
    publish: (request: PublishWorkflowSnapshotRequest) => Promise<PublishWorkflowSnapshotResponse>;
    onError?: (metadata?: { sessionId: string; runId: string; attempts: number }) => void;
    now?: () => number;
  }) {
    if (!options.hostIdentity.trim()) throw new Error("Missing stable workflow host identity");
    this.scope = workflowDigest([options.endpoint, options.producerId, options.workspaceId, options.hostIdentity]);
  }
  start(): void {
    if (this.stopped || this.timer !== undefined) return;
    this.timer = setInterval(() => { void this.flush().catch(() => this.options.onError?.()); }, 1000);
    this.timer.unref();
    void this.flush().catch(() => this.options.onError?.());
  }
  observe(target: WorkflowTarget, sessionId: string, event: unknown, discoveryNamespace: string): void {
    if (this.stopped) return;
    const view = workflowSessionView(event);
    if (view === undefined || view.schema !== "pi-workflows.session-view.v1" || view.sessionId !== sessionId || !isRecord(view.run)) return;
    const runId = view.run.runId;
    if (!identifier(sessionId) || !identifier(runId) || view.run.schema !== "pi-workflows.run-view.v1") return;
    if (!Number.isSafeInteger(view.run.revision) || (view.run.revision as number) < 0) return;
    if (!isRecord(view.run.queue) || view.run.queue.runId !== runId || (view.run.queue.originSessionId !== null && view.run.queue.originSessionId !== sessionId)) return;
    if (!discoveryNamespace) throw new Error("Missing workflow discovery namespace");
    const discovery = workflowDigest(discoveryNamespace);
    if (target.workspace_id !== this.options.workspaceId || Boolean(target.channel_id) === Boolean(target.direct_conversation_id)) {
      throw new Error("Invalid workflow publication target");
    }
    const targetJson = JSON.stringify({ workspace_id: target.workspace_id,
      ...(target.channel_id === undefined ? { direct_conversation_id: target.direct_conversation_id } : { channel_id: target.channel_id }) });
    this.options.database.prepare(`INSERT INTO workflow_publications(scope,target,discovery,session_id,run_id)
      VALUES(?,?,?,?,?) ON CONFLICT DO NOTHING`).run(this.scope, targetJson, discovery, sessionId, runId);
    // A null pointer never removes this identity. Poll it until a terminal snapshot is ACKed,
    // including after restart, even when no runtime reopens this session.
    this.options.database.prepare(`UPDATE workflow_publications SET terminal=0
      WHERE scope=? AND target=? AND discovery=? AND session_id=? AND run_id=? AND revision<?`)
      .run(this.scope, targetJson, discovery, sessionId, runId, Number.isSafeInteger(view.run.revision) ? view.run.revision as number : -1);
  }
  flush(): Promise<void> {
    if (this.stopped) return Promise.resolve();
    if (this.active !== undefined) return this.active;
    const task = this.process();
    this.active = task;
    void task.finally(() => { if (this.active === task) this.active = undefined; }).catch(() => undefined);
    return task;
  }
  async stop(): Promise<void> {
    this.stopped = true;
    if (this.timer !== undefined) clearInterval(this.timer);
    this.timer = undefined;
    await this.active;
  }
  private async process(): Promise<void> {
    const now = this.options.now?.() ?? Date.now();
    const jobs = this.options.database.prepare(`SELECT * FROM workflow_publications
      WHERE scope=? AND (terminal=0 OR delivered=0) AND retry_at<=? ORDER BY retry_at LIMIT 20`).all(this.scope, now) as unknown as Job[];
    for (const job of jobs) {
      if (this.stopped) break;
      const key = [this.scope, job.target, job.discovery, job.session_id, job.run_id];
      try {
        // Replay the exact persisted envelope first; never reconstruct an unacknowledged revision.
        if (job.payload !== null && !job.delivered) await this.deliver(job, key);
        if (job.terminal) continue;
        const client = this.options.client();
        if (client === undefined) throw new Error("Workflow host unavailable");
        await client.ensureAvailable();
        const snapshot = await collectWorkflowSnapshot(client, job.session_id, job.run_id, true, job.revision);
        if (snapshot !== undefined) {
          const digest = workflowDigest(snapshot);
          const payload = JSON.stringify({ ...JSON.parse(job.target), snapshot });
          this.options.database.prepare(`UPDATE workflow_publications SET revision=?,digest=?,payload=?,delivered=0,terminal=?
            WHERE scope=? AND target=? AND discovery=? AND session_id=? AND run_id=?`).run(snapshot.source.revision, digest, payload, terminal.has(snapshot.run.status) ? 1 : 0, ...key);
          job.revision = snapshot.source.revision; job.digest = digest; job.payload = payload; job.delivered = 0;
          await this.deliver(job, key);
        }
        this.options.database.prepare(`UPDATE workflow_publications SET attempts=0,retry_at=? WHERE scope=? AND target=? AND discovery=? AND session_id=? AND run_id=?`)
          .run(now + 1000, ...key);
      } catch {
        // No host/API error payload in logs: it may contain private execution content.
        this.options.database.prepare(`UPDATE workflow_publications SET attempts=attempts+1,retry_at=? WHERE scope=? AND target=? AND discovery=? AND session_id=? AND run_id=?`)
          .run(now + Math.min(60_000, 1000 * 2 ** Math.min(job.attempts, 6)), ...key);
        this.options.onError?.({ sessionId: job.session_id, runId: job.run_id, attempts: job.attempts + 1 });
      }
    }
  }
  private async deliver(job: Job, key: string[]): Promise<void> {
    const input = JSON.parse(job.payload!) as PublishWorkflowSnapshotRequest;
    if (workflowDigest(input.snapshot) !== job.digest || input.snapshot.source.revision !== job.revision
      || input.snapshot.source.sessionId !== job.session_id || input.snapshot.source.runId !== job.run_id
      || JSON.stringify({ workspace_id: input.workspace_id, ...(input.channel_id === undefined
        ? { direct_conversation_id: input.direct_conversation_id } : { channel_id: input.channel_id }) }) !== job.target) {
      throw new Error("Workflow outbox consistency failure");
    }
    const { record } = await this.options.publish(input);
    if (record.producer_id !== this.options.producerId || record.workspace_id !== input.workspace_id
      || record.channel_id !== input.channel_id || record.direct_conversation_id !== input.direct_conversation_id
      || record.snapshot.source.provider !== input.snapshot.source.provider
      || record.snapshot.source.sessionId !== job.session_id || record.snapshot.source.runId !== job.run_id
      || record.snapshot.source.revision < job.revision
      || (record.snapshot.source.revision === job.revision && workflowDigest(record.snapshot) !== job.digest)) {
      throw new Error("Workflow acknowledgment identity mismatch");
    }
    this.options.database.prepare(`UPDATE workflow_publications SET delivered=1 WHERE scope=? AND target=? AND discovery=? AND session_id=? AND run_id=? AND revision=? AND digest=?`)
      .run(...key, job.revision, job.digest);
    job.delivered = 1;
  }
}
