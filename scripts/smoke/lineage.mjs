import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SessionManager, convertToLlm } from '@earendil-works/pi-coding-agent';

// Tests SDK persistence, not an AgentSession/model loop. The optional provider is
// the caller's unchanged attribution module; transport is replaced by a sentinel.
export async function exerciseLineage(inject, provider) {
  const directory = mkdtempSync(join(tmpdir(), 'pi-lineage-'));
  const originalFetch = globalThis.fetch;
  let fetchCalls = 0;
  globalThis.fetch = async () => { fetchCalls++; throw Error('OFFLINE_TRANSPORT_BOUNDARY'); };
  const model = { provider: 'anthropic', api: 'anthropic-messages', id: 'claude-opus-5', baseUrl: 'https://api.anthropic.com', reasoning: true, maxTokens: 32000, compat: { supportsLongCacheRetention: true } };
  const options = { apiKey: 'sk-ant-oat-offline-fake', sessionId: 'offline', cacheRetention: 'long', reasoning: 'high' };
  const context = messages => ({ messages, systemPrompt: 'stable', tools: [{ name: 'read', parameters: { type: 'object', properties: {} } }] });
  try {
    let sm = SessionManager.create(directory, directory);
    const messages = () => convertToLlm(sm.buildSessionContext().messages);
    let injections = 0;
    async function prompt(text) {
      const returns = await inject({ prompt: text, systemPrompt: 'stable' }, { cwd: directory, sessionManager: sm });
      assert.equal(returns.length, 2);
      sm.appendMessage({ role: 'user', content: [{ type: 'text', text }], timestamp: 1 });
      for (const [i, result] of returns.entries()) {
        assert.equal(result?.message?.customType, ['context-mode', 'hindsight-memory'][i]);
        assert.equal(result.message.display, false);
        assert.ok(result.message.content.length > 0);
        assert.equal(result.systemPrompt, undefined);
        assert.equal(result.messages, undefined);
        sm.appendCustomMessageEntry(result.message.customType, result.message.content, result.message.display);
      }
      injections++;
    }
    function toolTurn() {
      const assistant = { role: 'assistant', api: model.api, provider: model.provider, model: model.id, stopReason: 'toolUse', timestamp: 2, content: [{ type: 'toolCall', id: `offline-${injections}`, name: 'read', arguments: {} }] };
      if (provider) {
        const requestPayload = provider.buildAnthropicRequestParams(model, context(messages()), options);
        assistant.diagnostics = [provider.createAnthropicLineageDiagnostic({ model, responseId: 'msg_offline', assistantContent: assistant.content, requestPayload })];
      }
      sm.appendMessage(assistant);
      sm.appendMessage({ role: 'toolResult', toolCallId: `offline-${injections}`, toolName: 'read', content: [{ type: 'text', text: 'offline result' }], timestamp: 3, isError: false });
    }
    async function transport(input = messages(), rejected = false) {
      if (!provider) return;
      const before = fetchCalls;
      const output = await provider.streamAnthropicViaBetaMessages(model, context(input), options, { loadAccount: () => ({ deviceId: 'a'.repeat(64), accountUuid: '00000000-0000-4000-8000-000000000001' }) }).result();
      assert.equal(output.errorMessage, rejected ? 'Anthropic cache lineage diverged before transport: message history is not append-only' : 'OFFLINE_TRANSPORT_BOUNDARY');
      assert.equal(fetchCalls - before, rejected ? 0 : 1, 'guard/transport boundary');
    }
    await prompt('first prompt');
    const prefix = structuredClone(messages());
    toolTurn(); await transport(); await transport(); // error retry
    toolTurn(); await transport();
    await prompt('second prompt'); await transport();
    const persisted = structuredClone(messages());
    sm = SessionManager.open(sm.getSessionFile());
    assert.deepEqual(messages(), persisted);
    sm = SessionManager.open(sm.createBranchedSession(sm.getLeafId()));
    assert.deepEqual(messages(), persisted);
    assert.deepEqual(messages().slice(0, 3), prefix);
    await transport();
    for (const index of [1, 2]) await transport(messages().filter((_, i) => i !== index), true);
    const second = sm.getBranch().find(e => e.type === 'message' && e.message.role === 'user' && e.message.content?.[0]?.text === 'second prompt');
    sm.appendCompaction('offline summary', second.id, 100);
    const compacted = structuredClone(messages());
    assert.equal(compacted.some(m => m.role === 'assistant'), false);
    assert.equal(sm.buildSessionContext().messages.filter(m => m.role === 'custom').length, 2);
    sm = SessionManager.open(sm.getSessionFile());
    assert.deepEqual(messages(), compacted);
    toolTurn(); await transport();
    await prompt('post-compaction prompt'); await transport();
    const firstUser = sm.getBranch().find(e => e.type === 'message' && e.message.role === 'user');
    sm.branch(firstUser.id);
    assert.equal(messages().length, 1, 'branch before injections excludes future memory');
    return { prompts: injections, fetchCalls, scope: provider ? 'installed-injector-policy-and-guard' : 'SDK-persistence-only' };
  } finally {
    globalThis.fetch = originalFetch;
    rmSync(directory, { recursive: true, force: true });
  }
}
