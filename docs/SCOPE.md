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
- Turns are serialized within a conversation. Different conversations may run concurrently.
- A message arriving during an active turn **queues behind it** and starts its own turn once the running turn settles. Steering is **not implemented**: the bridge never calls `session.steer()`, `session.followUp()`, or `PromptOptions.streamingBehavior`, so a mid-turn correction cannot reach a turn already in flight.
- Per-conversation serialization is what keeps this safe. Because a second `prompt()` never lands while the first is streaming, the SDK's "streaming without `streamingBehavior` throws" path is never reached.
- Turn settlement and new-message routing are atomic so one message cannot both queue against an active turn and start another turn.

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

The bridge claims a source message before invoking Pi. Replayed ClickClack events therefore cannot start the same agent turn twice. Outbound durable messages use deterministic nonces and reconcile uncertain creates through ClickClack's nonce lookup endpoint.

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
3. Implement project bindings, persistent Pi sessions, serialized turns, and core commands. (Steering was planned here and was not built; see the conversation and session model above.)
4. Translate Pi streaming, tool activity, final messages, uploads, and interactive requests.
5. Add crash recovery, race and replay tests, systemd installation, and operator documentation.

## Budget

The locked v1 budget is 9 to 12 agentic hours. The main uncertainty is restart-safe interactive requests and settlement-versus-queueing race coverage, not the basic transport bridge.
