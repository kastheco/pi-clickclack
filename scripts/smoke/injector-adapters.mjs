import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';
import { buildSessionContext } from '@earendil-works/pi-coding-agent';

const transpile = source => ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ES2022 } }).outputText;
async function loadModule(path, dependencies) {
  const module = new vm.SourceTextModule(transpile(readFileSync(path, 'utf8')));
  await module.link(specifier => {
    const values = dependencies[specifier];
    assert.ok(values, `unsupported dependency ${specifier} in ${path}; review adapter before updating`);
    return new vm.SyntheticModule(Object.keys(values), function () {
      for (const [key, value] of Object.entries(values)) this.setExport(key, value);
    });
  });
  await module.evaluate();
  return module.namespace;
}

// These packages do not expose dependency-injected factories for both hook
// registration and external IO. Evaluate only their actual policy with explicit
// IO doubles, never bootstrap installed extensions/services. See smoke-suite.md.
export async function installedInjectors(contextPath, hindsightRoot) {
  const ast = ts.createSourceFile(contextPath, readFileSync(contextPath, 'utf8'), ts.ScriptTarget.Latest, true);
  const hooks = {};
  const sandbox = vm.createContext({
    _sessionId: 'offline', _attribution: {}, pluginRoot: '/offline',
    ensureMCPBridge: async () => {}, isForegroundSession: () => false,
    extractUserEvents: () => [], getAutoInjection: async () => null,
    db: { insertEvent() {}, getEvents: () => [], getResume: () => null },
  });
  function visit(node) {
    if (ts.isCallExpression(node) && node.expression.getText(ast) === 'pi.on' && ['context', 'before_agent_start'].includes(node.arguments[0]?.text)) {
      const name = node.arguments[0].text;
      assert.equal(hooks[name], undefined, `duplicate ${name} hook; review adapter`);
      hooks[name] = vm.runInContext(transpile('var hook = ' + node.arguments[1].getText(ast)) + '\nhook;', sandbox);
    }
    ts.forEachChild(node, visit);
  }
  visit(ast);
  assert.equal(hooks.context, undefined, 'context-mode must not mutate transient context');
  assert.equal(typeof hooks.before_agent_start, 'function');
  let enabled = true, allowed = true, failure = false, position = 'append';
  const calls = [];
  const recallModule = await loadModule(new URL('extensions/lifecycle/memory-lifecycle-recall.ts', hindsightRoot), {
    './recall.js': { recallForContext: async args => {
      calls.push(args);
      if (failure) throw Error('offline');
      return { rendered: '<hindsight-memory>synthetic memory</hindsight-memory>', blocks: [{ bankId: 'offline', memoryCount: 1 }], failed: 0, failures: [] };
    } },
    '../utils/sanitize.js': { redactError: () => 'offline' },
    './recall-visibility.js': { writeLastRecallSnapshot: () => { throw Error('unexpected sidecar'); } },
    '../operations/memory-scope.js': { selectMemoryScopes: () => [{ bankId: 'offline' }] },
    '../utils/session-memory-meta.js': { getEffectiveSessionMemoryMode: () => ({ recall: allowed }), readSessionMemoryMeta: async () => ({}) },
  });
  const policy = recallModule.createRecallTurnPolicy({
    getConfig: () => ({ enabled, recall: { enabled: true, injectionPosition: position, cacheTtlMs: 60000, storeLastRecall: false }, notifications: { recall: false } }),
    getClient: () => ({}), setMemoryStatus() {}, notify() { throw Error('unexpected notification'); },
  });
  const event = { messages: [{ role: 'user', content: 'one', timestamp: 1 }] };
  for (position of ['append', 'prepend']) {
    const result = await policy.recall(event, { cwd: '/offline/a', sessionFile: 'a' });
    assert.equal(result?.message?.customType, 'hindsight-memory');
    assert.equal(result.message.display, false);
    assert.equal(result.messages, undefined);
  }
  await policy.recall(event, { cwd: '/offline/b', sessionFile: 'b' });
  assert.equal(calls.length, 3, 'equal-length sessions must not share recall');
  allowed = false;
  assert.equal(await policy.recall(event, { cwd: '/offline' }), undefined);
  allowed = true; enabled = false;
  assert.equal(await policy.recall(event, { cwd: '/offline' }), undefined);
  assert.equal(calls.length, 3);
  enabled = true; failure = true;
  assert.equal(await policy.recall(event, { cwd: '/offline' }), undefined);
  failure = false;
  const hindsightHooks = {};
  const index = await loadModule(new URL('extensions/index.ts', hindsightRoot), {
    '@earendil-works/pi-coding-agent': { buildSessionContext },
    './operations/tools.js': { registerTools() {} }, './tui/commands.js': { registerCommands() {} },
    './lifecycle/memory-lifecycle.js': { createMemoryLifecycle: () => ({ deps: {}, recall: (event, runtime) => policy.recall(event, runtime) }) },
  });
  index.default({ on: (name, fn) => { assert.equal(hindsightHooks[name], undefined); hindsightHooks[name] = fn; } });
  assert.equal(hindsightHooks.context, undefined, 'Hindsight must not mutate transient context');
  assert.equal(typeof hindsightHooks.before_agent_start, 'function');
  return async (event, runtime) => {
    const before = calls.length;
    const results = [await hooks.before_agent_start(event, {}), await hindsightHooks.before_agent_start(event, runtime)];
    assert.equal(calls.length, before + 1, 'fresh recall per prompt');
    assert.equal(calls.at(-1).messages.filter(m => m.role === 'user' && m.content?.[0]?.text === event.prompt).length, 1, 'current prompt exactly once');
    if (event.prompt === 'post-compaction prompt') assert.equal(calls.at(-1).messages.some(m => m.role === 'user' && m.content?.[0]?.text === 'first prompt'), false, 'query must use compacted branch');
    return results;
  };
}

export async function loadGuard(path) {
  // No edits or guard bypass: transpile the entire standalone installed module.
  return loadModule(path, {
    'node:crypto': await import('node:crypto'),
    'node:os': await import('node:os'),
    'node:path': await import('node:path'),
    'node:fs': {
      readFileSync() { throw Error('unexpected guard filesystem read'); },
      appendFileSync() { throw Error('unexpected guard filesystem write (disable attribution audit logging)'); },
    },
  });
}
