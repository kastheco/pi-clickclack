# pi-clickclack

`pi-clickclack` is a private local bridge between ClickClack conversations and persistent Pi coding-agent sessions.

```text
ClickClack
  ⇅ HTTP, realtime WebSocket, agent progress
pi-clickclack
  ⇅ AgentSession SDK
Pi
```

The bridge is built for one trusted owner in one ClickClack workspace. Each bound channel or direct conversation keeps one persistent Pi session, pinned to an approved project directory. It streams visible commentary and tool activity, uploads referenced output files, and carries Pi confirmation, selection, input, and editor requests back through ClickClack.

See [`docs/SCOPE.md`](docs/SCOPE.md) for the locked v1 boundary.

## Requirements

- Linux with systemd user services
- Node 24 or newer
- pnpm 11.20.0
- a running ClickClack server
- a ClickClack bot token for the target workspace
- the configured Pi provider credentials in the service environment

The bot token needs the standard `bot:write` scope bundle plus the explicit `agent_activity:write` scope. `agent_activity:write` is not included in any bot bundle. The bridge uses realtime read, channel and DM message read/write, uploads, command publication, workspace/profile reads, ephemeral progress, and durable agent activity.

## Install

Install dependencies and build the bridge:

```sh
pnpm install --frozen-lockfile
pnpm typecheck
pnpm build
```

Keep credentials outside the repository. The installer defaults to `~/.config/pi-clickclack/env`:

```sh
mkdir -p ~/.config/pi-clickclack
cp .env.example ~/.config/pi-clickclack/env
chmod 600 ~/.config/pi-clickclack/env
$EDITOR ~/.config/pi-clickclack/env
```

The environment file uses ordinary `KEY=value` lines. JSON arrays must remain on one line.

| Variable | Purpose |
| --- | --- |
| `CLICKCLACK_URL` | ClickClack server base URL. |
| `CLICKCLACK_WORKSPACE_ID` | Workspace the bot token is bound to. |
| `CLICKCLACK_BOT_TOKEN` | Bot token with `bot:write,agent_activity:write`. |
| `CLICKCLACK_OWNER_IDS` | Comma-separated user IDs allowed to invoke Pi or answer prompts. |
| `CLICKCLACK_PI_PROJECTS` | JSON array of approved `{ "alias", "cwd" }` project bindings. Every path must be absolute and already exist. |
| `CLICKCLACK_PI_INVOCATIONS` | Optional JSON array of preconfigured channel or direct-conversation invocation modes. |
| `CLICKCLACK_PI_MODEL` | Pi model in `provider/model-id` form. |
| `CLICKCLACK_PI_THINKING_LEVEL` | `off`, `minimal`, `low`, `medium`, `high`, `xhigh`, or `max`. |
| `CLICKCLACK_GIT_ACTIVITY_CHANNEL_ID` | Optional channel for durable commit, push, and merge cards. |
| `CLICKCLACK_PI_STATE_PATH` | SQLite state path. Defaults to `~/.local/state/pi-clickclack/state.sqlite`. |
| `CLICKCLACK_PI_AGENT_DIR` | Pi agent directory. Defaults to `~/.pi/agent`. |

Example project and invocation configuration:

```sh
CLICKCLACK_PI_PROJECTS=[{"alias":"clickclack","cwd":"/home/user/dev/clickclack"},{"alias":"bridge","cwd":"/home/user/dev/pi-clickclack"}]
CLICKCLACK_PI_INVOCATIONS=[{"conversationType":"channel","conversationId":"chn_replace_me","mode":"mention"},{"conversationType":"direct","conversationId":"dcn_replace_me","mode":"auto"}]
```

Channels support `mention` or `always`. Direct conversations use `auto`.

### One coding persona per project

Run the interactive helper:

```sh
pnpm persona:add
```

It asks for the project alias, display name, handle, and directory, then creates the user-owned ClickClack bot, writes its isolated `0600` environment file, builds the bridge, installs a named systemd service, starts it, and verifies that it is active. Existing `~/.config/pi-clickclack/env` values are used as defaults for the ClickClack URL, workspace, owner, Pi model, thinking level, and agent directory.

For example, `utmco`, `утмсо`, `utmco`, and `/home/user/dev/utmco` create `@utmco` backed by `pi-clickclack-utmco.service` and locked to that directory.

Preview without creating anything:

```sh
pnpm persona:add -- --dry-run
```

Every prompt also has a flag for automation. Run `pnpm persona:add -- --help` for the complete list. Each channel or DM with the bot receives its own persistent Pi session, while every session is pinned to the persona's single project directory.

The lower-level `service:install -- --persona <alias>` command remains available for existing external environment files. It rejects multi-project configuration and implicit shared state paths. Legacy single-service mode remains available for one bridge that can switch between approved projects.

Install, enable, and start the legacy user service:

```sh
pnpm service:install -- --repo "$PWD" --env "$HOME/.config/pi-clickclack/env" --start
```

The installer writes `~/.config/systemd/user/pi-clickclack.service`, pins the current Node executable and checkout, sets the environment file to mode `0600`, and verifies that the service became active. It refuses environment files inside the repository. If an older installation has systemd drop-ins, review them and rerun with `--replace-overrides` to archive them before installing the new unit.

Preview the generated unit without changing systemd:

```sh
pnpm service:install -- --repo "$PWD" --env "$HOME/.config/pi-clickclack/env" --dry-run
```

## Commands

The bridge publishes its supported commands to ClickClack:

- `/project <alias>` binds the conversation to an approved project.
- `/invoke [mention|always]` shows or changes a channel's invocation mode.
- `/continue` resumes the latest recoverable Pi session.
- `/compact [instructions]` compacts the current Pi session.
- `/new` archives the current session and starts a replacement.
- `/name [name]` shows or sets the session name.
- `/session` shows session and context statistics.
- `/model [provider/model]` shows or changes the session model.
- `/thinking [level]` shows or changes the thinking level.
- `/reasoning [stream|off]` shows or changes whether Pi's intermediate working commentary streams before tool batches. Streaming is the default; `off` drops that commentary for this conversation until the bridge restarts. Provider reasoning summaries stay hidden.
- `/reload` reloads Pi extensions, skills, prompts, and context files.
- `/copy` posts the latest assistant answer as a new ClickClack message.

Compatible extension and prompt-template commands are added after a project runtime loads. Skill commands contain a colon and must be typed directly because ClickClack command names do not accept colons.

## Recovery behavior

SQLite stores the realtime cursor, source-message claims, conversation bindings, Pi session references, active turns, pending interactive requests, steering receipts, and outbound nonce reconciliation state.

- Replayed or duplicate realtime events cannot start a second turn for the same source message.
- Reconnect catches up from the committed cursor before opening a new WebSocket.
- Durable messages use deterministic nonces. A create whose response was lost is checked through ClickClack nonce lookup before another create is attempted.
- A process restart archives the interrupted Pi runtime, removes its pending interaction, and clears its ephemeral progress frame. The owner must explicitly use `/continue` to reopen recoverable session history.
- Ambiguous steering is never replayed automatically. The bridge posts a nonce-protected uncertainty notice when the original authorization and binding still match.
- Generated uploads use deterministic upload nonces and reconcile a lost create response through upload lookup.

Pi remains the source of truth for session history. ClickClack remains the source of truth for chat messages. The bridge does not keep a third transcript.

## Verify

Run the deterministic local checks with Node 24:

```sh
pnpm typecheck
pnpm build
pnpm test
```

The standard suite covers duplicate events, reconnect catch-up, restart cleanup, abort and steering races, nonce reconciliation, interaction timeout/cancellation, progress throttling, generated files, and SQLite migration rollback.

The Orkastrator decision integration test starts the real embedded Pi runtime, patched Pi Workflows extension, workflow host, and bridge against a disposable human-decision workflow:

```sh
pnpm test:workflow-integration
```

It packs the sibling `../orkastrator` checkout into a disposable consumer. Set `ORKASTRATOR_ROOT` when that checkout lives elsewhere.

See [`docs/smoke-suite.md`](docs/smoke-suite.md) for the opt-in installed-injector and isolated live read-only probes. See [`docs/durable-workflow-publication.md`](docs/durable-workflow-publication.md) for durable workflow history verification.

## Operate

Legacy service:

```sh
systemctl --user status pi-clickclack.service
journalctl --user -u pi-clickclack.service -f
systemctl --user restart pi-clickclack.service
systemctl --user stop pi-clickclack.service
```

Project persona service:

```sh
systemctl --user status pi-clickclack-clickclack.service
journalctl --user -u pi-clickclack-clickclack.service -f
systemctl --user restart pi-clickclack-clickclack.service
systemctl --user stop pi-clickclack-clickclack.service
```

A healthy start logs `bridge service started` with the bot, workspace, configured aliases, command count, and runtime kind. Structured logs redact configured tokens and provider credentials.

## Upgrade

Back up SQLite before changing binaries:

```sh
state=${CLICKCLACK_PI_STATE_PATH:-$HOME/.local/state/pi-clickclack/state.sqlite}
mkdir -p "$HOME/.local/state/pi-clickclack/backups"
sqlite3 "$state" ".backup '$HOME/.local/state/pi-clickclack/backups/state-$(date +%Y%m%d-%H%M%S).sqlite'"
```

Then update and cut over:

```sh
systemctl --user stop pi-clickclack.service
pnpm install --frozen-lockfile
pnpm typecheck
pnpm build
pnpm test
pnpm service:install -- --repo "$PWD" --env "$HOME/.config/pi-clickclack/env" --start
```

Confirm `systemctl --user is-active pi-clickclack.service` and inspect the startup journal before deleting the backup. To roll back, stop the service, restore the previous checkout and build, restore the matching SQLite backup if that release cannot read the migrated schema, rerun the installer, and start the service.

## Troubleshooting

### The service exits during startup

Run the entrypoint with the external environment file to see the configuration error directly:

```sh
node --env-file="$HOME/.config/pi-clickclack/env" dist/index.js
```

The bridge rejects missing owners, malformed JSON, duplicate aliases, relative project paths, nonexistent project or agent directories, invalid invocation modes, non-bot tokens, and the wrong workspace before opening realtime ingestion.

### No messages invoke Pi

Check that the sender is in `CLICKCLACK_OWNER_IDS`. Bind the conversation with `/project <alias>`. Channels default to mention-only, so mention the bot or use `/invoke always` in a dedicated channel.

### Activity or prompts are missing

Mint a token with `bot:write,agent_activity:write`. Confirm the bot can write to the target channel or DM and that its workspace matches `CLICKCLACK_WORKSPACE_ID`. A token without the explicit activity scope can send ordinary replies but cannot publish commentary or tool rows.

### The bridge reconnects repeatedly

Check the ClickClack server and the service journal. The bridge resumes from its durable cursor after the WebSocket closes. Do not delete the SQLite file to fix a network outage because it also holds replay protection and conversation bindings.

### A turn was interrupted by restart

The old progress frame is cleared and the stale runtime is archived. Send `/continue` to restore the latest recoverable Pi session. Pending confirmations and inputs fail closed and are not answered on the owner's behalf.
