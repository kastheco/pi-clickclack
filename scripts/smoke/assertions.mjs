import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

export const packagePath = fileURLToPath(new URL('../../package.json', import.meta.url));
export const sdkName = '@earendil-works/pi-coding-agent';
export function pinnedSdkVersion() {
  const expected = JSON.parse(readFileSync(packagePath, 'utf8')).dependencies[sdkName];
  assert.match(expected, /^\d+\.\d+\.\d+(?:-[\w.-]+)?$/, 'SDK dependency must be an exact pin');
  const installed = JSON.parse(readFileSync(new URL('../../node_modules/@earendil-works/pi-coding-agent/package.json', import.meta.url), 'utf8')).version;
  assert.equal(installed, expected, 'installed SDK must match repository metadata');
  return expected;
}

export function assertDiagnostics(diagnostics, extensionErrors, hookErrors = []) {
  assert.ok(Array.isArray(diagnostics) && Array.isArray(extensionErrors), 'SDK diagnostics must be available');
  assert.equal(diagnostics.filter(d => d.type === 'error').length, 0, 'runtime initialization errors');
  assert.equal(extensionErrors.length, 0, 'extension load errors');
  assert.equal(hookErrors.length, 0, 'extension hook errors');
}

export function assertContinuation(messages, expectedVersion, expectedPath) {
  const assistants = messages.filter(m => m.role === 'assistant');
  assert.ok(assistants.length >= 2, 'tool continuation required');
  assert.ok(assistants.every(m => !['error', 'aborted'].includes(m.stopReason)), 'assistant failed or aborted');
  const calls = assistants.flatMap(m => m.content.filter(b => b.type === 'toolCall'));
  assert.equal(calls.length, 1, 'exactly one tool call required');
  assert.equal(calls[0].name, 'read', 'only read allowed');
  assert.deepEqual(calls[0].arguments, { path: expectedPath }, 'must read exactly this repository package.json');
  const results = messages.filter(m => m.role === 'toolResult');
  assert.equal(results.length, 1, 'exactly one tool result required');
  assert.equal(results[0].toolName, 'read');
  assert.equal(results[0].toolCallId, calls[0].id, 'tool result must match call');
  assert.equal(results[0].isError, false, 'successful read required');
  const readText = results[0].content.filter(b => b.type === 'text').map(b => b.text).join('');
  const readPackage = JSON.parse(readText);
  assert.equal(readPackage.dependencies?.[sdkName], expectedVersion, 'read result must contain the pinned SDK dependency');
  const callMessage = assistants.find(m => m.content.includes(calls[0]));
  const final = assistants.at(-1);
  assert.ok(messages.indexOf(callMessage) < messages.indexOf(results[0]), 'call must precede result');
  assert.ok(messages.indexOf(results[0]) < messages.indexOf(final), 'final must follow tool result');
  assert.equal(final.stopReason, 'stop', 'final must finish normally');
  assert.equal(final.content.filter(b => b.type === 'text').map(b => b.text).join('').trim(), expectedVersion, 'exact pinned version response required');
}

export function timeoutMs(value = '120000') {
  assert.match(value, /^\d+$/, 'timeout must be positive integer milliseconds');
  const parsed = Number(value);
  assert.ok(Number.isSafeInteger(parsed) && parsed > 0 && parsed <= 600000, 'timeout must be 1..600000ms');
  return parsed;
}

export async function withTimeout(operation, milliseconds, onTimeout = () => {}) {
  let timer;
  try {
    return await Promise.race([
      Promise.resolve().then(operation),
      new Promise((_, reject) => { timer = setTimeout(() => {
        reject(new Error(`smoke timed out after ${milliseconds}ms`));
        Promise.resolve().then(onTimeout).catch(() => {});
      }, milliseconds); }),
    ]);
  } finally { clearTimeout(timer); }
}
