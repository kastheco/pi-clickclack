#!/usr/bin/env bun
// copy a pi-clickclack bot's bridge state and its referenced sessions into the
// omp bot tree, then point session references at the container path. never
// writes the source. usage:
//   bun scripts/migrate-from-pi.ts <source.sqlite> <bot tree> [--rehearsal]
// without --rehearsal both the old and the new service must be stopped.
import { Database } from "bun:sqlite";
import { chmodSync, copyFileSync, existsSync, mkdirSync, readFileSync, statSync } from "node:fs";
import { basename, join } from "node:path";

const [sourceDb, root, flag] = process.argv.slice(2);
if (!sourceDb || !root) throw new Error("usage: migrate-from-pi.ts <source.sqlite> <bot tree> [--rehearsal]");
const bot = basename(root);
const sessions = join(root, "agent/sessions");
const stateDb = join(root, "state/bridge.sqlite");
// the container mounts the bot tree at /bot.
const containerSessions = "/bot/agent/sessions";

if (flag !== "--rehearsal") {
  // the multi-project pi bot ran as the unsuffixed base bridge unit.
  const piUnit = bot === "pi" ? "pi-clickclack.service" : `pi-clickclack-${bot}.service`;
  for (const unit of [piUnit, `omp-clickclack-${bot}.service`]) {
    const state = Bun.spawnSync(["systemctl", "--user", "is-active", unit]).stdout.toString().trim();
    if (state !== "inactive" && state !== "failed") throw new Error(`${unit} is ${state}; stop it first`);
  }
}
if (existsSync(stateDb)) throw new Error(`${stateDb} already exists; refusing to overwrite bot state`);
mkdirSync(sessions, { recursive: true, mode: 0o700 });
mkdirSync(join(root, "state"), { recursive: true, mode: 0o700 });

// VACUUM INTO reads a consistent snapshot, including the WAL, without writing the source.
const source = new Database(sourceDb, { readonly: true });
source.run(`VACUUM INTO '${stateDb.replaceAll("'", "''")}'`);
source.close();

const target = new Database(stateDb);
const refs = target.query("select id, session_file, archived_at from pi_session_references").all() as Array<{ id: number; session_file: string; archived_at: string | null }>;
const moved: Array<{ file: string; bytes: number; hash: string }> = [];
const unwritten: string[] = [];
target.transaction(() => {
  for (const ref of refs) {
    const name = basename(ref.session_file);
    const dest = join(sessions, name);
    target.run("update pi_session_references set session_file = ? where id = ?", [`${containerSessions}/${name}`, ref.id]);
    if (!existsSync(ref.session_file)) {
      // pi only writes a session file once it has content. omp opens the rewritten path as a new session.
      unwritten.push(name);
      continue;
    }
    copyFileSync(ref.session_file, dest);
    chmodSync(dest, 0o600);
    const hash = new Bun.CryptoHasher("sha256").update(readFileSync(ref.session_file)).digest("hex");
    const copied = new Bun.CryptoHasher("sha256").update(readFileSync(dest)).digest("hex");
    if (hash !== copied) throw new Error(`copy mismatch for ${name}`);
    moved.push({ file: name, bytes: statSync(dest).size, hash });
  }
})();
const integrity = target.query("pragma integrity_check").get() as { integrity_check: string };
const fk = target.query("pragma foreign_key_check").all();
target.close();
if (integrity.integrity_check !== "ok" || fk.length > 0) throw new Error("migrated database failed integrity checks");
console.log(JSON.stringify({ stateDb, sessions: moved, unwritten }, null, 2));
