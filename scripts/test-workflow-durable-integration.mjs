#!/usr/bin/env node
// Real packaged host + bridge watcher/outbox + SDK + disposable Go API/SQLite.
// No installed service, model, Electron profile, or sibling source is modified.
import assert from 'node:assert/strict';
import { spawn, spawnSync, execFileSync } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync, realpathSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createServer } from 'node:net';
import { ClickClackClient } from '@clickclack/sdk-ts';
import { WorkflowClient } from '@osolmaz/pi-workflows/client';
import { DurableWorkflowPublisher } from '../dist/workflow-durable-publisher.js';
import { WorkflowDecisionWatcher } from '../dist/workflow-decisions.js';
import { StateStore } from '../dist/state/store.js';
assert.equal(process.versions.node, '24.20.0');
const root = resolve(process.env.CLICKCLACK_CANDIDATE_ROOT ?? '../clickclack.kas-769-workflow-activity');
const hostRoot = realpathSync('node_modules/@osolmaz/pi-workflows');
assert.equal(JSON.parse(readFileSync(join(hostRoot, 'package.json'))).version, '0.16.0-kas.769.3');
assert.equal(JSON.parse(readFileSync('node_modules/@earendil-works/pi-coding-agent/package.json')).version, '0.85.1');
const { WorkflowHost } = await import(pathToFileURL(join(hostRoot, 'dist/host/runner.js')));
const temp = mkdtempSync(join(tmpdir(), 'bridge-durable-integration-'));
let server, host, client, watcher, publisher, store, electronApp;
const sockets = [];
let serverLog = '';
const waitFor = async (fn, description, timeout = 120_000) => {
  const end = Date.now() + timeout;
  while (Date.now() < end) { if (await fn()) return; await new Promise(r => setTimeout(r, 50)); }
  throw new Error(`Timed out: ${description}`);
};
try {
  const staged = join(temp, 'api-source'); mkdirSync(staged);
  for (const file of ['go.mod', 'go.sum']) cpSync(join(root, file), join(staged, file));
  cpSync(join(root, 'apps/api'), join(staged, 'apps/api'), { recursive: true });
  if (process.env.CLICKCLACK_ELECTRON_EXECUTABLE) {
    rmSync(join(staged, 'apps/api/internal/webassets/dist'), { recursive: true });
    cpSync(join(root, 'apps/web/dist'), join(staged, 'apps/api/internal/webassets/dist'), { recursive: true });
  }
  const binary = join(temp, 'api');
  assert.equal(spawnSync('go', ['build', '-o', binary, './apps/api/cmd/clickclack'], { cwd: staged, stdio: 'inherit' }).status, 0);
  const reservation = createServer(); await new Promise(r => reservation.listen(0, '127.0.0.1', r));
  const port = reservation.address().port; await new Promise(r => reservation.close(r));
  const endpoint = `http://127.0.0.1:${port}`;
  server = spawn(binary, ['serve', '--addr', `127.0.0.1:${port}`, '--data', join(temp, 'api-data'), '--dev-bootstrap=true'], { stdio: ['ignore', 'pipe', 'pipe'] });
  server.stdout.on('data', b => { serverLog += b; }); server.stderr.on('data', b => { serverLog += b; });
  await waitFor(async () => { try { return (await fetch(`${endpoint}/healthz`)).ok; } catch { return false; } }, 'fixture API health');
  const api = async (path, body) => {
    const response = await fetch(endpoint + path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    assert.equal(response.ok, true, `${path}: ${await response.clone().text()}`); return response.json();
  };
  const { workspace } = await api('/api/workspaces', { name: 'Durable bridge fixture' });
  const { channel } = await api(`/api/workspaces/${workspace.id}/channels`, { name: 'fixture', kind: 'public' });
  const { bot_token } = await api(`/api/workspaces/${workspace.id}/bots`, { display_name: 'Fixture', scopes: ['bot:write', 'agent_activity:write', 'dms:write'] });
  const sdk = new ClickClackClient({ baseUrl: endpoint, token: bot_token.token });
  const identity = await sdk.me();
  const project = join(temp, 'project'); mkdirSync(project);
  const git = (...args) => execFileSync('git', args, { cwd: project, stdio: ['ignore', 'pipe', 'pipe'], encoding: 'utf8' }).trim();
  git('init', '-b', 'main'); git('config', 'user.name', 'Fixture'); git('config', 'user.email', 'fixture@example.invalid');
  writeFileSync(join(project, 'baseline.txt'), 'baseline'); git('add', '.'); git('commit', '-m', 'fixture');
  const workflow = join(temp, 'fixture.workflow.ts');
  writeFileSync(workflow, `
import fs from 'node:fs/promises';
import { action, manualEffect, compute, defineWorkflow, includeWorkflow } from ${JSON.stringify(join(hostRoot, 'dist/workflows/index.js'))};
import workspace from ${JSON.stringify(join(hostRoot, 'dist/builtins/workspace-preparation.workflow.js'))};
export default defineWorkflow({ source: import.meta.url, name: 'durable-fixture', startAt: 'gate', maxSteps: 400,
 includes: { workspace: includeWorkflow(workspace, { input: ({ input }) => input }) },
 nodes: {
  gate: compute({ run: async ({ input }) => { while (true) { try { await fs.access(input.repository + '/release'); await fs.unlink(input.repository + '/release'); break; } catch { await new Promise(r => setTimeout(r, 50)); } } return {}; } }),
  repeat: compute({ run: ({ outputs }) => { const n = (outputs.repeat?.n ?? 0) + 1; return { n, route: n < 260 ? 'again' : 'done', privateState: 'PRIVATE FIXTURE STATE' }; } }),
  mutate: action({ effect: manualEffect('fixture-write'), run: async ({ input }) => { await fs.writeFile(input.repository + '/final.txt', 'private content'); return { files: ['forged.txt'] }; } })
 }, edges: [{ from: 'gate', to: 'repeat' }, { from: 'repeat', switch: { on: '$.route', cases: { again: 'repeat', done: 'workspace' } } }, { from: 'workspace.ready', to: 'mutate' }]
});`);
  const databasePath = join(temp, 'host.sqlite');
  host = new WorkflowHost({ databasePath, claimPollMs: 10 }); await host.start();
  client = new WorkflowClient({ databasePath, clientId: 'fixture-bridge' });
  const bridgePath = join(temp, 'bridge.sqlite'); store = new StateStore(bridgePath);
  let fail = true, publications = 0, now = Date.now();
  const makePublisher = () => new DurableWorkflowPublisher({ database: store.database, endpoint, hostIdentity: databasePath, producerId: identity.id, workspaceId: workspace.id,
    client: () => client, now: () => now,
    publish: async input => { publications++; const result = await sdk.workflowRuns.publish(input); if (fail) throw new Error('fixture acknowledgment lost after server commit'); return result; } });
  publisher = makePublisher();
  const target = { workspace_id: workspace.id, channel_id: channel.id };
  watcher = new WorkflowDecisionWatcher({ client, sessionId: 'fixture-session', present: async () => { throw new Error('No decisions expected'); },
    onRun: event => publisher.observe(target, 'fixture-session', event, 'fixture-binding-project') });
  await watcher.start();
  const resolved = await client.resolveWorkflow({ cwd: project, workflowRef: workflow });
  const response = await client.request({ operation: 'run.start', runId: 'fixture-run', payload: {
    projectPath: project, ...resolved, input: { repository: project, workspaceMode: 'defaultBranch', directDefaultBranchAuthorized: true },
    launchOptions: {}, originSessionId: 'fixture-session', executionMode: 'headless' } });
  assert.equal(response.outcome, 'accepted', JSON.stringify(response));
  await waitFor(() => store.database.prepare('SELECT count(*) AS n FROM workflow_publications').get().n === 1, 'midrun discovery');
  fail = false;
  await publisher.flush();
  const midrun = (await sdk.workflowRuns.listChannel(channel.id)).runs[0].snapshot;
  assert.equal(midrun.run.status, 'running');
  publications = 0; fail = true; now += 60_000;
  writeFileSync(join(project, 'release'), '');
  await waitFor(async () => {
    const view = await client.getRun('fixture-run');
    if (view?.display.status === 'failed') throw new Error(`Fixture workflow failed: ${view.display.reason}`);
    return view?.display.status === 'completed';
  }, 'real host terminal snapshot');
  await waitFor(() => store.database.prepare('SELECT count(*) AS n FROM workflow_publications').get().n === 1, 'watcher persisted identity');
  const { collectWorkflowSnapshot } = await import('../dist/workflow-snapshot.js');
  await collectWorkflowSnapshot(client, 'fixture-session', 'fixture-run', true);
  await publisher.flush(); assert.equal(publications, 1);
  assert.equal(store.database.prepare('SELECT delivered FROM workflow_publications').get().delivered, 0);
  await watcher.stop(); watcher = undefined; await publisher.stop(); store.close();
  // No watcher/session pointer required after restart: replay the frozen terminal envelope.
  store = new StateStore(bridgePath); fail = false; now += 60_000; publisher = makePublisher();
  publisher.observe(target, 'fixture-session', { view: { sessionId: 'fixture-session', run: null } }, 'fixture-binding-project');
  await publisher.flush(); assert.equal(publications, 2);
  const page = await sdk.workflowRuns.listChannel(channel.id, { limit: 20 });
  assert.equal(page.runs.length, 1); const snapshot = page.runs[0].snapshot;
  assert.equal(snapshot.run.status, 'completed'); assert.equal(snapshot.run.stepsComplete, true);
  assert.ok(snapshot.steps.length > 256); assert.equal(snapshot.steps.filter(s => s.nodeId === 'repeat').length, 260);
  assert.equal(new Set(snapshot.steps.map(s => s.attemptId)).size, snapshot.steps.length);
  assert.ok(snapshot.files.entries.some(entry => entry.path === 'final.txt' && entry.change === 'untracked'));
  assert.doesNotMatch(JSON.stringify(snapshot), /PRIVATE|private content|forged|\/tmp\//);
  assert.equal(store.database.prepare('SELECT delivered FROM workflow_publications').get().delivered, 1);
  assert.ok(snapshot.source.revision > midrun.source.revision);
  const stale = await sdk.workflowRuns.publish({ ...target, snapshot: midrun });
  assert.equal(stale.changed, false); assert.deepEqual(stale.record.snapshot, snapshot);
  const replay = await sdk.workflowRuns.publish({ ...target, snapshot }); assert.equal(replay.changed, false);
  await assert.rejects(sdk.workflowRuns.publish({ ...target, snapshot: { ...snapshot, run: { ...snapshot.run, workflowName: 'conflict' } } }));
  // DM membership, scope and server-derived recipients on actual websocket routing.
  const denialStatuses = [];
  const makeBot = async scopes => {
    const { bot_token } = await api(`/api/workspaces/${workspace.id}/bots`, { display_name: 'DM fixture', scopes });
    return new ClickClackClient({ baseUrl: endpoint, token: bot_token.token, fetch: async (...args) => { const result = await fetch(...args); if (!result.ok) denialStatuses.push(result.status); return result; } });
  };
  const noScope = await makeBot(['messages:write', 'agent_activity:write', 'profile:read']);
  const outsider = await makeBot(['bot:write', 'agent_activity:write', 'dms:write']);
  const dm = await api('/api/dms', { workspace_id: workspace.id, member_ids: [identity.id, (await noScope.me()).id] });
  const dmTarget = { workspace_id: workspace.id, direct_conversation_id: dm.conversation.id };
  for (const denied of [noScope, outsider]) {
    await assert.rejects(denied.workflowRuns.publish({ ...dmTarget, snapshot }), error => /missing scope dms:write|direct conversation unavailable/.test(error.message));
  }
  assert.deepEqual(denialStatuses, [403, 403]);
  const memberEvents = [], outsiderEvents = [];
  for (const [transport, events] of [[sdk, memberEvents], [outsider, outsiderEvents]]) {
    const socket = transport.events.subscribe({ workspaceId: workspace.id, onEvent: event => events.push(event) }); sockets.push(socket);
    await new Promise((resolve, reject) => { socket.addEventListener('open', resolve, { once: true }); socket.addEventListener('error', reject, { once: true }); });
  }
  publisher.observe(dmTarget, 'fixture-session', { view: { schema: 'pi-workflows.session-view.v1', sessionId: 'fixture-session', run: await client.getRun('fixture-run') } }, 'dm-binding');
  now += 60_000; await publisher.flush();
  assert.deepEqual((await sdk.workflowRuns.listDirect(dm.conversation.id)).runs[0].snapshot, snapshot);
  await waitFor(() => memberEvents.some(e => e.type === 'workflow.snapshot' && e.payload.direct_conversation_id === dm.conversation.id), 'DM recipient event');
  const sentinel = structuredClone(snapshot); sentinel.source.runId = 'routing-sentinel';
  await sdk.workflowRuns.publish({ ...target, snapshot: sentinel });
  await waitFor(() => outsiderEvents.some(e => e.type === 'workflow.snapshot' && e.payload.record.snapshot.source.runId === 'routing-sentinel'), 'outsider channel sentinel');
  assert.equal(outsiderEvents.some(e => e.type === 'workflow.snapshot' && e.payload.direct_conversation_id === dm.conversation.id), false);
  await publisher.stop(); publisher = undefined;
  assert.deepEqual((await sdk.workflowRuns.listChannel(channel.id)).runs.find(r => r.snapshot.source.runId === 'fixture-run').snapshot, snapshot);
  if (process.env.CLICKCLACK_ELECTRON_EXECUTABLE) {
    const { _electron: electron, expect } = await import(pathToFileURL(join(root, 'node_modules/@playwright/test/index.mjs')));
    const profile = join(temp, 'electron-profile'); mkdirSync(profile);
    writeFileSync(join(profile, 'desktop.json'), JSON.stringify({ serverUrl: endpoint, closeToTray: false, startAtLogin: false, window: { width: 1280, height: 900 } }));
    const bootstrap = join(temp, 'electron.cjs');
    writeFileSync(bootstrap, `const {app}=require('electron'); app.setPath('userData',${JSON.stringify(profile)}); app.setName('Disposable Workflow Bridge'); require(${JSON.stringify(join(root, 'apps/desktop/dist/main.cjs'))});`);
    electronApp = await electron.launch({ executablePath: process.env.CLICKCLACK_ELECTRON_EXECUTABLE, args: ['--ozone-platform=x11', bootstrap], env: { ...process.env, ELECTRON_FORCE_IS_PACKAGED: 'false' } });
    await waitFor(() => electronApp.windows().some(p => p.url().startsWith(endpoint)), 'Electron shell');
    const page = electronApp.windows().find(p => p.url().startsWith(endpoint));
    await page.goto(`${endpoint}/app/${workspace.route_id}/${channel.route_id}`);
    for (let reload = 0; reload < 2; reload++) {
      await expect(page.locator('.shell[data-app-ready="true"]')).toBeVisible();
      await page.getByRole('button', { name: 'Workflow run', exact: true }).click();
      await expect(page.getByRole('navigation', { name: 'Recorded runs' })).toBeVisible();
      const original = page.getByRole('button', { name: /durable-fixture · completed/ });
      await original.last().click();
      await expect(page.locator('.run-step')).toHaveCount(snapshot.steps.length);
      await expect(page.getByText('final.txt', { exact: true })).toBeVisible();
      if (!reload) await page.reload();
    }
    console.log(JSON.stringify({ fullPathElectron: 'passed', electronVersion: await electronApp.evaluate(() => process.versions.electron), clickclackCandidate: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim() }));
  }

  console.log(JSON.stringify({ result: 'passed', realHost: true, realApi: true, sqlite: true, attempts: snapshot.steps.length,
    revision: snapshot.source.revision, restartReplay: true, terminalRetention: true, files: snapshot.files.entries, dmScopeMembershipRecipients: true, midrunHigherStale: true, electron: Boolean(electronApp) }));
} catch (error) { console.error(serverLog.slice(-4000)); throw error; }
finally {
  await electronApp?.close(); for (const socket of sockets) socket.close();
  await watcher?.stop(); await publisher?.stop(); store?.close(); await client?.close(); await host?.stop();
  if (server && server.exitCode === null) { server.kill('SIGTERM'); await new Promise(r => server.once('exit', r)); }
  rmSync(temp, { recursive: true, force: true });
}
