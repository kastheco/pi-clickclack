# isolated scoped bots

each ClickClack bot runs as its own rootless podman container from one shared release image. bots share code and the credential pool, never writable state. this is the KAS-946 layout. `clickclack` was the canary, and `kassette`, `matchfi`, `utmco`, and the multi-project `pi` bot run the same way.

## release image

`deploy/Containerfile` builds the only copy of the bridge, omp, and the extension set:

```sh
podman build -f deploy/Containerfile \
  --build-context clickclack-sdk=../clickclack/packages/sdk-ts \
  -t localhost/omp-clickclack:<bridge commit>-omp<omp version> .
```

build from a clean worktree so the tag names the exact source. the image contains:

- bun, node, go, pnpm, gh, git, ripgrep, fd, and sqlite3 for the bot's coding work. the root filesystem is read-only at runtime, so pnpm is prepared at build time and `GOTOOLCHAIN=local` stops go from downloading toolchains.
- the bridge under `/opt/omp-clickclack`, with `@oh-my-pi/pi-coding-agent` pinned by `bun.lock`.
- the extension set under `/opt/omp-clickclack/extensions`, pinned by `deploy/extensions/bun.lock`: context-mode (loaded through its pi adapter, which carries the MCP bridge and resume injection that its omp adapter lacks), pi-lcm, and `@luxusai/pi-hindsight`. `deploy/extensions/bunfig.toml` disables peer installs, because the extensions declare upstream pi packages as peers and omp supplies those modules through its compatibility shim. the image must contain no `@earendil-works` or `@mariozechner` pi packages.
- `deploy/extensions/patches/pi-lcm@0.1.3.patch`, which moves pi-lcm from better-sqlite3 to `bun:sqlite`. better-sqlite3 doesn't load under bun.
- `CLICKCLACK_OMP_EXTENSION_PATHS`, which tells the bridge to load exactly those extensions. extension discovery stays off, so nothing is installed into a bot's writable tree.

## per-bot layout

```
~/.config/omp-clickclack/<bot>.env                 0600. ClickClack token and bridge settings, no storage paths
~/.local/share/omp-clickclack/<bot>/               0700. mounted read-write at /bot
  home/                   HOME and XDG directories
  home/.pi/agent/hindsight.json                    hindsight banks: the bot's own project bank plus kas-engineering as the global bank
  agent/                  omp agent dir: sessions/, lcm/, agent.db, mcp.json, config.yml, extension state
  state/bridge.sqlite     bridge state
  tmp/                    TMPDIR
  workspace-hindsight/    overlays <workspace>/.pi/hindsight
~/.config/containers/systemd/omp-clickclack-<bot>.container
~/.config/systemd/user/omp-clickclack.slice        aggregate budget for all bots
~/.config/systemd/user/omp-auth-broker.service     shared credential pool
```

the quadlet sets every storage variable (`HOME`, `XDG_*`, `TMPDIR`, `PI_CODING_AGENT_DIR`, `CLICKCLACK_PI_AGENT_DIR`, `CLICKCLACK_PI_STATE_PATH`, `LCM_DB_DIR`). the bot env file must not set any of them.

pi-hindsight writes its retain cursors, receipts, and queue to `<cwd>/.pi/hindsight` with the path hardcoded. the quadlet mounts the bot's own `workspace-hindsight/` over that directory, so bots sharing a workspace don't share retain state. the multi-project `pi` bot mounts `workspace-hindsight/<alias>/` over each project's directory.

create a new bot tree:

```sh
umask 077
b=~/.local/share/omp-clickclack/<bot>
mkdir -p $b/{home/.pi/agent,home/.omp,home/.ssh,agent/lcm,state,tmp,workspace-hindsight}
jq '.banks.project.bankId="omp-clickclack-<bot>" | .banks.user={enabled: true, bankId: "kas-engineering"}' \
  ~/.pi/agent/hindsight.json > $b/home/.pi/agent/hindsight.json
grep -vE '^(CLICKCLACK_PI_STATE_PATH|CLICKCLACK_PI_AGENT_DIR|CLICKCLACK_PI_MODEL)=' \
  ~/.config/pi-clickclack/personas/<bot>.env > ~/.config/omp-clickclack/<bot>.env
echo 'CLICKCLACK_PI_MODEL=openai-codex/gpt-6-astra' >> ~/.config/omp-clickclack/<bot>.env
printf 'tier:\n  openai: priority\n' > $b/agent/config.yml
```

the bots default to `gpt-6-astra` on the priority tier, with thinking from `CLICKCLACK_PI_THINKING_LEVEL`. the model comes from the env file and overrides the model saved in a resumed session. the tier comes from the bot's own omp `config.yml`.

## what the container sees

- the release image, read-only.
- `/bot`, the bot's private tree.
- its workspaces at their host paths, read-write, so session `cwd` values stay valid across the migration. `clickclack` gets `~/dev/clickclack`, `~/dev/omp-clickclack`, and `~/dev/pi-clickclack`. `kassette`, `matchfi`, and `utmco` get their one project directory. `pi` gets the directory of every project in its `CLICKCLACK_PI_PROJECTS`. the container's working directory is the bot's first project.
- read-only: `~/.gitconfig`, `~/.ssh` (with a tmpfs over `~/.ssh/cm` for multiplexing sockets), the voice profile, and the global `AGENTS.md` and skills from `~/.pi/agent`.
- `GH_TOKEN` from the podman secret `omp-clickclack-gh-token`, created with `gh auth token | tr -d '\n' | podman secret create omp-clickclack-gh-token -`. the gitconfig's credential helper is `gh auth git-credential`, so https pushes use the same token.
- the auth broker token at `/bot/home/.omp/auth-broker.token`, read-only.

it never gets the personal home, the personal omp or pi agent directories, sibling bot trees, or a container socket.

## credentials

every bot shares one model credential pool through `omp-auth-broker.service`, which listens on `127.0.0.1:8766`. bots reach it with `OMP_AUTH_BROKER_URL` and the broker token, and never see the underlying credentials. adding an account to the host pool (`omp` on the host, then restart the broker) makes it available to every bot.

## isolation

- `UserNS=keep-id` runs the bot as the invoking uid, so workspace files keep normal ownership. all capabilities are dropped, `no-new-privileges` is set, and the root filesystem is read-only.
- networking is pasta. host loopback is closed except port 8888 (hindsight), 8766 (auth broker), and 9001 (browseros MCP). the tailnet ClickClack URL resolves and connects normally.
- MCP servers come from `/bot/agent/mcp.json` plus the project's own `.mcp.json`. OAuth credentials come from the shared auth broker.
- each bot gets exactly one Linear workspace. `clickclack`, `kassette`, and `pi` define `linear` with the host's URL-keyed login (`/mcp reauth linear` in the host omp), which is the kasAI workspace. `utmco` defines only `linear-utmco` with `auth.credentialId` `mcp_oauth_linear-utmco` (the Utmco workspace). `matchfi` defines only `linear` with `auth.credentialId` `mcp_oauth_linear-matchfi` (the MatchFi workspace).
- all three workspaces share the URL `https://mcp.linear.app/mcp`, so the per-workspace logins can't use `/mcp reauth`, which always writes the URL-keyed row and would replace the kasAI login. they're named rows in the host auth store, and the broker refreshes them like any `mcp_oauth_*` row. omp falls back to the URL-keyed row when a named `credentialId` is missing, so a bot must not reference a named row that doesn't exist yet, or it silently gets kasAI.
- `mcp_oauth_linear-utmco` was imported from pi's keyring entry (`pi-mcp-adapter.oauth`, account `linear-utmco`). the import rotated the refresh token, so a pi rollback needs `/mcp reauth linear-utmco` in pi.
- `mcp_oauth_linear-matchfi` came from a fresh OAuth login with its own client registration. a disabled row left under the same credential id (here, a dead import of codex's `linear_matchfi` login) made omp fall back to kasAI. removing the id and setting it again from the active row fixed it.
- `matchfi-replit/.mcp.json` declares kasmos and playwright. the `matchfi` and `pi` bots list both in `disabledServers` in their `/bot/agent/mcp.json`. browseros covers browser work, and the image ships no browser. that hides them without changing the project's file.
- ClickClack permissions are enforced server-side by each bot's own token. the private `HOME` is a storage boundary, not the security boundary; the mount set is.

## limits

per bot, from the quadlet: 2 CPUs, 4 GiB memory with no swap, 1024 processes, 60 MB/s writes, 200 MB/s reads, and 2000 write IOPS on `/dev/nvme0n1`.

all bots together, from `omp-clickclack.slice`: 600% CPU, 16 GiB memory, 4096 tasks, 120 MB/s writes, 400 MB/s reads, and 4000 write IOPS.

the io limits are byte limits at the block layer. on btrfs with zstd compression, compressible writes (for example zeros) reach the disk as far fewer bytes, so throughput tests must use incompressible data.

`deploy/preflight.sh` runs before every start. it refuses to start a bot when less than 50 GiB is free under its tree or btrfs metadata is above 95% used. override with `OMP_CLICKCLACK_MIN_FREE_GIB` and `OMP_CLICKCLACK_MAX_METADATA_PCT`.

## checks before cutover

run these against the release image with the bot's real quadlet flags (`/usr/lib/podman/quadlet -dryrun -user` prints the `podman run` line) and a scratch copy of the bot tree mounted at `/bot`:

- `scripts/smoke/extension-probe.ts`, copied into the scratch tree's `tmp/` next to a `node_modules` symlink to `/opt/omp-clickclack/node_modules`. it runs real turns through the extension set: extension init, a forced `ctx_execute` call, a compaction, and a follow-up turn. compare a file listing of the writable mounts from before and after to confirm every write stays under `/bot`.
- reopen each migrated session through the bridge's `createEmbeddedPiRuntime` against the rehearsal copy, and continue one bound session with a prompt.
- run a noisy workload under `systemd-run --user --slice omp-clickclack.slice -p Delegate=yes podman run …` and confirm the cgroup caps CPU, memory (OOM kill at the limit), pids, and incompressible writes, while the other bots stay up.

## migrating a pi-clickclack bot

1. create the bot tree and env file (above), and install the quadlet with `Image=` set to the release tag.
2. rehearse: `bun scripts/migrate-from-pi.ts ~/.local/state/pi-clickclack/<bot>.sqlite /tmp/<dir>/<bot> --rehearsal`. this reads the live database without writing it.
3. `systemctl --user disable --now pi-clickclack-<bot>.service`, so the old bridge doesn't come back on reboot. the multi-project `pi` bot ran as `pi-clickclack.service` from `~/.local/state/pi-clickclack/state.sqlite`.
4. `bun scripts/migrate-from-pi.ts ~/.local/state/pi-clickclack/<bot>.sqlite ~/.local/share/omp-clickclack/<bot>`. it refuses to run while either service is active or when bot state already exists. it snapshots the bridge database with `VACUUM INTO`, copies every referenced session file with a sha256 check, rewrites references to `/bot/agent/sessions/`, and runs integrity and foreign key checks. pi writes a session file only once the session has content, so references without a file are reported, not copied. omp opens them as new sessions in the container's working directory, which must be the project's directory.
5. `systemctl --user daemon-reload && systemctl --user start omp-clickclack-<bot>.service`.

## rollback

the migration never modifies the old bridge database or session files. to go back:

1. `systemctl --user stop omp-clickclack-<bot>.service`, then move `~/.config/containers/systemd/omp-clickclack-<bot>.container` out of that directory and `systemctl --user daemon-reload`. quadlet units can't be disabled, and the file's `WantedBy=default.target` would start the omp bot again on reboot.
2. copy the omp bot's realtime cursor into the old database, since the old bridge catches up from its own cursor on startup and would otherwise answer messages the omp bot already handled:

   ```sh
   sqlite3 ~/.local/state/pi-clickclack/<bot>.sqlite \
     "attach '$HOME/.local/share/omp-clickclack/<bot>/state/bridge.sqlite' as omp;
      insert into main.realtime_cursor (singleton, cursor, updated_at)
        select 1, cursor, updated_at from omp.realtime_cursor where singleton = 1
        on conflict(singleton) do update set cursor = excluded.cursor, updated_at = excluded.updated_at;"
   ```

3. `systemctl --user enable --now pi-clickclack-<bot>.service`.

turns the omp bot ran after cutover stay in the omp copies of those sessions and aren't carried back. only one of the two services may run at a time, since both answer as the same ClickClack bot.
