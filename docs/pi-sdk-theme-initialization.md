# Pi SDK theme initialization research

researched 2026-09-19 against `@earendil-works/pi-coding-agent` 0.85.1.

## conclusion

some of this design is intentional, but the embedded-host failure does not look intentional.

Pi intentionally keeps the active theme in a process-global singleton and throws when code reads it before initialization. That gives the CLI one place to select a configured theme, install validation, and optionally start the custom-theme watcher. The CLI treats this initialization as required even outside the TUI: it calls `initTheme(settingsManager.getTheme(), appMode === "interactive")` before dispatching interactive, print, or RPC mode. Only the watcher flag depends on interactive mode.[^main]

The unsupported part is the SDK contract. `createAgentSessionServices()` does not initialize the singleton, while the SDK documentation advertises embedding Pi in custom web, desktop, and mobile interfaces and loading extensions without documenting any `initTheme()` precondition.[^sdk] A fresh-process check against 0.85.1 confirms that `createAgentSessionServices()` returns successfully but theme-backed helpers still throw until the host calls `initTheme()`.

```text
after createAgentSessionServices: Theme not initialized. Call initTheme() first.
after initTheme: initialized
```

The best reading is:

- explicit theme ownership at the application boundary is deliberate;
- the throwing proxy is a deliberate invariant check;
- allowing ordinary SDK and extension paths to reach that proxy without either initializing it or documenting the host obligation is an architectural leak.

There is no maintainer statement saying embedded hosts are expected to call `initTheme()`. The available upstream evidence points the other way.

## upstream evidence

### the CLI initializes themes in every run mode

Pi's CLI creates the runtime, gets its `settingsManager`, installs the JSON validator, and calls `initTheme()` before choosing RPC, interactive, or print mode. The second argument enables file watching only for interactive mode.[^main]

That matters because it rules out the simple explanation that themes are intentionally absent in headless operation. `pi --mode rpc` is headless and still receives theme initialization through the CLI bootstrap.

### the SDK presents itself as a complete embedding surface

The SDK documentation says it provides programmatic access for embedding Pi in other applications and building custom interfaces. Its `createAgentSession()`, `createAgentSessionServices()`, resource-loader, and extension examples do not mention `initTheme()`.[^sdk]

`initTheme()` is exported publicly, but it is grouped under interactive theme utilities. The documentation does not define it as a prerequisite for SDK session creation.

### the singleton and throw are intentional mechanics

The theme module stores the active theme under a `Symbol.for()` key on `globalThis` so separate module loaders can share it. The exported `theme` proxy throws `Theme not initialized. Call initTheme() first.` when that slot is empty. `initTheme()` loads the configured or default theme and optionally starts the watcher.[^theme]

This is useful inside a fully bootstrapped application. It catches incorrect startup order instead of silently rendering with an unknown palette. It becomes a problem when lower-level SDK services expose theme-dependent code without carrying the initialization contract.

### upstream users have reported the same embedding failure

Issue #6102 reports the exact library-host failure on 0.80.2: extensions or shared code read the global theme, but only the CLI startup path initializes it. The reporter calls the host-side `initTheme(undefined, false)` workaround “not a real fix” and proposes lazy default initialization for embedded hosts.[^6102]

Issue #6110 reports the same ordering failure in `pi-web`, where `session_start` reaches extensions before the theme is initialized. Its proposed fixes are to initialize before extension events, provide a safe fallback, or document an explicit readiness contract.[^6110]

Both issues were closed automatically under the repository's new-contributor policy. Neither received a maintainer technical rejection, acceptance, or design explanation.

### an unreviewed PR supplied the missing regression test

PR #6501 implemented lazy bootstrap of the built-in dark theme and added a regression test for non-TUI library hosts. It was also closed automatically by contributor policy, with no review verdict. It therefore shows that the bug and a plausible fix are concrete, but it does not establish upstream maintainer intent.[^6501]

The bug remains reproducible in 0.85.1.

## implication for pi-clickclack

`initTheme(undefined, false)` at the `pi-clickclack` process boundary is the correct compatibility fix today. It mirrors the CLI's headless behavior without starting a file watcher. It should remain before any runtime, resource-loader, extension, or connector initialization.

Moving to `pi --mode rpc` would avoid this particular bootstrap gap because the CLI performs initialization first, but it would also replace direct SDK integration with subprocess lifecycle and JSONL transport. This theme bug is not evidence that the SDK is the wrong integration surface.

The upstream design question is narrower: who owns process-global SDK initialization?

A durable upstream resolution should choose and document one of these contracts:

1. `createAgentSessionServices()` guarantees a safe default theme before exposing theme-dependent tools and extensions.
2. a public, idempotent headless bootstrap function initializes every required process-global service.
3. the SDK explicitly requires hosts to call `initTheme()` before session or extension creation, with a documented example.

The current state does none of the three.

## recommendation

keep the existing host initialization and its regression test. If this is raised upstream, frame it as a missing SDK lifecycle contract rather than a request to make the SDK use the interactive CLI. The strongest minimal request is either:

- document `initTheme(undefined, false)` as mandatory SDK bootstrap, or
- make the SDK establish a safe default before loading extensions.

Because themes are process-global, automatic initialization inside every per-session factory also needs defined behavior when multiple sessions have different project settings. A one-time headless bootstrap API would make that ownership clearer than hidden initialization in each session.

[^main]: Pi 0.85.1 CLI startup, [`packages/coding-agent/src/main.ts`](https://github.com/earendil-works/pi/blob/v0.85.1/packages/coding-agent/src/main.ts).
[^sdk]: Pi 0.85.1 SDK documentation, [`packages/coding-agent/docs/sdk.md`](https://github.com/earendil-works/pi/blob/v0.85.1/packages/coding-agent/docs/sdk.md).
[^theme]: Pi 0.85.1 theme singleton and initializer, [`packages/coding-agent/src/modes/interactive/theme/theme.ts`](https://github.com/earendil-works/pi/blob/v0.85.1/packages/coding-agent/src/modes/interactive/theme/theme.ts).
[^6102]: earendil-works/pi [issue #6102](https://github.com/earendil-works/pi/issues/6102), “Embedded library: theme Proxy throws ‘Theme not initialized’ and initTheme() fails when PI_PACKAGE_DIR points at a shim.”
[^6110]: earendil-works/pi [issue #6110](https://github.com/earendil-works/pi/issues/6110), “Extension session_start fires before initTheme, causing Proxy throw in pi-web.”
[^6501]: earendil-works/pi [PR #6501](https://github.com/earendil-works/pi/pull/6501), “fix(extensions,theme): support embedded library hosts.”
