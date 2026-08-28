# Start KAS-732 in pi-clickclack

Work in `/home/kas/dev/pi-clickclack` and implement **KAS-732: Bootstrap the bridge service and state store**.

Linear issue: https://linear.app/kashub/issue/KAS-732/bootstrap-the-bridge-service-and-state-store

## Start here

1. Read `README.md`, `CONTEXT.md`, `docs/SCOPE.md`, and `docs/adr/0001-standalone-embedded-bridge.md` completely.
2. Inspect `git status`. The uncommitted planning baseline is intentional; preserve it.
3. Read the current Pi SDK documentation at `/home/kas/.nvm/versions/node/v22.22.2/lib/node_modules/@earendil-works/pi-coding-agent/docs/sdk.md` and follow relevant cross-references before using the SDK.
4. Read the relevant ClickClack contracts in `../clickclack/docs/features/bots.md`, `realtime.md`, and `messages.md`, plus the TypeScript SDK surface in `../clickclack/packages/sdk-ts`.
5. Use `/home/kas/dev/face/clickclack-bot` as a read-only reference for environment loading, ClickClack client setup, shutdown, cursor persistence, and replay claims. Do not copy its VAI command model into this service.

## Locked architecture

This is a private standalone Node.js and TypeScript daemon. It imports stock `@earendil-works/pi-coding-agent` and talks to stock ClickClack APIs. It is not a ClickClack feature, Pi fork, Pi extension, or RPC subprocess wrapper.

The first release has one workspace, trusted owner IDs, configured project aliases, and one persistent Pi session per bound channel or direct conversation. SQLite owns bridge state. Pi owns agent transcripts. ClickClack owns chat messages.

## This issue only

Build the service foundation required by later issues. Do not implement realtime routing, Pi turns, streaming, or chat commands yet.

Deliver:

- a runnable TypeScript service entry point with clean startup and shutdown;
- typed configuration for ClickClack URL, workspace ID, bot token, owner IDs, project aliases and absolute working directories, per-conversation invocation mode, model, thinking level, state path, and Pi agent directory;
- strict validation with useful startup errors and no secret values in errors or logs;
- construction boundaries for the ClickClack client and embedded Pi runtime without starting sessions yet;
- a local SQLite schema and migrations for realtime cursor, source-message claims, conversation bindings, Pi session references, active turns, pending interactive requests, and outbound nonce reconciliation;
- transaction-safe state-store methods that later issues can build on;
- structured logging and graceful resource cleanup;
- unit tests for configuration validation, migrations, claims, bindings, active-turn transitions, pending interactions, and outbound reconciliation state;
- an `.env.example` containing names and safe placeholders only.

Choose the smallest maintained Node 24-compatible SQLite and validation dependencies that fit this service. Keep persistence behind a typed module rather than leaking SQL across the package.

## Completion gate

Finish when:

- dependencies install from a clean checkout;
- build, typecheck, and tests pass;
- migrations are repeatable and transactional;
- duplicate source-message claims are observably rejected;
- invalid project paths, duplicate aliases, missing owners, and malformed invocation bindings fail before the service starts;
- logs and test snapshots contain no bot token or provider credential;
- the implementation remains inside KAS-732's boundary.

Report changed files, commands run, validation results, and residual risks. Do not push. Do not start KAS-733.
