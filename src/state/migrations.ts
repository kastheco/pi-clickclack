import type { DatabaseSync } from "node:sqlite";

export type Migration = {
  version: number;
  name: string;
  sql: string;
};

export const migrations: readonly Migration[] = [
  {
    version: 1,
    name: "cursor-claims-bindings-and-sessions",
    sql: `
      CREATE TABLE realtime_cursor (
        singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
        cursor TEXT NOT NULL,
        updated_at TEXT NOT NULL
      ) STRICT;

      CREATE TABLE source_message_claims (
        message_id TEXT PRIMARY KEY,
        event_id TEXT,
        event_cursor TEXT,
        claimed_at TEXT NOT NULL
      ) STRICT;

      CREATE TABLE conversation_bindings (
        id INTEGER PRIMARY KEY,
        conversation_type TEXT NOT NULL CHECK (conversation_type IN ('channel', 'direct')),
        conversation_id TEXT NOT NULL,
        project_alias TEXT NOT NULL,
        invocation_mode TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        UNIQUE (conversation_type, conversation_id),
        CHECK (
          (conversation_type = 'channel' AND invocation_mode IN ('mention', 'always')) OR
          (conversation_type = 'direct' AND invocation_mode = 'auto')
        )
      ) STRICT;

      CREATE TABLE pi_session_references (
        id INTEGER PRIMARY KEY,
        binding_id INTEGER NOT NULL REFERENCES conversation_bindings(id) ON DELETE CASCADE,
        session_id TEXT NOT NULL UNIQUE,
        session_file TEXT NOT NULL UNIQUE,
        created_at TEXT NOT NULL,
        archived_at TEXT
      ) STRICT;

      CREATE UNIQUE INDEX one_active_pi_session_per_binding
      ON pi_session_references(binding_id)
      WHERE archived_at IS NULL;
    `,
  },
  {
    version: 2,
    name: "active-turns-and-interactions",
    sql: `
      CREATE TABLE active_turns (
        turn_id TEXT PRIMARY KEY,
        binding_id INTEGER NOT NULL UNIQUE REFERENCES conversation_bindings(id) ON DELETE CASCADE,
        source_message_id TEXT NOT NULL UNIQUE REFERENCES source_message_claims(message_id) ON DELETE RESTRICT,
        status TEXT NOT NULL CHECK (status IN ('starting', 'running', 'stopping')),
        started_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      ) STRICT;

      CREATE TABLE pending_interactive_requests (
        request_id TEXT PRIMARY KEY,
        turn_id TEXT NOT NULL REFERENCES active_turns(turn_id) ON DELETE CASCADE,
        kind TEXT NOT NULL CHECK (kind IN ('confirmation', 'selection', 'input', 'editor')),
        prompt_message_id TEXT NOT NULL UNIQUE,
        status TEXT NOT NULL CHECK (status IN ('pending', 'resolved', 'cancelled', 'timed_out')),
        response_message_id TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        CHECK (
          (status = 'resolved' AND response_message_id IS NOT NULL) OR
          (status <> 'resolved' AND response_message_id IS NULL)
        )
      ) STRICT;

      CREATE UNIQUE INDEX one_pending_interaction_per_turn
      ON pending_interactive_requests(turn_id)
      WHERE status = 'pending';
    `,
  },
  {
    version: 3,
    name: "outbound-nonce-reconciliation",
    sql: `
      CREATE TABLE outbound_nonce_reconciliation (
        nonce TEXT PRIMARY KEY,
        target_type TEXT NOT NULL CHECK (target_type IN ('channel', 'direct', 'thread')),
        target_id TEXT NOT NULL,
        message_kind TEXT NOT NULL CHECK (message_kind IN ('message', 'agent_commentary', 'agent_tool', 'interactive_request')),
        turn_id TEXT,
        body_sha256 TEXT NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('pending', 'sent', 'uncertain', 'reconciled', 'failed')),
        message_id TEXT,
        error_code TEXT,
        attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        CHECK (status NOT IN ('sent', 'reconciled') OR message_id IS NOT NULL)
      ) STRICT;

      CREATE INDEX outbound_reconciliation_by_status
      ON outbound_nonce_reconciliation(status, updated_at);
    `,
  },
  {
    version: 4,
    name: "durable-workflow-publication",
    sql: `
      CREATE TABLE workflow_publications (
        scope TEXT NOT NULL,
        target TEXT NOT NULL,
        discovery TEXT NOT NULL,
        session_id TEXT NOT NULL,
        run_id TEXT NOT NULL,
        revision INTEGER NOT NULL DEFAULT -1,
        digest TEXT,
        payload TEXT,
        delivered INTEGER NOT NULL DEFAULT 0 CHECK (delivered IN (0, 1)),
        terminal INTEGER NOT NULL DEFAULT 0 CHECK (terminal IN (0, 1)),
        attempts INTEGER NOT NULL DEFAULT 0,
        retry_at INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY (scope, target, discovery, session_id, run_id)
      ) STRICT;
    `,
  },
  {
    version: 5,
    name: "mid-turn-steering-receipts",
    sql: `
      CREATE TABLE steering_receipts (
        message_id TEXT PRIMARY KEY REFERENCES source_message_claims(message_id),
        binding_id INTEGER NOT NULL REFERENCES conversation_bindings(id),
        session_id TEXT NOT NULL,
        turn_id TEXT NOT NULL,
        project_alias TEXT NOT NULL,
        author_id TEXT NOT NULL,
        workspace_id TEXT NOT NULL,
        bot_id TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'consumed', 'uncertain')),
        notified INTEGER NOT NULL DEFAULT 0 CHECK (notified IN (0, 1)),
        runtime_retired INTEGER NOT NULL DEFAULT 0 CHECK (runtime_retired IN (0, 1))
      ) STRICT;
    `,
  },
] as const;

export function applyMigrations(
  database: DatabaseSync,
  availableMigrations: readonly Migration[] = migrations,
): void {
  database.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version INTEGER PRIMARY KEY,
      name TEXT NOT NULL UNIQUE,
      applied_at TEXT NOT NULL
    ) STRICT;
  `);

  const applied = new Set(
    (database.prepare("SELECT version FROM schema_migrations").all() as Array<{ version: number }>).map(
      (row) => row.version,
    ),
  );
  const ordered = [...availableMigrations].sort((left, right) => left.version - right.version);

  for (const migration of ordered) {
    if (applied.has(migration.version)) continue;
    database.exec("BEGIN IMMEDIATE");
    try {
      database.exec(migration.sql);
      database
        .prepare("INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)")
        .run(migration.version, migration.name, new Date().toISOString());
      database.exec("COMMIT");
    } catch (error) {
      database.exec("ROLLBACK");
      throw new Error(`migration ${migration.version} (${migration.name}) failed`, { cause: error });
    }
  }
}
