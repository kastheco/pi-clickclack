import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { loadExtensions } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/loader";
import {
  EXTENSION_HANDLER_TIMEOUT_MS,
  ExtensionRunner,
  testSetExtensionHandlerTimeoutMs,
} from "@oh-my-pi/pi-coding-agent/extensibility/extensions/runner";
import type { SessionBeforeCompactEvent } from "@oh-my-pi/pi-coding-agent/extensibility/shared-events";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";

const dirs: string[] = [];
afterEach(() => {
  testSetExtensionHandlerTimeoutMs(EXTENSION_HANDLER_TIMEOUT_MS);
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

test("slow compaction hook returns its custom summary after the generic event deadline", async () => {
  const dir = mkdtempSync(join(tmpdir(), "clickclack-compaction-"));
  dirs.push(dir);
  const extensionPath = join(dir, "slow-compaction.ts");
  writeFileSync(extensionPath, `export default function(pi) {
    pi.on("session_before_compact", async () => {
      // The runner uses a real deadline; exercise it against the platform clock.
      await new Promise(resolve => setTimeout(resolve, 50));
      return { compaction: { summary: "completed summary", firstKeptEntryId: "entry", tokensBefore: 100 } };
    });
  }`);
  const loaded = await loadExtensions([extensionPath], dir);
  assert.deepEqual(loaded.errors, []);
  const auth = await AuthStorage.create(join(dir, "auth.db"));
  try {
    const runner = new ExtensionRunner(
      loaded.extensions,
      loaded.runtime,
      dir,
      SessionManager.inMemory(dir),
      new ModelRegistry(auth),
    );
    testSetExtensionHandlerTimeoutMs(10);
    const errors: string[] = [];
    runner.onError(error => errors.push(error.error));
    const result = await runner.emit({
      type: "session_before_compact",
      preparation: {} as SessionBeforeCompactEvent["preparation"],
      branchEntries: [],
      signal: new AbortController().signal,
    });
    assert.equal(result?.compaction?.summary, "completed summary");
    assert.deepEqual(errors, []);
  } finally {
    auth.close();
  }
});
