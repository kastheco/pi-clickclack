# Package customizations and update checks

last updated: 2026-10-13.

This is the running record of local package changes made during the bridge recovery. It isn't a complete inventory of every historical customization on this machine. Update this file whenever a package is patched, rebuilt, pinned, restored, or returned to upstream. Mirror it to the [Notion package-customization ledger](https://app.notion.com/p/Package-customizations-and-update-checks-3d2b3a0a9c1981398003f31d42068ecf) under the pi-clickclack project page.

## Before updating

Don't run a blanket package update until the installed local patches below have been checked against the proposed versions. Package replacement can remove these fixes even when the version number appears unchanged.

1. Read the affected entry and upstream changes. Confirm whether upstream contains the fix.
2. Keep the current package and rollback artifacts. Record the proposed version separately from the installed version.
3. Test the candidate with the bridge's pinned Bun `packageManager` and embedded Omp SDK dependency. Do not infer either from a global CLI.
4. Run the committed offline suite, installed-injector integration, and explicitly authorized live smoke in [smoke-suite.md](smoke-suite.md). A load error blocks a full-health claim even if the model answers.
5. Coordinate any bridge restart. Never rewrite or delete existing conversation history to make a consistency check pass.
6. Update this ledger and its Notion mirror after verification. Record the upstream release/commit before marking a patch retired.

## Current Omp checkout pins

- `package.json` pins `@oh-my-pi/pi-coding-agent@18.10.3` and `bun@1.4.2`.
- `patches/@oh-my-pi%2Fpi-coding-agent@18.10.3.patch` preserves the five-minute `session_before_compact` handler budget. upstream 18.10.3 still uses the generic 30-second deadline. `patchedDependencies` in `package.json` and `bun.lock` applies the patch during installation.

## Historical Pi recovery ledger (2026-09-05; not current Omp install state)

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
### omp canary

the checkout pins Bun 1.4.2 and `@oh-my-pi/pi-coding-agent@18.10.3` for the candidate image. the deployed bots remain on 18.8.7 until the separately verified rollout. `CLICKCLACK_OMP_EXTENSION_PATHS` is a JSON array of absolute, read-only extension paths. the bridge passes these paths to OMP while disabling ambient extension discovery. the shared extension set contains `context-mode`, `pi-lcm`, and `@luxusai/pi-hindsight`.

Omp path-related environment variables are `PI_CODING_AGENT_DIR` (agent/config directory), `PI_CONFIG_FILES` (optional settings-file overlays), and `PI_WORKSPACE_DIR` (workspace root). The bridge aligns `PI_CODING_AGENT_DIR` with `CLICKCLACK_PI_AGENT_DIR`; it does not allow omp to fall back to the real user's `~/.omp` or `~/.pi` directories.

Hindsight is configured in `settings.json` under the agent directory. The exact keys are `memory.backend: "hindsight"`, `hindsight.apiUrl` (for example `http://127.0.0.1:8888`), `hindsight.bankId` (an isolated bot bank), `hindsight.autoRecall` (the boolean recall mode), and `hindsight.scoping` (`global`, `per-project`, or `per-project-tagged`). Keep canary banks separate from legacy `kas-engineering` and `pi-global` banks. The SDK session options that prevent writable discovery are `disableExtensionDiscovery: true` and `additionalExtensionPaths: [...]`; the latter contains `CLICKCLACK_OMP_EXTENSION_PATHS`.

### 2026-09-29 OMP upgrade

- upgraded all five bots from OMP 18.3.5 to 18.4.4 using `localhost/omp-clickclack:upgrade-20260929-omp18.4.4`. only installed Quadlet image lines changed. the previous image is `localhost/omp-clickclack:fast-toggle-20260929-omp18.3.5`.
- carried the five-minute compaction-hook patch and verified its slow-hook regression in the image.
- corrected the shared auth broker command to invoke the shell launcher directly.
- updated the live smoke for resolved extension entrypoints and OMP's `i` tool-intent field, while retaining exact-path, single-read restrictions.
- all 350 tests and typecheck passed. each live bot completed an authenticated model turn and read-tool continuation with the shared extensions loaded. the maintained live smoke also passed in the clickclack container. a real pi-lcm compaction wasn't forced.
- the OMP upgrade initially preserved `openai-codex/gpt-6-astra`, `medium` thinking, the priority tier, and unset model roles. the model changes below were separately requested afterward.

### 2026-09-29 bot model settings

- changed all five bot defaults to `openai-codex/gpt-6.1-sol`, retaining `medium` reasoning and the OpenAI priority tier.
- set architect (`plan`) to `openai-codex/gpt-6-astra:high`, advisor to `anthropic/claude-opus-5-5:medium`, fast (`smol`) to `openai-codex/gpt-6-luna:medium`, and thinking (`slow`) to `anthropic/claude-opus-5-5:high` in each bot's `modelRoles`. the default role is also explicitly `openai-codex/gpt-6.1-sol:medium`.
- restarted all five bots. isolated live sessions verified the complete role map in each bot and authenticated default-model replies from each. all five model/reasoning combinations also completed authenticated replies in the clickclack container.

### 2026-10-09 OMP candidate upgrade

these checks are the historical candidate record carried from the host checkout. all five bots subsequently deployed this image, as confirmed by the host baseline on 2026-10-12. they aren't verification of the 18.10.3 candidate.

- upgraded the checkout pin and lock from 18.4.4 to 18.8.7, preserving the existing dirty work without pulls or commits. upstream 18.8.7 still applies the generic 30-second compaction-hook deadline, so the five-minute patch remained under `patches/@oh-my-pi%2Fpi-coding-agent@18.8.7.patch`. rebased its hunk to line 158 of the published package. Bun accepts the old offset but produces invalid runtime source. no bridge compatibility changes were needed.
- built the rootless candidate `localhost/omp-clickclack:upgrade-20261009-omp18.8.7` with the documented `clickclack-sdk=../clickclack/packages/sdk-ts` context, from the explicitly requested dirty checkout. image ID: `8554afadc1430c86e61cf021bbe51a3eb91c6adf7753203f97602e20e02075af`.
- checkout typecheck and build passed. all 352 repository tests passed, including the slow compaction-hook regression. the separate offline smoke suite passed all 49 tests. the same regression passed inside the candidate (1 pass, exit 0). Bun also emitted `Cannot read file "/opt/omp-clickclack/": EACCES` during test discovery under keep-id, so that image test isn't claimed warning-free.
- candidate smoke ran read-only, keep-id, capability-free, and network-disabled, with only disposable writable tmpfs and no live credentials. the actual entrypoint imported successfully and rejected missing configuration as expected. real SDK construction, extension initialization, disposal, and the bridge runtime boundary passed. all three configured extensions loaded with no load/runtime errors, alongside OMP's built-in inline extension. the SDK reported 18.8.7 and a 300,000 ms compaction-hook budget. no model turns, ClickClack messages, or live-session continuations ran.
- installed injector integration was attempted against the host's installed policy sources but failed closed on an unsupported `node:crypto` import in the Hindsight recall module. the adapter and installed policies weren't changed. no installed-policy lineage pass is claimed. guard SHA-256: `18f216b1910823962a656f898fcc105d807e3864319d2dd3b05dadb62335edb0`.
- no live service restart or installed Quadlet change was performed during those candidate checks. the live cutover was separate.
