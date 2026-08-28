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
