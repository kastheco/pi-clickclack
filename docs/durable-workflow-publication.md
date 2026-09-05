# Durable workflow publication (KAS-769)

Implemented and tested, **not installed or live**. Independent review and parent-owned Electron full-path verification remain release gates.

## Interfaces and ownership

`DurableWorkflowPublisher` is process-owned, beside the unchanged ephemeral `WorkflowRunReporter`. `BridgeService` feeds both from the existing `WorkflowDecisionWatcher.onRun` at the bound conversation/session boundary; no second subscription and no new decision/control path. Existing exact-revision presentation claims, leases, owner chat replies and shutdown draining remain unchanged. Injected legacy test transports may omit `workflowRuns`; the production SDK supplies it.

Only a matching `pi-workflows.session-view.v1` event with a matching session and `pi-workflows.run-view.v1` run can discover work. Its original target is frozen. Scope includes a digest of API endpoint, authenticated producer, workspace and host database identity; discovery includes a digest of binding ID, project alias and project root. No absolute paths or tokens are persisted in these keys. A changed binding/session cannot retarget an older discovery. API publication rechecks current bot scopes and target access. Rejected/revoked access leaves retryable history, never deletes it.

The real host clears `queue.originSessionId` when releasing its reservation. Supervisor-approved refinement: a later `getRun` may have null origin **only for a previously persisted watch discovery**. A non-null different origin or different run is always rejected. Neither API history nor arbitrary run state discovers session ownership. Stop/null events do not remove discoveries; restart polls them even without a reopened Pi runtime.

`collectWorkflowSnapshot` uses typed SDK `WorkflowSnapshot` and host `WorkflowRunView.operatorArtifacts.changedFiles`. It reads `view.run.get` and `view.page(kind=steps)` only; no content hydration, graphSteps, prompts, output, raw state, Git scanning, or model file claims. Host step pages are centered/overlapping windows: the collector consumes a contiguous oldest-first missing suffix, verifies run/revision/total/cursor and bounds, and never mixes revisions. Revision conflict retries from a fresh view. At most 1000 attempts and 512 KiB are retained; `stepsComplete` is true only when all `stepTotal` attempts fit. Terminal host `display.reason` can contain arbitrary short node errors. Supervisor-approved privacy refinement: only five audited static generic host reason literals are retained; all other reasons become null, intentionally losing error detail rather than persisting paths/prompts/secrets. Legacy ephemeral reason forwarding is unchanged and remains a separate pre-existing privacy risk. Files are explicitly null when unavailable; typed file entries are allowlisted and validated, with host complete/truncated/baseline attribution preserved.

## Migration and replay

Bridge migration **4**, `durable-workflow-publication`, adds `workflow_publications` without altering existing rows or foreign keys. It stores safe discovery identities, latest absolute payload/digest/revision, acknowledged status, terminal flag and retry schedule. No binding-delete cascade. Existing migration runner applies DDL and receipt transactionally. Back up the bridge database before release; migration is additive, but old bridge binaries will not publish durable updates.

Discovery is synchronously committed before asynchronous host reads. Payload/digest/revision are committed before SDK publication. Delivery is marked only after an acknowledgment matches producer, workspace, exact target, provider, session and run, and is either a newer server revision or the same canonical digest. Equal local revision with different content is rejected. Unacknowledged payload is replayed byte-for-byte before acquiring newer state. Terminal acknowledged rows remain persisted and stop polling. Nonterminal discoveries continue polling through pointer clear, watcher stop and restart until terminal acknowledgment. History is never deleted on stop.

Production workflow API requests and individual host snapshot/page requests have a 15-second abort deadline without changing chat/decision transport. One serialized process loop checks up to 20 due jobs each second. Failures use persisted exponential backoff (1, 2, 4, 8, 16, 32, then 60 seconds); errors are logged without host/API payloads. Restart and reconnect need no event replay to recover existing discoveries. This is current absolute state per run, not an archive of every intermediate revision. Permanent invalid projections or denied access remain retryable and require operator remediation. No automatic retention/pruning was added.

## Isolated dependencies and verification

Use **Node 24.20.0**, pnpm 11.20.0. Embedded Pi remains **exactly 0.85.1**.

The exact host candidate is vendored as `vendor/osolmaz-pi-workflows-0.16.0-kas.769.1.tgz`, pinned through a `file:vendor/...` dependency and integrity lock. SHA-256: `e84b13df14537ccd3640dd8774799bb2c231542640b4072595f879414cab0f5a`; source commit `6cd502e0cb103afbc439a3c1ca0724d34e73dfa7`. No globally installed package was modified.

The normal SDK manifest/lock path remains `file:../clickclack/packages/sdk-ts`. Until the candidate is merged, explicitly stage its built SDK locally:

```sh
export PATH="$HOME/.nvm/versions/node/v24.20.0/bin:$PATH"
node --version # v24.20.0
pnpm install --frozen-lockfile
node scripts/setup-workflow-sdk.mjs ../clickclack.kas-769-workflow-activity/packages/sdk-ts
pnpm typecheck
pnpm build
pnpm test
node scripts/test-workflow-durable-integration.mjs
sha256sum vendor/osolmaz-pi-workflows-0.16.0-kas.769.1.tgz
git diff --check
```

**Confirmed SDK release blocker:** candidate8738142 emits extensionless `./generated/openapi` in its ESM declarations. NodeNext cannot resolve that import (skipLibCheck masks the import diagnostic but downstream Message types fail). The supervisor approved a test-only replacement in the copied local `dist/index.d.ts` to `./generated/openapi.js`. Setup applies exactly this replacement, never edits sibling source, manifest or lock. Parent must fix/rebuild the SDK and rerun bridge verification **without that declaration overlay** before release. The current tests are not evidence of an unmodified candidate SDK passing NodeNext.

The integration command stages Go API source into a temporary directory, builds there, creates disposable API/host/bridge SQLite databases, starts the actual packaged host, runs a 260-attempt repeated-node workflow plus trusted workspace preparation and final filesystem mutation, discovers through the real watcher, simulates a lost acknowledgment after the real API commits, restarts the bridge outbox without a watcher, publishes through the real SDK/API, and checks terminal history, full pagination, file evidence, privacy, idempotence/conflict and reload. It uses no models, live services, installed app profile or sibling edits. `CLICKCLACK_CANDIDATE_ROOT` can override the source fixture root. Electron remains parent-owned, not substituted with browser testing.

## Release sequence / limitations

1. Review bridge/host/API candidates. Fix the SDK declaration blocker; merge ClickClack, rebuild SDK, refresh the normal bridge file dependency/lock (parent release step), then rerun all gates without overlay.
2. Parent runs actual host → bridge → API → Electron full-path acceptance. Current harness is real host/API/storage, not Electron/live proof.
3. Back up bridge state and the host DB/WAL with writers stopped. The host candidate has its own additive schema migration that **old host binaries cannot open**; rollback requires restoring its consistent pre-migration backup with old binaries.
4. Deploy ClickClack API first, then coordinated host SDK/bridge cutover; preserve Pi 0.85.1. Verify scopes (`agent_activity:write`, `messages:write`, DM `dms:write`), server migrations/health, restart replay and Electron retained history before saying ready for verification.

Unknown runs never observed by the authorized watcher are intentionally not discovered by scanning the host or API. A host that permanently removes a discovered run before collection leaves it retryable, not fabricated as completed. Persistent rows grow with run count. Scope changes intentionally isolate old replay; database/project moves require an explicit migration rather than silently retargeting history.
