# pi-clickclack v1 scope

## Goal

Let one trusted owner talk to persistent, fully tooled Pi coding-agent sessions from ClickClack channels and direct conversations. Preserve Pi's normal project context, skills, extensions, tools, settings, and session history while using ClickClack's native agent-progress and durable activity surfaces.

## Architecture

`pi-clickclack` is a standalone Node.js and TypeScript daemon.

```text
ClickClack
  ⇅ durable events, ephemeral progress, messages, uploads
pi-clickclack
  ⇅ AgentSession API and event subscription
Pi
```

The bridge imports `@earendil-works/pi-coding-agent` and creates embedded `AgentSession` instances. It connects to ClickClack with the ClickClack TypeScript SDK and HTTP and realtime APIs. Neither upstream system imports or controls the bridge.

## Product boundary

- One trusted owner, selected by ClickClack user ID.
- One ClickClack workspace.
- ClickClack channels and direct conversations.
- A private local deployment.
- Stock ClickClack and stock Pi packages.
- No required Pi extension.

## Conversation and session model

- Each bound ClickClack channel or direct conversation owns one persistent Pi session.
- Each conversation binds to one configured project alias.
- Each project alias resolves to an approved absolute working directory.
- Pi resource discovery starts from that working directory, including project context, skills, extensions, prompts, and settings.
- New turns are serialized within a conversation. Different conversations may run concurrently.
- An invoke-eligible owner message arriving while that conversation's Pi session is streaming uses `session.steer(text, images)`. It belongs to the running ClickClack turn, not a second turn. No prose-based correction detection, separate control UI, or `followUp()` path is used.
- Pi consumes steering at its next supported agent-loop boundary (after the current assistant response/tool calls, before the next model call), not in the middle of a token or tool execution. If no session is streaming, or previously queued work/commands must run first, the message starts a normal serialized turn instead.
- Decision replies retain precedence. Slash commands, including extension/resource commands and `/continue`, retain their existing serialized behavior. This change does not add an `/abort` command.
- Images use the existing hydration, byte limits and download validation. Routing rechecks the exact active session after attachment I/O. Claim/receipt persistence and the pinned SDK's synchronous enqueue have no intervening await, so settlement cannot both steer and queue the same input.

## Invocation policy

- Direct conversations invoke Pi automatically for owner-authored messages.
- Channels are mention-only by default.
- A channel binding may explicitly enable always-on invocation when the channel is dedicated to Pi.
- Messages from users outside the owner allowlist are ignored.
- Bot-authored and bridge-authored events are ignored.

## Output model

- Assistant text deltas update a targeted ephemeral `agent.progress` commentary line.
- Tool start, update, and end events update targeted ephemeral tool lines.
- Progress updates are throttled and coalesced rather than publishing every token or output chunk.
- Sanitized assistant commentary persists as `agent_commentary` messages.
- Tool activity persists as `agent_tool` messages.
- Durable activity for one response shares a ClickClack `turn_id` and renders as one collapsible preamble.
- The final answer is a normal durable ClickClack message with a deterministic nonce.
- Hidden model thinking is never sent to ClickClack.

## Interactive requests

- Pi confirmation, selection, input, and editor requests become durable ClickClack prompts.
- The bridge correlates the owner's matching reply with the blocked Pi request.
- An ambiguous reply, timeout, service restart, or lost correlation fails closed.
- Fire-and-forget Pi UI events may be translated into progress or ignored according to an explicit mapping.

## Commands

The bridge publishes its complete supported command menu through ClickClack's bot-command API:

- `/project <alias>` binds the conversation to an approved project.
- `/continue` resumes the latest recoverable Pi session.
- `/compact [instructions]` compacts the current Pi session.
- `/new` archives the current session and starts a persistent replacement.
- `/name [name]` shows or sets the Pi session name.
- `/session` shows session, usage, and context statistics.
- `/model [provider/model]` shows or selects the session model.
- `/thinking [level]` shows or selects the thinking level.
- `/reload` reloads Pi extensions, skills, prompts, and context files.
- `/copy` sends the latest assistant answer as a new ClickClack message.

Extension commands, prompt templates, and `/skill:<name>` commands are passed unchanged to `AgentSession.prompt()` when they exist in the bound project's loaded Pi resources. Compatible extension and prompt-template names are added to ClickClack's bot-command menu after the project runtime loads. Skill command names contain a colon, which ClickClack's command-menu schema does not accept, so skills remain available by typing them directly. Unknown slash commands are rejected instead of becoming model prompts. Pi commands that depend on terminal-only selectors, clipboard access, local credential dialogs, or process shutdown are not advertised in ClickClack.

## State and recovery

A local SQLite database stores:

- the last processed ClickClack realtime cursor;
- claimed source message IDs;
- conversation and project bindings;
- Pi session file references;
- active turn metadata;
- pending interactive-request correlations;
- outbound message nonces and reconciliation state.

Pi remains the source of truth for agent session history. ClickClack remains the source of truth for chat messages. The bridge does not create a third transcript.

The bridge claims a source message before invoking Pi. Replayed ClickClack events therefore cannot start the same agent turn twice. Steering adds a small receipt in the same SQLite transaction as its source claim, recording the source ID, owner, binding/project, session, active turn, workspace and bot identity; it does not copy prompt text into bridge state.

### Steering delivery and recovery

- Pi 0.85.1's `AgentSession.steer()` expands skills/templates and synchronously calls the public `agent.steer(userMessage)` before its first await. Unlike `prompt()`, it does not run extension input hooks. `src/pi-steering.ts` temporarily intercepts that public call and restores it synchronously in `finally`, forwarding arguments, receiver and return value unchanged.
- The adapter correlates only the exact queued object with the SDK's `message_start` event. Identical text is not identity. That event marks a receipt consumed: the SDK accepted the user message into its running history, **not** proof that the model followed it or finished its work. Nested captures, clones or asynchronous enqueue cannot falsely confirm a receipt. `src/pi-steering.test.ts` pins this compatibility assumption to 0.85.1 using real SDK streaming with an injected, network-free response stream.
- A receipt still unconfirmed after settlement/restart becomes uncertain. The source claim remains held; ambiguous messages are never automatically replayed. The owner receives an uncertainty notice in the original conversation only if the original authorization, binding and session identity still match. Revoked/changed targets keep their receipts without leaking a notice elsewhere. Failed notices retry at reconnect/startup and subsequent settlements, using the existing outbound reconciliation table, deterministic nonce and nonce lookup.
- If submitted, unconfirmed steering is still queued at settlement, only that runtime is retired and its session reference archived, preserving history. Extension-owned queues are not cleared or carried into another implicit turn. A rejection before enqueue with an empty queue does not retire a healthy runtime. `/continue` explicitly reconstructs a fresh runtime from recoverable history, not the old in-memory queue.
- SQLite claims/receipts and Pi session history are not one transaction. A crash after SDK consumption but before receipt confirmation can produce an uncertainty notice for an already consumed message. This is **not exactly-once delivery**; the owner should inspect the result before resending. Ordinary pre-stream/queued-turn recovery is unchanged and remains memory-queued, not a new durable input queue.

## Security boundary

- Bot credentials and provider credentials come from local environment or approved secret storage.
- Only configured owner IDs may invoke Pi or answer interactive requests.
- Chat input cannot introduce an arbitrary filesystem path.
- Every Pi session runs from a configured project alias and approved working directory.
- The bot token receives only the ClickClack scopes required for realtime read, conversations, uploads, agent activity, and command-menu publication.
- Logs must not contain bot tokens, provider credentials, or complete secret-bearing tool output.

## Out of scope

- Multiple untrusted users or per-user session ownership.
- Arbitrary working-directory selection from chat.
- Thread-specific routing.
- Public packaging, release automation, or compatibility guarantees.
- Full Pi command parity.
- Raw model-thinking exposure.
- Token-by-token growth inside a durable timeline message bubble.
- Process-per-session isolation or an RPC transport backend.
- Cross-machine or hosted deployment.

## Delivery plan

1. Bootstrap the package, typed configuration, SQLite state, and bot authentication.
2. Implement cursor-safe realtime ingestion, source-message claims, and invocation gating.
3. Implement project bindings, persistent Pi sessions, serialized turns, core commands, and supported-boundary mid-turn steering.
4. Translate Pi streaming, tool activity, final messages, uploads, and interactive requests.
5. Add crash recovery, race and replay tests, systemd installation, and operator documentation.

## Budget

The locked v1 budget is 9 to 12 agentic hours. The main uncertainty is restart-safe interactive requests and settlement-versus-queueing race coverage, not the basic transport bridge.
