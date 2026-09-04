# pi-clickclack

`pi-clickclack` is a private local bridge between ClickClack conversations and persistent Pi coding-agent sessions.

It runs as a standalone service. It does not require changes to ClickClack, a Pi fork, or a Pi extension.

```text
ClickClack
  ⇅ HTTP, realtime WebSocket, agent progress
pi-clickclack
  ⇅ AgentSession SDK
Pi
```

The first release is for one trusted owner in one ClickClack workspace. It supports bound channels and direct conversations, streams Pi commentary and tool activity into ClickClack, and retains one Pi session per conversation.

See [`docs/SCOPE.md`](docs/SCOPE.md) for the locked v1 boundary.

## Verification

Run the local checks with:

```sh
pnpm typecheck
pnpm build
pnpm test
```

The Orkastrator decision integration test starts the real embedded Pi runtime, patched Pi Workflows extension, workflow host, and bridge against a disposable human-decision workflow. It uses an in-process ClickClack transport boundary and verifies that an answer resumes the workflow to completion.

```sh
pnpm test:workflow-integration
```

The test packs the sibling `../orkastrator` checkout and installs that archive in a disposable consumer before running. It does not modify the sibling checkout. Set `ORKASTRATOR_ROOT` when the checkout is elsewhere.
