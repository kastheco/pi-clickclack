# Durable workflow publication (KAS-769)

Implemented and tested, **not installed or live**. Disposable full-path Electron verification passed; parent deployment and live verification remain release gates.

## Interfaces and ownership

`DurableWorkflowPublisher` is process-owned, beside the unchanged ephemeral `WorkflowRunReporter`. `BridgeService` feeds both from the existing `WorkflowDecisionWatcher.onRun` at the bound conversation/session boundary; no second subscription and no new decision/control path. Existing exact-revision presentation claims, leases, owner chat replies and shutdown draining remain unchanged. Injected legacy test transports may omit `workflowRuns`; the production SDK supplies it.

Only a matching `pi-workflows.session-view.v1` event with a matching session and `pi-workflows.run-view.v1` run can discover work. Its original target is frozen. Scope includes a digest of API endpoint, authenticated producer, workspace and host database identity; discovery includes a digest of binding ID, project alias and project root. No absolute paths or tokens are persisted in these keys. A changed binding/session cannot retarget an older discovery. API publication rechecks current bot scopes and target access. Rejected/revoked access leaves retryable history, never deletes it.

The real host clears `queue.originSessionId` when releasing its reservation. Supervisor-approved refinement: a later `getRun` may have null origin **only for a previously persisted watch discovery**. A non-null different origin or different run is always rejected. Neither API history nor arbitrary run state discovers session ownership. Stop/null events do not remove discoveries; restart polls them even without a reopened Pi runtime.

`collectWorkflowSnapshot` uses typed SDK `WorkflowSnapshot` and host `WorkflowRunView.operatorArtifacts.changedFiles`. It reads `view.run.get` and `view.page(kind=steps)` only; no content hydration, graphSteps, prompts, output, raw state, Git scanning, or model file claims. Host step pages are centered/overlapping windows: the collector consumes a contiguous oldest-first missing suffix, verifies run/revision/total/cursor and bounds, and never mixes revisions. Revision conflict retries from a fresh view. At most 1000 attempts and 512 KiB are retained; `stepsComplete` is true only when all `stepTotal` attempts fit. Terminal host `display.reason` can contain arbitrary short node errors. Supervisor-approved privacy refinement: only five audited static generic host reason literals are retained; all other reasons become null, intentionally losing error detail rather than persisting paths/prompts/secrets. Legacy ephemeral reason forwarding is unchanged and remains a separate pre-existing privacy risk. Files are explicitly null when unavailable or file metadata alone exceeds the byte cap; byte trimming measures each attempt once and keeps an oldest-first prefix. Identifiers must be trim-nonblank and timestamps RFC3339 with valid calendar dates. Typed file entries are allowlisted and validated, with host complete/truncated/baseline attribution preserved.

## Migration and replay

Bridge migration **4**, `durable-workflow-publication`, adds `workflow_publications` without altering existing rows or foreign keys. It stores safe discovery identities, latest absolute payload/digest/revision, acknowledged status, terminal flag and retry schedule. No binding-delete cascade. Existing migration runner applies DDL and receipt transactionally. Back up the bridge database before release; migration is additive, but old bridge binaries will not publish durable updates.

Discovery is synchronously committed before asynchronous host reads. Payload/digest/revision are committed before SDK publication. Delivery is marked only after an acknowledgment matches producer, workspace, exact target, provider, session and run, and is either a newer server revision or the same canonical digest. Delivered known revisions validate run/session identity and revision before skipping pagination; regressed revisions reject. Frozen outbox payload consistency is still checked on every replay. Unacknowledged payload is replayed byte-for-byte before acquiring newer state. Terminal acknowledged rows remain persisted and stop polling. Nonterminal discoveries continue polling through pointer clear, watcher stop and restart until terminal acknowledgment. History is never deleted on stop.

Production workflow API requests and individual host snapshot/page requests have a 15-second abort deadline without changing chat/decision transport. One serialized process loop checks up to 20 due jobs each second. Failures use persisted exponential backoff (1, 2, 4, 8, 16, 32, then 60 seconds); errors are logged with safe session/run identifiers and attempt count, without host/API payloads. Restart and reconnect need no event replay to recover existing discoveries. This is current absolute state per run, not an archive of every intermediate revision. Permanent invalid projections or denied access remain retryable and require operator remediation. No automatic retention/pruning was added. Due persisted nonterminal/undelivered rows call ensureAvailable and may autostart the detached host even without an active Pi runtime or binding. Startup constructs the client to obtain its stable database identity; a missing identity fails closed (tests must explicitly inject a stable identity).

## Isolated dependencies and verification

Use **Node 24.20.0**, pnpm 11.20.0. Embedded Pi remains **exactly 0.85.1**.

The exact host candidate is vendored as `vendor/osolmaz-pi-workflows-0.16.0-kas.769.2.tgz`, pinned through a `file:vendor/...` dependency and integrity lock. SHA-256: `6af9d764e38f79b776ff3c6a6f631f527ba795fd097ac3250dc013717ceceb6d`. No globally installed package was modified.

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
sha256sum vendor/osolmaz-pi-workflows-0.16.0-kas.769.2.tgz
git diff --check
```

Candidate SDK source fix `e71e77f7` emits NodeNext-compatible declarations. Setup copies its complete built dist byte-for-byte, with **no declaration or import rewrite**. Clean candidate dist comparison and typecheck pass. The normal final dependency remains `file:../clickclack/packages/sdk-ts`; final main merge, SDK rebuild and normal file-dependency lock refresh remain parent release steps.

The integration command stages Go API source into a temporary directory, builds there, creates disposable API/host/bridge SQLite databases, starts the actual packaged host, runs a 260-attempt repeated-node workflow plus trusted workspace preparation and final filesystem mutation, discovers through the real watcher, simulates a lost acknowledgment after the real API commits, restarts the bridge outbox without a watcher, publishes through the real SDK/API, and checks terminal history, full pagination, file evidence, privacy, idempotence/conflict and reload. It uses no models, live services, installed app profile or sibling edits. `CLICKCLACK_CANDIDATE_ROOT` can override the source fixture root. The optional `CLICKCLACK_ELECTRON_EXECUTABLE=/usr/bin/electron` gate stages built worktree web assets and opens the actual worktree desktop main/preload with disposable userData; it checks the host-produced persisted attempts/files before and after reload, never Chrome or the live profile. The harness also verifies midrun higher/stale revisions and DM scope/membership/server-derived websocket recipients.

## Release sequence / limitations

1. Review bridge/host/API candidates. Merge ClickClack, rebuild SDK, refresh the normal bridge file dependency/lock (parent release step), then rerun all gates without overlay.
2. Disposable actual host → bridge → API → Electron passed on ClickClack `b01b4f1e680bec4d913cc8b140a5ead1df67ed0c`, Electron **43.6.0**: 266 attempts, revision 540, final host file evidence and reload. This is isolated full-path proof, not live deployment proof. Rerun against final merged artifacts before cutover.
3. Back up bridge state and the host DB/WAL with writers stopped. The host candidate has its own additive schema migration that **old host binaries cannot open**; rollback requires restoring its consistent pre-migration backup with old binaries.
4. Deploy ClickClack API first, then coordinated host SDK/bridge cutover; preserve Pi 0.85.1. Verify scopes (`agent_activity:write`, `messages:write`, DM `dms:write`), server migrations/health, restart replay and Electron retained history before saying ready for verification.

Unknown runs never observed by the authorized watcher are intentionally not discovered by scanning the host or API. A host that permanently removes a discovered run before collection leaves it retryable, not fabricated as completed. Persistent rows grow with run count. Scope changes intentionally isolate old replay; database/project moves require an explicit migration rather than silently retargeting history.

## Follow-up verification evidence

Against host `0.16.0-kas.769.2` and clean SDK built from source containing `e71e77f7`:

- `pnpm install --frozen-lockfile`, clean SDK setup and recursive dist comparison: pass; no import/declaration overlay. Only host tarball/integrity changed in the dependency lock.
- `pnpm typecheck`, `pnpm build`, `pnpm test`: pass, **181 tests**. Added unchanged-revision paging, invalid timestamps/identifiers/pages/totals, multibyte 512 KiB trimming/file fallback, 403 persisted survival, original frozen target/rebind, resumed terminal, missing host identity and SQLite observe-fault/ephemeral regression coverage.
- `CLICKCLACK_ELECTRON_EXECUTABLE=/usr/bin/electron node scripts/test-workflow-durable-integration.mjs`: pass against frozen ClickClack `b01b4f1e680bec4d913cc8b140a5ead1df67ed0c`, Electron **43.6.0**, isolated profile. Real host produced 266 attempts/revision 540; final.txt host evidence and attempts persisted through Electron reload. Running→terminal replacement, stale/idempotent replay, lost acknowledgment/restart, DM HTTP 403 scope/membership and member-vs-outsider websocket routing all passed.
- `sha256sum vendor/osolmaz-pi-workflows-0.16.0-kas.769.2.tgz` matches the pin above; `git diff --check` passes. Existing `workflow-decisions.ts` and `workflow-run-publisher.ts` have no changes in this follow-up.

Initial harness development exposed fixture-only setup errors (a release marker dirtied the workspace baseline; `bot:write` implicitly grants DM scope). The gate now removes its marker before workspace preparation, and the missing-DM-scope fixture requests explicit `messages:write`/`agent_activity:write`/`profile:read`. Final checks above were rerun after these corrections. No installed service, live database/profile, global package, or sibling source was modified.
