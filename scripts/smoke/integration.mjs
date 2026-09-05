import assert from 'node:assert/strict';
import { parseArgs } from 'node:util';
import { resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { pinnedSdkVersion, timeoutMs } from './assertions.mjs';
import { installedInjectors, loadGuard } from './injector-adapters.mjs';
import { exerciseLineage } from './lineage.mjs';

const { values } = parseArgs({ options: {
  'allow-installed-code': { type: 'boolean' },
  'context-extension': { type: 'string' }, 'hindsight-root': { type: 'string' },
  'guard': { type: 'string' }, 'guard-sha256': { type: 'string' }, 'timeout-ms': { type: 'string' },
} });
assert.equal(values['allow-installed-code'], true, 'requires --allow-installed-code (trusted installed policy code only)');
for (const name of ['context-extension', 'hindsight-root', 'guard', 'guard-sha256']) assert.ok(values[name], `requires --${name}`);
const deadline = setTimeout(() => { console.error('INTEGRATION_FAIL timeout'); process.exit(1); }, timeoutMs(values['timeout-ms']));
try {
  const sdk = pinnedSdkVersion();
  const guardPath = resolve(values.guard);
  const guardHash = createHash('sha256').update(readFileSync(guardPath)).digest('hex');
  assert.match(values['guard-sha256'], /^[a-f0-9]{64}$/);
  assert.equal(guardHash, values['guard-sha256'], 'guard source changed; review rather than weakening lineage checks');
  const inject = await installedInjectors(resolve(values['context-extension']), pathToFileURL(resolve(values['hindsight-root']) + sep));
  const result = await exerciseLineage(inject, await loadGuard(guardPath));
  assert.equal(createHash('sha256').update(readFileSync(guardPath)).digest('hex'), guardHash);
  console.log('INTEGRATION_PASS ' + JSON.stringify({ sdk, node: process.version, guardHash, ...result }));
} catch (error) {
  console.error('INTEGRATION_FAIL', error);
  process.exitCode = 1;
} finally { clearTimeout(deadline); }
