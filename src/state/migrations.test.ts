import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

import { applyMigrations, migrations, type Migration } from "./migrations.js";

test("migrations are repeatable", () => {
  const database = new DatabaseSync(":memory:");
  try {
    applyMigrations(database);
    applyMigrations(database);
    const rows = database
      .prepare("SELECT version, name FROM schema_migrations ORDER BY version")
      .all()
      .map((row) => ({ version: row.version, name: row.name }));
    assert.deepEqual(rows, migrations.map(({ version, name }) => ({ version, name })));
  } finally {
    database.close();
  }
});

test("a failed migration rolls back its schema and receipt", () => {
  const database = new DatabaseSync(":memory:");
  const broken: Migration = {
    version: 99,
    name: "broken-migration",
    sql: `
      CREATE TABLE should_roll_back (id INTEGER PRIMARY KEY) STRICT;
      INSERT INTO table_that_does_not_exist VALUES (1);
    `,
  };
  try {
    assert.throws(() => applyMigrations(database, [broken]), /broken-migration/u);
    const table = database
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'should_roll_back'")
      .get();
    const receipt = database.prepare("SELECT version FROM schema_migrations WHERE version = 99").get();
    assert.equal(table, undefined);
    assert.equal(receipt, undefined);
  } finally {
    database.close();
  }
});

test("durable workflow migration preserves existing cursor and bindings without cascading history", () => {
  const database = new DatabaseSync(":memory:", { enableForeignKeyConstraints: true });
  try {
    applyMigrations(database, migrations.filter(migration => migration.version < 4));
    database.exec(`INSERT INTO realtime_cursor VALUES(1,'cursor-before','2026-09-01');
      INSERT INTO conversation_bindings VALUES(1,'channel','channel','project','mention','2026-09-01','2026-09-01');`);
    applyMigrations(database);
    database.exec(`INSERT INTO workflow_publications(scope,target,discovery,session_id,run_id)
      VALUES('scope','target','discovery','session','run'); DELETE FROM conversation_bindings WHERE id=1;`);
    assert.equal(database.prepare("SELECT cursor FROM realtime_cursor").get()!.cursor, "cursor-before");
    assert.equal(database.prepare("SELECT count(*) AS n FROM workflow_publications").get()!.n, 1);
    applyMigrations(database);
  } finally { database.close(); }
});
