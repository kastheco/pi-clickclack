# Pi bridge smoke and lineage regression suite

Requires the repository's installed dependencies and Node >=24 (validated with
24.20.0). No globally installed Pi SDK is used. The expected SDK version comes
from the exact dependency in this repository's `package.json`, and is checked
against the installed package metadata. Run from this checkout, not a live main
checkout. None of these commands installs packages or restarts the bridge.

## Standard CI: offline, deterministic

```sh
pnpm typecheck
pnpm build
pnpm test
# Only the new smoke regressions (after build):
pnpm test:smoke
```

`pnpm test` retains the existing compiled tests and adds
`scripts/smoke/offline.test.mjs`. No credentials, network, installed extensions,
local extension paths, temporary scripts, or clones are required. The existing
`file:../clickclack/packages/sdk-ts` dependency still needs to be available when
installing the repository; this suite adds no such dependency.

Coverage:
- Real SDK `SessionManager` durable custom messages, prefix retention through tool
  turns and retries, disk reopen, retained-leaf fork, compaction/reopen, and branch
  before injections. Synthetic injectors deliberately test the SDK contract only.
- Live transcript assertions reject missing/failed tools, mismatched IDs, wrong
  paths, extra tools/results, reversed ordering, aborted/error responses, partial
  version matches, and non-final responses.
- Missing/load/initialization/hook diagnostics, timeout rejection and abort,
  opt-in CLI nonzero exits without permission, invalid injector returns, and a
  false transport sentinel without a fetch.

Session fixtures are created with `mkdtemp` under the OS temporary directory and
removed in `finally`. Tests do not discover user resources or open user sessions.

## Opt-in installed injector/guard integration (no live model)

Explicit paths avoid assumptions about npm/pnpm/global Pi layouts. Locate the
installed context-mode Pi entrypoint (normally `build/adapters/pi/extension.js`),
Hindsight package root (`@luxusai/pi-hindsight`), and pi-background-tasks attribution
source (`src/core/anthropic-attribution.ts`) using your package manager's install
listing or Pi settings. Pass their absolute paths; a source context-mode
`src/adapters/pi/extension.ts` also works. Do not point at the old temporary clones.

```sh
pnpm test:injector-integration \
  --allow-installed-code \
  --context-extension "$CONTEXT_MODE_PI_ENTRY" \
  --hindsight-root "$HINDSIGHT_PACKAGE_ROOT" \
  --guard "$BACKGROUND_TASKS_ATTRIBUTION_SOURCE" \
  --guard-sha256 "$REVIEWED_GUARD_SHA256" \
  --timeout-ms 120000
```

`--guard-sha256` is a required reviewed baseline, not a value silently calculated
by the test. `sha256sum "$BACKGROUND_TASKS_ATTRIBUTION_SOURCE"` can inspect it;
review any change before accepting a new baseline. The suite reads and verifies
that source before and after execution, never patches the guard. A pre-fix
injector, unsupported source shape/import, wrong hash, invalid transport result,
or timeout fails nonzero. Unknown/missing options also fail. Success emits
`INTEGRATION_PASS` with SDK/Node metadata, guard hash, scope, and fetch-call count.

### Deliberate integration seam

The packages do not expose a common public factory that injects all DB, bootstrap,
recall, and configuration IO. `injector-adapters.mjs` therefore contains a small,
explicit version-sensitive adapter: TypeScript AST extraction of context-mode's
actual `pi.on` callbacks, and VM module linking of Hindsight's actual registration
and recall policy. It does **not** copy/reimplement those hook bodies. Dependencies
are explicit IO doubles; unsupported imports and duplicate/missing hooks fail
closed. This is adapted from the incident regressions, not dependent on them.
When packages restructure these seams, review/update this file rather than skip
the checks. Node's VM modules flag is needed only for this opt-in command.

Both legacy Hindsight positions, per-prompt/equal-length-session fresh recall,
disable gates and best-effort recall failures are checked. Real SDK persistence
and the unchanged guard then check continuations, retry, next prompt, reload,
fork, and compaction. Removing **either** previous injection must fail with the
append-only error before transport. Valid continuations must reach exactly one
mocked `fetch`, which throws `OFFLINE_TRANSPORT_BOUNDARY`. Guard filesystem IO is
blocked (disable attribution audit logging in the command environment).

This is **policy + persistence + guard** integration, not extension initialization
health or a full AgentSession/model loop. Context DB/resume/role filtering and real
recall service health remain the packages' own test responsibilities. VM evaluation
is not a security sandbox: `--allow-installed-code` means these local packages are
trusted. No extension bootstrap, real recall, credentials, or provider request is
needed. Temporary files are test session data only.

## Opt-in live bridge read/continuation smoke

Only run with the owner's permission for the selected configured project and a
billable provider request. This command is **not part of CI** and was not run as
part of implementing this suite.

Build first. Supply the normal bridge environment (see `src/config.ts`), including
`CLICKCLACK_URL`, `CLICKCLACK_WORKSPACE_ID`, `CLICKCLACK_BOT_TOKEN`,
`CLICKCLACK_OWNER_IDS`, `CLICKCLACK_PI_PROJECTS`, `CLICKCLACK_PI_MODEL`, and optionally
`CLICKCLACK_PI_AGENT_DIR` / `CLICKCLACK_PI_THINKING_LEVEL`. The ClickClack values are
required by the shared config validator but no ClickClack client/service is
created. Credentials come from the selected agent directory's `auth.json`, provider
environment variables, or the configured provider's normal auth mechanism. The
configured model and its installed extensions/native dependencies must work under
the Node version used for this command. The command does not install or repair them.

```sh
# Export the required environment first:
pnpm test:live-smoke --allow-live --project YOUR_CONFIGURED_ALIAS --timeout-ms 120000
# Or use Node's env-file support (same CLI):
node --env-file=/absolute/path/to/bridge.env scripts/smoke/live.mjs \
  --allow-live --project YOUR_CONFIGURED_ALIAS
```

This calls the real `createEmbeddedPiRuntime` with a unique SDK-generated header
in a temporary probe session, pinned to the configured project's cwd. It does not
start the bridge service, bind/replace ClickClack conversations, continue the most
recent session, recover old sessions, or run KAS-772. Initially only `read` is
advertised; startup hooks may activate additional tools (including context-mode).
A smoke-only public `Agent.beforeToolCall` gate permits at most one `read`, with
only the exact checkout `package.json` path argument. It blocks all other calls
before tool execution, preserves the SDK extension hook for the permitted call,
and rechecks arguments after that hook in case extensions mutate them. This is
the documented Pi 0.85.1 agent-core hook (README “Agent Options” and “Tool Execution”;
`dist/agent.d.ts`, `dist/types.d.ts`); `dist/agent-loop.js` checks its block result
before `execute()`. No production runtime or installed extension is patched.
The prompt requests that file, resolved from the script location, then the exact
pinned SDK version. Assertions still reject extra calls, even blocked ones, and require
one matching successful read and a later normally completed assistant response.
The expected version is not included in the prompt.

Diagnostics are printed to stderr: service diagnostics, extension load errors,
loaded extension paths, and lifecycle hook errors. Initialization/load/hook errors
fail, even when the model could otherwise continue. Warnings are reported but do
not fail. Extensions bind in print mode, with an error listener for initialization,
turn, and shutdown. `BRIDGE_SMOKE_PASS` is printed only after disposal and cleanup;
its scope explicitly excludes full extension health. Best-effort failures swallowed
internally by extensions cannot be inferred from a successful read. In particular,
a native pi-lcm ABI mismatch is not fixed or waived by this probe.

**Safety boundary:** model-requested tool execution is gated, not merely aborted
from observational `tool_execution_start` events. This is not a sandbox around installed
code. Real configured extensions, hooks, OAuth refresh, and services may perform
their normal IO/side effects, including outside the probe directory. Review those
extensions before granting permission; do not run this against a project whose
startup hooks automatically start work or write project files. The script itself
writes only probe session data and never intentionally writes project files. Read
content and project context are sent to the configured provider. Logs can contain
private local paths/extension diagnostics; keep them local or redact before sharing.

The deadline covers runtime creation and prompting; on timeout the script attempts
abort/dispose. A further 10-second hard deadline exits nonzero if initialization or
shutdown hangs. Hard termination can leave probe data or extension-owned handles/
side effects; the stderr failure is not a health pass. Normal success/failure
removes the probe directory and disposes the runtime. Exit 0 means the scoped
checks passed; any assertion, timeout, configuration, or cleanup failure is nonzero.
Never infer success solely from a model's text or a historical session transcript.


## Mid-turn steering (KAS765)

The standard offline suite includes `src/pi-steering.test.ts` and the message-routing regressions in `src/service.test.ts`. The SDK fixture asserts the exact embedded version (0.85.1), injects a mock response stream without model calls, holds the original prompt open, and confirms distinct receipts for identical corrections before that prompt settles. No installed extensions or live conversations are loaded.

Targeted check (Node 24):

```sh
pnpm build
node --test dist/pi-steering.test.js
node --test --test-name-pattern='mid-turn|steering recovery|steering notice|explicit continue after steering' dist/service.test.js
node --test dist/state/*.test.js
```

These checks cover synchronous receipt capture/restoration, unsupported identity behavior, claim atomicity, duplicate/reconnect events, images and settlement races, decision/command/auth isolation, pending-queue retirement, and restart/uncertain-notice reconciliation. They are source validation, not a deployment or live-app verification gate. See [steering recovery limits](SCOPE.md#steering-delivery-and-recovery) before changing the SDK pin.
