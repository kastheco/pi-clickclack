# Omp bridge smoke suite

The checkout pins `@oh-my-pi/pi-coding-agent` **18.3.5** and Bun **1.4.2** in `package.json`; the smoke assertion also checks the installed SDK metadata against the exact dependency pin. Use this checkout's dependencies, not a global `pi`/`omp`. Installation still needs `file:../clickclack/packages/sdk-ts`. No command below installs packages or restarts a bridge.

## Offline CI

```sh
bun run typecheck
bun run test:smoke
# The complete repository suite is separate:
bun run test
```

`test:smoke` runs all `scripts/smoke/*.test.mjs` (currently 49 cases), including persona/install-service CLI checks, transcript assertions, Omp `SessionManager` persistence and compaction, pre-execution Agent tool-call gating, and opt-in CLI permission rejection. It needs no credentials, network, installed extensions, or live conversations. Fixtures use OS temporary directories and clean up in `finally`. The synthetic injector test checks SDK persistence, **not** installed extension policy. Tests reject extra/failed reads, wrong path or version, truncated/missing Omp read metadata, an unpaired tool call, abort/error, invalid timeouts, and blocked/changed tool arguments before execution.

## Opt-in installed injector/guard lineage integration

Only invoke for reviewed, locally installed policy sources. This command executes TypeScript policy extracted from the context-mode entrypoint and Hindsight lifecycle module in VM modules with explicit IO doubles; VM evaluation is **not** a security sandbox. The optional guard source is checked against a separately reviewed SHA-256 and evaluated unchanged. This integration is version-sensitive: legacy packages importing `@earendil-works/*` do not meet the Omp adapter's `@oh-my-pi/pi-coding-agent` import contract, so an unsupported import must fail instead of silently skipping a check. It does not bootstrap extensions or contact a model/recall service.

```sh
bun --experimental-vm-modules scripts/smoke/integration.mjs \
  --allow-installed-code \
  --context-extension "$CONTEXT_MODE_PI_ENTRY" \
  --hindsight-root "$HINDSIGHT_PACKAGE_ROOT" \
  --guard "$BACKGROUND_TASKS_ATTRIBUTION_SOURCE" \
  --guard-sha256 "$REVIEWED_SHA256" \
  --timeout-ms 120000
```

The source paths are explicit absolute paths; for the legacy layout the context-mode entrypoint is often `build/adapters/pi/extension.js`, Hindsight root is the `@luxusai/pi-hindsight` package directory, and guard is `src/core/anthropic-attribution.ts` in pi-background-tasks. Review source layout and guard hash before use. The check verifies durable injections across turns, retry, disk reopen, branch and compaction; altered history must fail before the mocked transport. Success emits `INTEGRATION_PASS` with SDK/Bun version and guard hash. No such installed-policy run is implied by an offline suite pass.

## Opt-in live read/continuation probe

**Only run after explicit owner permission** for the exact configured project and billable provider IO. The command loads `src/pi-runtime.ts` through Bun, uses the actual `createEmbeddedPiRuntime` boundary, and opens a newly created temporary probe session for the project cwd. It does not start the ClickClack service or bind/replay a user's conversation. Configure `CLICKCLACK_URL`, `CLICKCLACK_WORKSPACE_ID`, `CLICKCLACK_BOT_TOKEN`, `CLICKCLACK_OWNER_IDS`, `CLICKCLACK_PI_PROJECTS`, `CLICKCLACK_PI_MODEL`, `CLICKCLACK_PI_AGENT_DIR`, and any optional `CLICKCLACK_OMP_EXTENSION_PATHS` as required by `src/config.ts`. Avoid a real user's agent directory when the selected extensions or settings could write there.

```sh
bun --env-file-if-exists=.env scripts/smoke/live.mjs \
  --allow-live --project YOUR_CONFIGURED_ALIAS --timeout-ms 120000
```

The Omp 18.3.5 `Agent.beforeToolCall` hook blocks every call except a single exact-path `read` of this checkout's `package.json`; it preserves the installed extension hook and rejects both in-place and returned argument revisions. The transcript must contain one successful matching result and a later normal final answer containing only the exact pinned SDK version. The probe compares configured extension paths to loaded paths and records hook errors after session initialization. Omp's bridge boundary returns a session, not the SDK `LoadExtensionsResult`, so this probe cannot claim a full extension-load diagnostic audit or full extension health. `BRIDGE_SMOKE_PASS` means only this scoped continuation completed after disposal and cleanup.

Installed extension code, model/provider auth, provider requests, startup/shutdown hooks, and their side effects are **not sandboxed** by the read-tool gate. The command can expose project context to the provider. It has a bounded abort/dispose timeout and a hard nonzero exit deadline; a hard exit may leave extension-owned handles or probe data. Do not infer success from a model reply alone. This command is not part of CI and was not run as part of this offline port.
