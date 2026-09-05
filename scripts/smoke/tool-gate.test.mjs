import assert from 'node:assert/strict';
import test from 'node:test';
import { createRequire } from 'node:module';
import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { createReadTool } from '@earendil-works/pi-coding-agent';
import { packagePath } from './assertions.mjs';
import { installSmokeToolGate } from './tool-gate.mjs';

// Resolve the public agent-core export belonging to the pinned SDK, without
// introducing another dependency/version or using private SDK entry points.
const sdkRequire = createRequire(import.meta.resolve('@earendil-works/pi-coding-agent'));
const corePackage = pathToFileURL(sdkRequire.resolve('@earendil-works/pi-agent-core/package.json'));
const coreMetadata = JSON.parse(await readFile(corePackage, 'utf8'));
const { Agent } = await import(new URL(coreMetadata.exports['.'].import, corePackage));

async function exercise(calls, hook = async () => undefined) {
  let sideEffects = 0, reads = 0, hookCalls = 0, turns = 0;
  const read = createReadTool(process.cwd());
  const unsafe = name => ({
    name, label: name, description: 'side effect sentinel',
    parameters: { type: 'object', properties: {}, additionalProperties: true },
    execute: async () => { sideEffects++; return { content: [{ type: 'text', text: 'unsafe' }] }; },
  });
  const agent = new Agent({
    initialState: { model: { id: 'offline', provider: 'offline', api: 'offline' }, tools: [] },
    beforeToolCall: async context => { hookCalls++; return hook(context); },
    streamFn: async () => {
      const message = { role: 'assistant', content: turns++ === 0 ? calls : [{ type: 'text', text: 'finished' }], stopReason: turns === 1 ? 'toolUse' : 'stop', timestamp: 1 };
      return { async *[Symbol.asyncIterator]() { yield { type: 'done', message }; }, result: async () => message };
    },
  });
  const gate = installSmokeToolGate(agent, packagePath);
  // Model the before_agent_start activation: tools change AFTER gate install.
  agent.state.tools = [{ ...read, execute: async (...args) => { reads++; return read.execute(...args); } }, unsafe('ctx_execute'), unsafe('bash')];
  await agent.prompt('offline gate probe');
  gate.assertInstalled();
  return { sideEffects, reads, hookCalls, gate, messages: agent.state.messages };
}
const call = (name, args, id = 'call-1') => ({ type: 'toolCall', name, arguments: args, id });
for (const [name, args] of [
  ['ctx_execute', { code: 'side effect' }], ['bash', { command: 'side effect' }],
  ['read', { path: '/other/package.json' }], ['read', { path: './package.json' }],
  ['read', { path: packagePath, limit: 1 }],
]) test(`live tool gate blocks ${name} ${JSON.stringify(args)} before execute`, async () => {
  const result = await exercise([call(name, args)]);
  assert.equal(result.sideEffects, 0);
  assert.equal(result.reads, 0);
  assert.equal(result.hookCalls, 0);
  assert.equal(result.gate.violations.length, 1);
  assert.equal(result.messages.find(m => m.role === 'toolResult').isError, true);
});
test('live tool gate permits exact real package read and preserves existing SDK hook', async () => {
  const result = await exercise([call('read', { path: packagePath })]);
  assert.equal(result.sideEffects, 0);
  assert.equal(result.reads, 1);
  assert.equal(result.hookCalls, 1);
  assert.deepEqual(result.gate.violations, []);
  const output = result.messages.find(m => m.role === 'toolResult');
  assert.equal(output.isError, false);
  assert.deepEqual(JSON.parse(output.content[0].text), JSON.parse(await readFile(packagePath, 'utf8')));
});
test('live tool gate rechecks arguments mutated by installed tool_call hooks', async () => {
  const result = await exercise([call('read', { path: packagePath })], context => { context.args.path = '/other/package.json'; });
  assert.equal(result.hookCalls, 1);
  assert.equal(result.reads, 0);
  assert.equal(result.gate.violations.length, 1);
});
test('live tool gate preserves extension blocking decisions', async () => {
  const result = await exercise([call('read', { path: packagePath })], () => ({ block: true, reason: 'extension denied', terminate: true }));
  assert.equal(result.reads, 0);
  assert.match(result.messages.find(m => m.role === 'toolResult').content[0].text, /extension denied/);
});
test('live tool gate blocks duplicate reads and unsafe siblings in parallel batch', async () => {
  const result = await exercise([call('read', { path: packagePath }), call('read', { path: packagePath }, 'call-2'), call('ctx_execute', {}, 'call-3')]);
  assert.equal(result.reads, 1);
  assert.equal(result.sideEffects, 0);
  assert.equal(result.gate.violations.length, 2);
});
test('live tool gate fails closed on an existing hook error', async () => {
  const result = await exercise([call('read', { path: packagePath })], () => { throw Error('hook failed'); });
  assert.equal(result.reads, 0);
  assert.equal(result.messages.find(m => m.role === 'toolResult').isError, true);
});
