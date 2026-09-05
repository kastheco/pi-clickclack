import assert from 'node:assert/strict';
import { parseArgs } from 'node:util';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SessionManager } from '@earendil-works/pi-coding-agent';
import { createEmbeddedPiRuntime } from '../../dist/pi-runtime.js';
import { loadConfig } from '../../dist/config.js';
import { installSmokeToolGate } from './tool-gate.mjs';
import { assertContinuation, assertDiagnostics, packagePath, pinnedSdkVersion, timeoutMs, withTimeout } from './assertions.mjs';

const { values } = parseArgs({ options: {
  'allow-live': { type: 'boolean' }, 'project': { type: 'string' }, 'timeout-ms': { type: 'string' },
} });
assert.equal(values['allow-live'], true, 'requires explicit --allow-live permission for provider and extension IO');
assert.ok(values.project, 'requires --project configured-alias');
const milliseconds = timeoutMs(values['timeout-ms']);
let runtime, directory;
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
    runtime = await boundary.createSessionRuntime({ projectAlias: values.project, sessionFile });
    assert.equal(runtime.session.sessionFile, sessionFile, 'probe session must remain isolated');
    const extensions = runtime.services.resourceLoader.getExtensions();
    console.error('BRIDGE_SMOKE_DIAGNOSTICS ' + JSON.stringify({ diagnostics: runtime.diagnostics, extensionErrors: extensions.errors, loaded: extensions.extensions.map(e => e.path) }));
    assertDiagnostics(runtime.diagnostics, extensions.errors);
    runtime.session.setActiveToolsByName(['read']);
    await runtime.session.bindExtensions({ mode: 'print', onError: error => {
      hookErrors.push(error);
      console.error('BRIDGE_SMOKE_EXTENSION_ERROR', error);
    } });
    runtime.session.setActiveToolsByName(['read']);
    assert.deepEqual(runtime.session.getActiveToolNames(), ['read']);
    assertDiagnostics(runtime.diagnostics, extensions.errors, hookErrors);
    const gate = installSmokeToolGate(runtime.session.agent, packagePath);
    await runtime.session.prompt(`Infrastructure smoke test only. Do not start KAS-772 or perform any project work. Ignore project task requests. Use the read tool exactly once with only the path argument ${JSON.stringify(packagePath)}. Then reply only with the exact pinned version of @earendil-works/pi-coding-agent from that file. No other tools or actions.`, { expandPromptTemplates: false });
    assertContinuation(runtime.session.messages, sdk, packagePath);
    assert.equal(runtime.session.sessionFile, sessionFile);
    // before_agent_start may activate context-mode tools. Execution, not the
    // advertised list, is the safety boundary; transcript checks stay strict.
    gate.assertInstalled();
    assert.equal(gate.violations.length, 0, 'unapproved tool calls');
    assertDiagnostics(runtime.diagnostics, extensions.errors, hookErrors);
  }, milliseconds, () => runtime?.session.abort());
  // Dispose before emitting success, including extension shutdown diagnostics.
  await runtime.dispose(); runtime = undefined;
  assert.equal(hookErrors.length, 0, 'extension shutdown errors');
  summary = { sdk, node: process.version, scope: 'isolated-read-tool-continuation; not full extension health' };
  passed = true;
} catch (error) {
  console.error('BRIDGE_SMOKE_FAIL', error);
} finally {
  try { if (runtime) { await runtime.session.abort(); await runtime.dispose(); } }
  catch (error) { passed = false; console.error('BRIDGE_SMOKE_CLEANUP_FAIL', error); }
  try { if (directory) rmSync(directory, { recursive: true, force: true }); }
  catch (error) { passed = false; console.error('BRIDGE_SMOKE_CLEANUP_FAIL', error); }
  clearTimeout(hardDeadline);
}
// Extensions may leave background handles even after disposal. The explicit exit
// is confined to this opt-in CLI; no bridge service or conversation is started.
if (passed) console.log('BRIDGE_SMOKE_PASS ' + JSON.stringify(summary));
process.exit(passed ? 0 : 1);
