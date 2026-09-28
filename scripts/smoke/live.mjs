import assert from 'node:assert/strict';
import { parseArgs } from 'node:util';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SessionManager } from '@oh-my-pi/pi-coding-agent';
import { createEmbeddedPiRuntime } from '../../src/pi-runtime.ts';
import { loadConfig } from '../../src/config.ts';
import { installSmokeToolGate } from './tool-gate.mjs';
import { assertContinuation, assertLoadedExtensions, packagePath, pinnedSdkVersion, timeoutMs, withTimeout } from './assertions.mjs';

const { values } = parseArgs({ options: {
  'allow-live': { type: 'boolean' }, 'project': { type: 'string' }, 'timeout-ms': { type: 'string' },
} });
assert.equal(values['allow-live'], true, 'requires explicit --allow-live permission for provider and extension IO');
assert.ok(values.project, 'requires --project configured-alias');
const milliseconds = timeoutMs(values['timeout-ms']);
let session, directory, unsubscribe;
const hookErrors = [];
// Hard deadline covers initialization and uncooperative extension shutdown too.
// Normal timeouts abort/dispose first; a hung SDK cannot produce a PASS exit.
const hardDeadline = setTimeout(() => {
  console.error('BRIDGE_SMOKE_FAIL hard deadline; cleanup may be incomplete');
  process.exit(1);
}, milliseconds + 10000);
let passed = false;
let summary;
try {
  const sdk = pinnedSdkVersion();
  const config = loadConfig();
  const boundary = createEmbeddedPiRuntime(config);
  const project = boundary.project(values.project);
  directory = mkdtempSync(join(tmpdir(), 'pi-bridge-smoke-'));
  const manager = SessionManager.create(project.cwd, directory);
  // SDK creates files lazily. Seed only its generated header so the production
  // boundary opens this unique probe, never a user's conversation/session.
  const sessionFile = manager.getSessionFile();
  writeFileSync(sessionFile, JSON.stringify(manager.getHeader()) + '\n', { flag: 'wx', mode: 0o600 });
  await withTimeout(async () => {
    session = await boundary.createSessionRuntime({ projectAlias: values.project, sessionFile });
    assert.equal(session.sessionFile, sessionFile, 'probe session must remain isolated');
    const runner = session.extensionRunner;
    const loaded = runner?.getExtensionPaths() ?? [];
    const expected = config.pi.extensionPaths ?? [];
    console.error('BRIDGE_SMOKE_DIAGNOSTICS ' + JSON.stringify({ loaded, expected }));
    assertLoadedExtensions(loaded, expected);
    unsubscribe = runner?.onError(error => {
      hookErrors.push(error);
      console.error('BRIDGE_SMOKE_EXTENSION_ERROR', error);
    });
    await session.setActiveToolsByName(['read']);
    assert.deepEqual(session.getActiveToolNames(), ['read']);
    const gate = installSmokeToolGate(session.agent, packagePath);
    await session.prompt('Infrastructure smoke test only. Do not perform project work. Use the read tool exactly once with only the path argument ' + JSON.stringify(packagePath) + '. Then reply only with the exact pinned version of @oh-my-pi/pi-coding-agent from that file. No other tools or actions.', { expandPromptTemplates: false });
    assertContinuation(session.messages, sdk, packagePath);
    assert.equal(session.sessionFile, sessionFile);
    gate.assertInstalled();
    assert.equal(gate.violations.length, 0, 'unapproved tool calls');
    assertLoadedExtensions(loaded, expected, hookErrors);
  }, milliseconds, () => session?.abort());
  await session.dispose(); session = undefined;
  assert.equal(hookErrors.length, 0, 'extension shutdown errors');
  summary = { sdk, bun: Bun.version, scope: 'isolated-read-tool-continuation; configured-extension-paths, not full extension health' };
  passed = true;
} catch (error) {
  console.error('BRIDGE_SMOKE_FAIL', error);
} finally {
  try { if (session) { await session.abort(); await session.dispose(); } }
  catch (error) { passed = false; console.error('BRIDGE_SMOKE_CLEANUP_FAIL', error); }
  unsubscribe?.();
  try { if (directory) rmSync(directory, { recursive: true, force: true }); }
  catch (error) { passed = false; console.error('BRIDGE_SMOKE_CLEANUP_FAIL', error); }
  clearTimeout(hardDeadline);
}
// Extensions may leave background handles even after disposal. The explicit exit
// is confined to this opt-in CLI; no bridge service or conversation is started.
if (passed) console.log('BRIDGE_SMOKE_PASS ' + JSON.stringify(summary));
process.exit(passed ? 0 : 1);
