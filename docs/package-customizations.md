# Package customizations and update checks

Last updated: 2026-09-05.

This is the running record of local package changes made during the bridge recovery. It isn't a complete inventory of every historical customization on this machine. Update this file whenever a package is patched, rebuilt, pinned, restored, or returned to upstream. Mirror it to the [Notion package-customization ledger](https://app.notion.com/p/Package-customizations-and-update-checks-3d2b3a0a9c1981398003f31d42068ecf) under the pi-clickclack project page.

## Before updating

Don't run a blanket package update until the installed local patches below have been checked against the proposed versions. Package replacement can remove these fixes even when the version number appears unchanged.

1. Read the affected entry and upstream changes. Confirm whether upstream contains the fix.
2. Keep the current package and rollback artifacts. Record the proposed version separately from the installed version.
3. Test the candidate with the bridge's exact Node and embedded Pi versions. Don't infer these from whichever `pi` is first on PATH.
4. Run the committed offline suite, installed-injector integration, and explicitly authorized live smoke in [smoke-suite.md](smoke-suite.md). A load error blocks a full-health claim even if the model answers.
5. Coordinate any bridge restart. Never rewrite or delete existing conversation history to make a consistency check pass.
6. Update this ledger and its Notion mirror after verification. Record the upstream release/commit before marking a patch retired.

## Current ledger

| Package or component | Installed state | Local change | Update risk and retirement condition |
| --- | --- | --- | --- |
| `context-mode` | `1.0.169` with a local runtime patch | Context injection is a hidden persistent `before_agent_start` message instead of a disappearing `context` callback. Source commit `7a3cd68`. | An update can restore non-append-only history. Retire only after the candidate upstream version passes the actual-injector and continuation checks. |
| `@luxusai/pi-hindsight` | `0.12.0` with a local runtime patch | Recall becomes a persistent per-prompt message. The injection path no longer reuses its cross-session-prone result cache. Source commit `064cae7`. | Both legacy `injectionPosition` values now append durably. New recall per prompt can add latency, and history grows until compaction. Preserve memory scope, enablement and error behavior when updating. |
| `pi-lcm` → `better-sqlite3` | Local `pi-lcm 0.1.3` package with exact dependency `13.0.3`, installed and verified on Node `24.20.0` | Commit `90698eb` replaces legacy Node ObjectWrap with the dependency's published N-API binding. Native regression and strict live read/continuation smoke pass with normal exit. No LCM lifecycle redesign. | Updating upstream pi-lcm can restore its old `^11.9.1` dependency and the VM/GC crash. Preserve the exact pin until an upstream release passes the committed native tests. Retain database backups before major SQLite changes. |
| `pi-clickclack` → `@earendil-works/pi-coding-agent` | Exactly `0.85.1` in package and lockfile, deployed | Pin commit `c3c6348`. Lockfile includes narrow release-age exclusions for six `@earendil-works` packages at `0.85.1`. | This is the embedded SDK, not global Pi. Validate the extension loader as well as the bridge's unit tests before changing it. |
| `@monotykamary/pi-better-openai` | `0.1.37` with local compatibility patch installed; fresh SDK extension load passes | Commit `171c36d` uses explicitly aliased `/compat` and `/providers/all` exports while preserving the Codex provider. | Valid deep imports were incorrectly rewritten beneath `dist/compat.js` by the SDK loader. Keep the adaptation until the upstream package/loader combination passes the committed loader test. No SDK or provider guard patch. |
| `pi-background-tasks` attribution guard | Unchanged during this repair | No guard, signature, or lineage-diagnostic bypass. | Preserve the guard. The repaired injectors must conform to it, not the reverse. |

The context-mode and Hindsight installed package versions were not incremented by these local patches. Use the source commits and backup manifest, not package version alone, to identify the customized installation.

## Evidence and rollback

Backup root on athena:

`/home/kas/.local/share/pi-lineage-fix/20260905T161418Z`

It contains the previous context-mode entrypoint, previous Hindsight extension tree, bridge package/lock/workspace files and prior commit, an integrity-checked bridge state backup, the failed-session copy, candidate archives, installed hashes, and the old Node 22 LCM SQLite binary.

The two source commits were made in isolated clones. Durable copies outside `/tmp` are:

- `context-mode-fix.bundle` and `context-mode-fix.patch`
- `pi-hindsight-fix.bundle` and `pi-hindsight-fix.patch`

Bundles contain the fix commit relative to its release parent, so restore them into a repository containing that upstream release. Don't rely on temporary clone paths surviving.

The later LCM cutover also preserves the complete prior package in `pi-lcm-before13`, integrity-checked databases in `lcm-db-backups`, and the exact staged package/lock in `lcm13-stage`. Installed dependency `13.0.3` uses SQLite `3.53.4`; its Linux x64 N-API prebuild SHA256 is `6fd4292c6c5f352436cd85c9e1cb286978efa43c20ae350973f83414ced9991d`.

Restoring the Node 22 binary into Node 24 recreates the ABI failure. Restoring 11.10.0 on Node 24 recreates the demonstrated native crash even after rebuilding. Backward database compatibility after real 13.x writes hasn't been established. A package rollback isn't permission to restore old conversation data or discard newer turns.

## Verification status

- Bridge pin: typecheck, build and original 125 tests passed with Node `24.20.0` and embedded Pi `0.85.1`.
- Injector sources: 68 context-mode tests and 598 Hindsight tests passed. Independent review found no concrete source blockers, with offline lifecycle coverage limits recorded in the incident report.
- Installed injector integration: passed with unchanged attribution guard and mocked transport.
- Initial live read/continuation probe: passed, but it did not check all extension load errors.
- Committed reusable suite: `573d7c7`; pre-execution tool guard `acdfd0d`. The final Node 24.20.0 offline run passed 162 tests. After the LCM dependency cutover, strict live smoke returned `BRIDGE_SMOKE_PASS` with Pi `0.85.1`, Node `24.20.0`, empty extension-load diagnostics and normal exit 0. This verifies isolated read-tool continuation and reported hook/load errors, not every extension feature.
- Pi LCM native regression: 11.10.0 failed both VM/GC cases across ten runs; 13.0.3 passed all cases across ten runs. Temporary baseline-created LCM databases passed forward read/write, integrity and foreign-key checks. All five native cases passed again against the staged and installed binary. The live bridge was restarted only after normal smoke success and is active.
- OpenClaw's separate `lossless-claw` plugin was not changed by this repair.

## Runtime alignment

Nvm default now points to Node `24.20.0`. Existing shells don't change automatically; run `nvm use 24.20.0` there before launching Pi or rebuilding these shared native dependencies. The global Pi under that Node installation reported `0.84.4`; the bridge independently resolves its pinned `0.85.1`. No global Pi upgrade is claimed.

## Change log

### 2026-09-05

- Installed the two persistent-injection fixes after offline testing and independent review.
- Deployed embedded Pi `0.85.1` and preserved the failed 772 transcript. The affected binding was archived through the bridge state API so the next invocation starts fresh. Kas also confirmed `/new` recovered `#utmco`.
- Rebuilt Pi LCM's SQLite module for Node 24 and changed the future-shell default with approval.
- Committed the reusable smoke suite. Its stricter checks exposed the separate `pi-better-openai` compatibility problem.
- Published and re-fetched the Notion ledger under pi-clickclack. Package entries and the reused project artwork are present. This file is its version-controlled source.
- Installed `pi-better-openai` compatibility commit `171c36d` after source-fidelity checks, a red/green actual Pi 0.85.1 loader test, and package checks. Its baseline suite required local-only provisioning of a missing dev dependency, not a tracked dependency upgrade. The previous `codex-models.ts` and installed hash are in the backup root.
- Installed the LCM dependency fix from commit `90698eb`. Backed up live LCM databases with integrity checks, verified the installed native regression, passed the repo-owned live smoke with normal exit 0, then restarted `pi-clickclack.service` successfully. No OpenClaw restart.
