# Use a standalone bridge with embedded Pi sessions

`clickclack-pi` will be a separate service that imports Pi's `AgentSession` SDK and talks to ClickClack through public APIs. Keeping the integration outside both upstream systems lets ClickClack and Pi upgrade independently, while embedding sessions avoids the process supervision and JSONL framing required by a `pi --mode rpc` backend. A Pi extension and an RPC subprocess backend remain possible later but are not part of v1.
