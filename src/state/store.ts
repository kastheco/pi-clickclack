import { createHash } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";

import type { ConversationId, ConversationType, InvocationMode, MessageId, ProjectAlias, TurnId } from "../types.js";
import { applyMigrations } from "./migrations.js";

export type SourceMessageClaim = {
  messageId: MessageId;
  eventId?: string;
  eventCursor?: string;
  claimedAt: string;
};

export type SteeringReceipt = {
  messageId: MessageId;
  bindingId: number;
  sessionId: string;
  turnId: TurnId;
  projectAlias: string;
  authorId: string;
  workspaceId: string;
  botId: string;
  status: "pending" | "consumed" | "uncertain";
  runtimeRetired: boolean;
};

export type ClaimResult =
  | { claimed: true; claim: SourceMessageClaim }
  | { claimed: false; claim: SourceMessageClaim };

export type ConversationBinding = {
  id: number;
  conversationType: ConversationType;
  conversationId: ConversationId;
  projectAlias: ProjectAlias;
  invocationMode: InvocationMode;
  createdAt: string;
  updatedAt: string;
};

export type PiSessionReference = {
  id: number;
  bindingId: number;
  sessionId: string;
  sessionFile: string;
  createdAt: string;
  archivedAt?: string;
};

export const activeTurnStatuses = ["starting", "running", "stopping"] as const;
export type ActiveTurnStatus = (typeof activeTurnStatuses)[number];

export type ActiveTurn = {
  turnId: TurnId;
  bindingId: number;
  sourceMessageId: MessageId;
  status: ActiveTurnStatus;
  startedAt: string;
  updatedAt: string;
};

export const interactiveRequestKinds = ["confirmation", "selection", "input", "editor"] as const;
export type InteractiveRequestKind = (typeof interactiveRequestKinds)[number];
export const interactiveRequestStatuses = ["pending", "resolved", "cancelled", "timed_out"] as const;
export type InteractiveRequestStatus = (typeof interactiveRequestStatuses)[number];

export type PendingInteractiveRequest = {
  requestId: string;
  turnId: TurnId;
  kind: InteractiveRequestKind;
  promptMessageId: MessageId;
  status: InteractiveRequestStatus;
  responseMessageId?: MessageId;
  createdAt: string;
  updatedAt: string;
};

export const outboundStatuses = ["pending", "sent", "uncertain", "reconciled", "failed"] as const;
export type OutboundStatus = (typeof outboundStatuses)[number];
export type OutboundTargetType = "channel" | "direct" | "thread";
export type OutboundMessageKind = "message" | "agent_commentary" | "agent_tool" | "interactive_request";

export type OutboundReconciliation = {
  nonce: string;
  targetType: OutboundTargetType;
  targetId: string;
  messageKind: OutboundMessageKind;
  turnId?: TurnId;
  bodySha256: string;
  status: OutboundStatus;
  messageId?: MessageId;
  errorCode?: string;
  attempts: number;
  createdAt: string;
  updatedAt: string;
};

type Row = Record<string, unknown>;

export class StateStore {
  readonly database: DatabaseSync;
  private closed = false;

  constructor(path: string) {
    if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    this.database = new DatabaseSync(path, {
      enableForeignKeyConstraints: true,
      enableDoubleQuotedStringLiterals: false,
    });
    this.database.exec("PRAGMA busy_timeout = 5000");
    if (path !== ":memory:") this.database.exec("PRAGMA journal_mode = WAL");
    applyMigrations(this.database);
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.database.close();
  }

  getRealtimeCursor(): string | undefined {
    const row = this.database.prepare("SELECT cursor FROM realtime_cursor WHERE singleton = 1").get() as Row | undefined;
    return row ? text(row.cursor) : undefined;
  }

  advanceRealtimeCursor(cursor: string): boolean {
    const normalized = requiredValue(cursor, "cursor");
    return this.transaction(() => {
      const current = this.getRealtimeCursor();
      if (current !== undefined && normalized <= current) return false;
      const now = timestamp();
      this.database
        .prepare(`
          INSERT INTO realtime_cursor (singleton, cursor, updated_at)
          VALUES (1, ?, ?)
          ON CONFLICT(singleton) DO UPDATE SET cursor = excluded.cursor, updated_at = excluded.updated_at
        `)
        .run(normalized, now);
      return true;
    });
  }

  claimSourceMessage(input: {
    messageId: MessageId;
    eventId?: string;
    eventCursor?: string;
    steering?: Omit<SteeringReceipt, "messageId" | "status" | "runtimeRetired">;
  }): ClaimResult {
    const messageId = requiredValue(input.messageId, "messageId") as MessageId;
    return this.transaction(() => {
      const now = timestamp();
      const result = this.database
        .prepare(`
          INSERT OR IGNORE INTO source_message_claims (message_id, event_id, event_cursor, claimed_at)
          VALUES (?, ?, ?, ?)
        `)
        .run(messageId, input.eventId ?? null, input.eventCursor ?? null, now);
      if (result.changes === 1 && input.steering) {
        const receipt = input.steering;
        this.database.prepare(`INSERT INTO steering_receipts
          (message_id, binding_id, session_id, turn_id, project_alias, author_id, workspace_id, bot_id)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
          .run(messageId, receipt.bindingId, receipt.sessionId, receipt.turnId, receipt.projectAlias,
            receipt.authorId, receipt.workspaceId, receipt.botId);
      }
      const claim = this.getSourceMessageClaim(messageId);
      if (!claim) throw new Error("source-message claim disappeared inside transaction");
      return result.changes === 1 ? { claimed: true, claim } : { claimed: false, claim };
    });
  }

  consumeSteering(messageId: MessageId): void {
    this.database.prepare("UPDATE steering_receipts SET status = 'consumed' WHERE message_id = ? AND notified = 0").run(messageId);
  }

  markSteeringMessageUncertain(messageId: MessageId): void {
    this.database.prepare("UPDATE steering_receipts SET status = 'uncertain' WHERE message_id = ? AND status = 'pending'").run(messageId);
  }

  markSteeringUncertain(turnId?: TurnId): void {
    this.database.prepare(`UPDATE steering_receipts SET status = 'uncertain'
      WHERE status = 'pending' ${turnId ? "AND turn_id = ?" : ""}`).run(...(turnId ? [turnId] : []));
  }

  hasUnconsumedSteering(turnId: TurnId, sessionId: string): boolean {
    return this.database.prepare("SELECT 1 FROM steering_receipts WHERE turn_id = ? AND session_id = ? AND status <> 'consumed' LIMIT 1")
      .get(turnId, sessionId) !== undefined;
  }

  markSteeringRuntimeRetired(turnId: TurnId): void {
    this.database.prepare("UPDATE steering_receipts SET runtime_retired = 1 WHERE turn_id = ? AND status <> 'consumed'").run(turnId);
  }

  markSteeringNotified(messageId: MessageId): void {
    this.database.prepare("UPDATE steering_receipts SET notified = 1 WHERE message_id = ?").run(messageId);
  }

  listUncertainSteering(): SteeringReceipt[] {
    return (this.database.prepare("SELECT * FROM steering_receipts WHERE status = 'uncertain' AND notified = 0").all() as Row[])
      .map((row) => ({
        messageId: text(row.message_id) as MessageId, bindingId: integer(row.binding_id),
        sessionId: text(row.session_id), turnId: text(row.turn_id) as TurnId,
        projectAlias: text(row.project_alias), authorId: text(row.author_id),
        workspaceId: text(row.workspace_id), botId: text(row.bot_id), status: "uncertain", runtimeRetired: integer(row.runtime_retired) === 1,
      }));
  }

  getSourceMessageClaim(messageId: MessageId): SourceMessageClaim | undefined {
    const row = this.database
      .prepare("SELECT message_id, event_id, event_cursor, claimed_at FROM source_message_claims WHERE message_id = ?")
      .get(messageId) as Row | undefined;
    return row ? sourceMessageClaim(row) : undefined;
  }

  upsertBinding(input: {
    conversationType: ConversationType;
    conversationId: ConversationId;
    projectAlias: ProjectAlias;
    invocationMode: InvocationMode;
  }): ConversationBinding {
    return this.transaction(() => {
      const now = timestamp();
      this.database
        .prepare(`
          INSERT INTO conversation_bindings (
            conversation_type, conversation_id, project_alias, invocation_mode, created_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?)
          ON CONFLICT(conversation_type, conversation_id) DO UPDATE SET
            project_alias = excluded.project_alias,
            invocation_mode = excluded.invocation_mode,
            updated_at = excluded.updated_at
        `)
        .run(
          input.conversationType,
          requiredValue(input.conversationId, "conversationId"),
          requiredValue(input.projectAlias, "projectAlias"),
          input.invocationMode,
          now,
          now,
        );
      const binding = this.getBinding(input.conversationType, input.conversationId);
      if (!binding) throw new Error("conversation binding disappeared inside transaction");
      return binding;
    });
  }

  getBinding(type: ConversationType, id: ConversationId): ConversationBinding | undefined {
    const row = this.database
      .prepare(`
        SELECT id, conversation_type, conversation_id, project_alias, invocation_mode, created_at, updated_at
        FROM conversation_bindings WHERE conversation_type = ? AND conversation_id = ?
      `)
      .get(type, id) as Row | undefined;
    return row ? conversationBinding(row) : undefined;
  }

  setActivePiSession(input: {
    bindingId: number;
    sessionId: string;
    sessionFile: string;
  }): PiSessionReference {
    return this.transaction(() => {
      const now = timestamp();
      this.database
        .prepare("UPDATE pi_session_references SET archived_at = ? WHERE binding_id = ? AND archived_at IS NULL")
        .run(now, input.bindingId);
      const result = this.database
        .prepare(`
          INSERT INTO pi_session_references (binding_id, session_id, session_file, created_at)
          VALUES (?, ?, ?, ?)
        `)
        .run(
          input.bindingId,
          requiredValue(input.sessionId, "sessionId"),
          requiredValue(input.sessionFile, "sessionFile"),
          now,
        );
      const row = this.database
        .prepare(`
          SELECT id, binding_id, session_id, session_file, created_at, archived_at
          FROM pi_session_references WHERE id = ?
        `)
        .get(result.lastInsertRowid) as Row | undefined;
      if (!row) throw new Error("Pi session reference disappeared inside transaction");
      return piSessionReference(row);
    });
  }

  getActivePiSession(bindingId: number): PiSessionReference | undefined {
    const row = this.database
      .prepare(`
        SELECT id, binding_id, session_id, session_file, created_at, archived_at
        FROM pi_session_references WHERE binding_id = ? AND archived_at IS NULL
      `)
      .get(bindingId) as Row | undefined;
    return row ? piSessionReference(row) : undefined;
  }

  listArchivedPiSessions(bindingId: number): PiSessionReference[] {
    const rows = this.database
      .prepare(`
        SELECT id, binding_id, session_id, session_file, created_at, archived_at
        FROM pi_session_references
        WHERE binding_id = ? AND archived_at IS NOT NULL
        ORDER BY created_at DESC, id DESC
      `)
      .all(bindingId) as Row[];
    return rows.map(piSessionReference);
  }

  restorePiSession(bindingId: number, referenceId: number): PiSessionReference {
    return this.transaction(() => {
      const row = this.database
        .prepare(`
          SELECT id, binding_id, session_id, session_file, created_at, archived_at
          FROM pi_session_references WHERE id = ? AND binding_id = ?
        `)
        .get(referenceId, bindingId) as Row | undefined;
      if (!row) throw new Error("Pi session reference not found for binding");
      const now = timestamp();
      this.database
        .prepare("UPDATE pi_session_references SET archived_at = ? WHERE binding_id = ? AND archived_at IS NULL")
        .run(now, bindingId);
      this.database
        .prepare("UPDATE pi_session_references SET archived_at = NULL WHERE id = ?")
        .run(referenceId);
      return piSessionReference({ ...row, archived_at: null });
    });
  }

  archiveActivePiSession(bindingId: number): boolean {
    return this.database
      .prepare("UPDATE pi_session_references SET archived_at = ? WHERE binding_id = ? AND archived_at IS NULL")
      .run(timestamp(), bindingId).changes === 1;
  }

  recoverInterruptedTurns(): number {
    return this.transaction(() => {
      const bindings = this.database.prepare("SELECT DISTINCT binding_id FROM active_turns").all() as Row[];
      if (bindings.length === 0) return 0;
      const now = timestamp();
      for (const row of bindings) {
        this.database
          .prepare("UPDATE pi_session_references SET archived_at = ? WHERE binding_id = ? AND archived_at IS NULL")
          .run(now, integer(row.binding_id));
      }
      const count = integer((this.database.prepare("SELECT COUNT(*) AS count FROM active_turns").get() as Row).count);
      this.database.prepare("DELETE FROM active_turns").run();
      return count;
    });
  }

  startActiveTurn(input: {
    turnId: TurnId;
    bindingId: number;
    sourceMessageId: MessageId;
  }): ActiveTurn {
    return this.transaction(() => {
      const now = timestamp();
      this.database
        .prepare(`
          INSERT INTO active_turns (turn_id, binding_id, source_message_id, status, started_at, updated_at)
          VALUES (?, ?, ?, 'starting', ?, ?)
        `)
        .run(input.turnId, input.bindingId, input.sourceMessageId, now, now);
      const turn = this.getActiveTurn(input.turnId);
      if (!turn) throw new Error("active turn disappeared inside transaction");
      return turn;
    });
  }

  getActiveTurn(turnId: TurnId): ActiveTurn | undefined {
    const row = this.database
      .prepare(`
        SELECT turn_id, binding_id, source_message_id, status, started_at, updated_at
        FROM active_turns WHERE turn_id = ?
      `)
      .get(turnId) as Row | undefined;
    return row ? activeTurn(row) : undefined;
  }

  transitionActiveTurn(turnId: TurnId, expected: ActiveTurnStatus, next: ActiveTurnStatus): boolean {
    const allowed =
      (expected === "starting" && (next === "running" || next === "stopping")) ||
      (expected === "running" && next === "stopping");
    if (!allowed) throw new Error(`invalid active-turn transition ${expected} -> ${next}`);
    const result = this.database
      .prepare("UPDATE active_turns SET status = ?, updated_at = ? WHERE turn_id = ? AND status = ?")
      .run(next, timestamp(), turnId, expected);
    return result.changes === 1;
  }

  finishActiveTurn(turnId: TurnId, expected: ActiveTurnStatus): boolean {
    return this.transaction(() => {
      const pending = this.database
        .prepare("SELECT COUNT(*) AS count FROM pending_interactive_requests WHERE turn_id = ? AND status = 'pending'")
        .get(turnId) as Row;
      if (integer(pending.count) !== 0) throw new Error("cannot finish a turn with a pending interactive request");
      return this.database
        .prepare("DELETE FROM active_turns WHERE turn_id = ? AND status = ?")
        .run(turnId, expected).changes === 1;
    });
  }

  createInteractiveRequest(input: {
    requestId: string;
    turnId: TurnId;
    kind: InteractiveRequestKind;
    promptMessageId: MessageId;
  }): PendingInteractiveRequest {
    return this.transaction(() => {
      const now = timestamp();
      this.database
        .prepare(`
          INSERT INTO pending_interactive_requests (
            request_id, turn_id, kind, prompt_message_id, status, created_at, updated_at
          ) VALUES (?, ?, ?, ?, 'pending', ?, ?)
        `)
        .run(input.requestId, input.turnId, input.kind, input.promptMessageId, now, now);
      const request = this.getInteractiveRequest(input.requestId);
      if (!request) throw new Error("interactive request disappeared inside transaction");
      return request;
    });
  }

  getInteractiveRequest(requestId: string): PendingInteractiveRequest | undefined {
    const row = this.database
      .prepare(`
        SELECT request_id, turn_id, kind, prompt_message_id, status, response_message_id, created_at, updated_at
        FROM pending_interactive_requests WHERE request_id = ?
      `)
      .get(requestId) as Row | undefined;
    return row ? interactiveRequest(row) : undefined;
  }

  completeInteractiveRequest(input: {
    requestId: string;
    status: Exclude<InteractiveRequestStatus, "pending">;
    responseMessageId?: MessageId;
  }): boolean {
    if (input.status === "resolved" && !input.responseMessageId) {
      throw new Error("resolved interactive requests require a response message ID");
    }
    if (input.status !== "resolved" && input.responseMessageId) {
      throw new Error(`${input.status} interactive requests cannot have a response message ID`);
    }
    const result = this.database
      .prepare(`
        UPDATE pending_interactive_requests
        SET status = ?, response_message_id = ?, updated_at = ?
        WHERE request_id = ? AND status = 'pending'
      `)
      .run(input.status, input.responseMessageId ?? null, timestamp(), input.requestId);
    return result.changes === 1;
  }

  reserveOutbound(input: {
    nonce: string;
    targetType: OutboundTargetType;
    targetId: string;
    messageKind: OutboundMessageKind;
    body: string;
    turnId?: TurnId;
  }): OutboundReconciliation {
    return this.transaction(() => {
      const now = timestamp();
      const bodySha256 = createHash("sha256").update(input.body).digest("hex");
      this.database
        .prepare(`
          INSERT INTO outbound_nonce_reconciliation (
            nonce, target_type, target_id, message_kind, turn_id, body_sha256, status, created_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, 'pending', ?, ?)
        `)
        .run(
          requiredValue(input.nonce, "nonce"),
          input.targetType,
          requiredValue(input.targetId, "targetId"),
          input.messageKind,
          input.turnId ?? null,
          bodySha256,
          now,
          now,
        );
      const outbound = this.getOutbound(input.nonce);
      if (!outbound) throw new Error("outbound reconciliation disappeared inside transaction");
      return outbound;
    });
  }

  getOutbound(nonce: string): OutboundReconciliation | undefined {
    const row = this.database
      .prepare(`
        SELECT nonce, target_type, target_id, message_kind, turn_id, body_sha256, status,
               message_id, error_code, attempts, created_at, updated_at
        FROM outbound_nonce_reconciliation WHERE nonce = ?
      `)
      .get(nonce) as Row | undefined;
    return row ? outboundReconciliation(row) : undefined;
  }

  transitionOutbound(input: {
    nonce: string;
    expected: OutboundStatus;
    next: OutboundStatus;
    messageId?: MessageId;
    errorCode?: string;
  }): boolean {
    assertOutboundTransition(input.expected, input.next);
    if ((input.next === "sent" || input.next === "reconciled") && !input.messageId) {
      throw new Error(`${input.next} outbound state requires a message ID`);
    }
    const result = this.database
      .prepare(`
        UPDATE outbound_nonce_reconciliation
        SET status = ?, message_id = ?, error_code = ?, attempts = attempts + 1, updated_at = ?
        WHERE nonce = ? AND status = ?
      `)
      .run(
        input.next,
        input.messageId ?? null,
        input.errorCode ?? null,
        timestamp(),
        input.nonce,
        input.expected,
      );
    return result.changes === 1;
  }

  listOutboundByStatus(status: OutboundStatus): OutboundReconciliation[] {
    return (this.database
      .prepare(`
        SELECT nonce, target_type, target_id, message_kind, turn_id, body_sha256, status,
               message_id, error_code, attempts, created_at, updated_at
        FROM outbound_nonce_reconciliation WHERE status = ? ORDER BY created_at, nonce
      `)
      .all(status) as Row[]).map(outboundReconciliation);
  }

  private transaction<Result>(operation: () => Result): Result {
    this.database.exec("BEGIN IMMEDIATE");
    try {
      const result = operation();
      this.database.exec("COMMIT");
      return result;
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
  }
}

function sourceMessageClaim(row: Row): SourceMessageClaim {
  const eventId = nullableText(row.event_id);
  const eventCursor = nullableText(row.event_cursor);
  return {
    messageId: text(row.message_id) as MessageId,
    ...(eventId ? { eventId } : {}),
    ...(eventCursor ? { eventCursor } : {}),
    claimedAt: text(row.claimed_at),
  };
}

function conversationBinding(row: Row): ConversationBinding {
  return {
    id: integer(row.id),
    conversationType: text(row.conversation_type) as ConversationType,
    conversationId: text(row.conversation_id) as ConversationId,
    projectAlias: text(row.project_alias) as ProjectAlias,
    invocationMode: text(row.invocation_mode) as InvocationMode,
    createdAt: text(row.created_at),
    updatedAt: text(row.updated_at),
  };
}

function piSessionReference(row: Row): PiSessionReference {
  const archivedAt = nullableText(row.archived_at);
  return {
    id: integer(row.id),
    bindingId: integer(row.binding_id),
    sessionId: text(row.session_id),
    sessionFile: text(row.session_file),
    createdAt: text(row.created_at),
    ...(archivedAt ? { archivedAt } : {}),
  };
}

function activeTurn(row: Row): ActiveTurn {
  return {
    turnId: text(row.turn_id) as TurnId,
    bindingId: integer(row.binding_id),
    sourceMessageId: text(row.source_message_id) as MessageId,
    status: text(row.status) as ActiveTurnStatus,
    startedAt: text(row.started_at),
    updatedAt: text(row.updated_at),
  };
}

function interactiveRequest(row: Row): PendingInteractiveRequest {
  const responseMessageId = nullableText(row.response_message_id);
  return {
    requestId: text(row.request_id),
    turnId: text(row.turn_id) as TurnId,
    kind: text(row.kind) as InteractiveRequestKind,
    promptMessageId: text(row.prompt_message_id) as MessageId,
    status: text(row.status) as InteractiveRequestStatus,
    ...(responseMessageId ? { responseMessageId: responseMessageId as MessageId } : {}),
    createdAt: text(row.created_at),
    updatedAt: text(row.updated_at),
  };
}

function outboundReconciliation(row: Row): OutboundReconciliation {
  const turnId = nullableText(row.turn_id);
  const messageId = nullableText(row.message_id);
  const errorCode = nullableText(row.error_code);
  return {
    nonce: text(row.nonce),
    targetType: text(row.target_type) as OutboundTargetType,
    targetId: text(row.target_id),
    messageKind: text(row.message_kind) as OutboundMessageKind,
    ...(turnId ? { turnId: turnId as TurnId } : {}),
    bodySha256: text(row.body_sha256),
    status: text(row.status) as OutboundStatus,
    ...(messageId ? { messageId: messageId as MessageId } : {}),
    ...(errorCode ? { errorCode } : {}),
    attempts: integer(row.attempts),
    createdAt: text(row.created_at),
    updatedAt: text(row.updated_at),
  };
}

function assertOutboundTransition(expected: OutboundStatus, next: OutboundStatus): void {
  const allowed =
    (expected === "pending" && (next === "sent" || next === "uncertain" || next === "failed")) ||
    (expected === "uncertain" && (next === "reconciled" || next === "sent" || next === "failed"));
  if (!allowed) throw new Error(`invalid outbound transition ${expected} -> ${next}`);
}

function text(value: unknown): string {
  if (typeof value !== "string") throw new TypeError(`expected SQLite text, received ${typeof value}`);
  return value;
}

function nullableText(value: unknown): string | undefined {
  if (value === null || value === undefined) return undefined;
  return text(value);
}

function integer(value: unknown): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value)) {
    throw new TypeError(`expected SQLite integer, received ${String(value)}`);
  }
  return value;
}

function requiredValue(value: string, name: string): string {
  const normalized = value.trim();
  if (!normalized) throw new Error(`${name} must not be empty`);
  return normalized;
}

function timestamp(): string {
  return new Date().toISOString();
}

export type SqlValue = SQLInputValue;
