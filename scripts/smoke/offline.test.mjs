import assert from 'node:assert/strict';
import test from 'node:test';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { assertContinuation, assertDiagnostics, packagePath, pinnedSdkVersion, timeoutMs, withTimeout } from './assertions.mjs';
import { exerciseLineage } from './lineage.mjs';

const version = pinnedSdkVersion();
function transcript() {
  return [
    { role: 'user', content: 'probe' },
    { role: 'assistant', stopReason: 'toolUse', content: [{ type: 'toolCall', id: 'call-1', name: 'read', arguments: { path: packagePath } }] },
    { role: 'toolResult', toolCallId: 'call-1', toolName: 'read', isError: false, content: [{ type: 'text', text: JSON.stringify({ dependencies: { '@earendil-works/pi-coding-agent': version } }) }] },
    { role: 'assistant', stopReason: 'stop', content: [{ type: 'text', text: version }] },
  ];
}
test('smoke assertions accept only successful ordered read continuation', () => {
  assertContinuation(transcript(), version, packagePath);
});
const failures = {
  'no tool continuation': messages => messages.splice(1, 2),
  'failed read': messages => { messages[2].isError = true; },
  'empty read content': messages => { messages[2].content = []; },
  'unrelated read content': messages => { messages[2].content[0].text = '{}'; },
  'truncated read content': messages => { messages[2].content[0].text = '{'; },
  'missing result status': messages => { delete messages[2].isError; },
  'wrong tool': messages => { messages[1].content[0].name = 'bash'; },
  'wrong path': messages => { messages[1].content[0].arguments.path = '/other/package.json'; },
  'extra tool argument': messages => { messages[1].content[0].arguments.limit = 1; },
  'wrong call id': messages => { messages[2].toolCallId = 'other'; },
  'wrong result tool': messages => { messages[2].toolName = 'bash'; },
  'extra call': messages => { messages[1].content.push({ ...messages[1].content[0] }); },
  'extra result': messages => { messages.splice(3, 0, { ...messages[2] }); },
  'result before call': messages => { [messages[1], messages[2]] = [messages[2], messages[1]]; },
  'final before result': messages => { [messages[2], messages[3]] = [messages[3], messages[2]]; },
  'wrong version': messages => { messages[3].content[0].text = '0.0.0'; },
  'substring version': messages => { messages[3].content[0].text = `not ${version}`; },
  'aborted final': messages => { messages[3].stopReason = 'aborted'; },
  'earlier assistant error': messages => { messages[1].stopReason = 'error'; },
  'unfinished final': messages => { messages[3].stopReason = 'length'; },
};
for (const [name, mutate] of Object.entries(failures)) test(`smoke rejects ${name}`, () => {
  const messages = transcript(); mutate(messages);
  assert.throws(() => assertContinuation(messages, version, packagePath));
});
test('diagnostics fail closed for load, initialization, hook, and missing diagnostics', () => {
  assertDiagnostics([{ type: 'warning', message: 'reported separately' }], []);
  assert.throws(() => assertDiagnostics([{ type: 'error' }], []));
  assert.throws(() => assertDiagnostics([], [{ path: 'pi-lcm', error: 'native ABI mismatch' }]));
  assert.throws(() => assertDiagnostics([], [], [{ message: 'startup error' }]));
  assert.throws(() => assertDiagnostics(undefined, []));
});
test('timeouts validate input and abort without false success', async () => {
  for (const value of ['0', '-1', 'NaN', '1.2', '600001', 'Infinity', '']) assert.throws(() => timeoutMs(value));
  assert.equal(timeoutMs('100'), 100);
  assert.equal(await withTimeout(() => 'ok', 100), 'ok');
  await assert.rejects(withTimeout(() => { throw Error('operation failed'); }, 100), /operation failed/);
  let aborted = false;
  await assert.rejects(withTimeout(() => new Promise(() => {}), 5, () => { aborted = true; }), /timed out/);
  assert.equal(aborted, true);
});
test('opt-in CLIs reject absent permission without runtime creation or network', () => {
  for (const name of ['live', 'integration']) {
    const result = spawnSync(process.execPath, ['--experimental-vm-modules', fileURLToPath(new URL(`./${name}.mjs`, import.meta.url))], { encoding: 'utf8', timeout: 15000, env: { PATH: process.env.PATH } });
    assert.equal(result.error, undefined);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /requires.*--allow-/);
    assert.doesNotMatch(result.stdout, /_PASS/);
  }
});
test('SDK durable injection persistence, continuation, retry, reload, fork, compaction and branch', async () => {
  const result = await exerciseLineage(async () => ['context-mode', 'hindsight-memory'].map(customType => ({ message: { customType, content: `${customType} synthetic fixture`, display: false } })));
  assert.deepEqual(result, { prompts: 3, fetchCalls: 0, scope: 'SDK-persistence-only' });
});
test('lineage exercise rejects a fake transport sentinel without a fetch', async () => {
  const provider = {
    buildAnthropicRequestParams: () => ({}), createAnthropicLineageDiagnostic: () => ({}),
    streamAnthropicViaBetaMessages: () => ({ result: async () => ({ errorMessage: 'OFFLINE_TRANSPORT_BOUNDARY' }) }),
  };
  await assert.rejects(exerciseLineage(async () => ['context-mode', 'hindsight-memory'].map(customType => ({ message: { customType, content: 'fixture', display: false } })), provider), /guard\/transport boundary/);
});
test('SDK lineage exercise rejects missing durable injector returns', async () => {
  await assert.rejects(exerciseLineage(async () => [{ messages: [] }, {}]));
});
