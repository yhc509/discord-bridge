# discord-bridge — Claude Code Notes

Discord-to-Claude/Codex bridge. Each Discord channel maps to a workspace; user
messages in mapped channels spawn the workspace provider (`claude -p` or
`codex exec`) as a subprocess per turn. State (session/thread ID) persists in
`state.json` so resumes work across restarts.

## Stack

- Node 22+ / TypeScript / `discord.js` v14
- Claude Code CLI (`claude -p`) — **not** the Anthropic SDK (the CLI forces
  the OAuth subscription quota; SDK is API-key only)
- Codex CLI (`codex exec`) for `provider: "codex"` workspaces
- Process supervisor: tmux + launchd one-shot (see "Operations" below)

## Layout

- `src/bot.ts` — Discord gateway, command dispatch, message handler, shutdown
- `src/session/` — `invoke()` spawn, stream parser, `SessionManager` (per-workspace queue)
- `src/commands/` — slash commands
- `src/stream.ts` — Discord message chunking/streaming
- `src/voice.ts` — optional Discord audio transcription via local whisper or
  a LAN HTTP transcribe server
- `scripts/launchd-supervisor.sh` — launchd entry point (one-shot)
- `scripts/run-bot-loop.sh` — in-tmux restart loop
- `scripts/bind-workspace` — bind a manually created Discord channel to
  `~/Dev/<channel-name>`
- `launchd/com.example.discord-bridge.plist` — template for
  `~/Library/LaunchAgents/`
- `dist/` — tsc build output (runtime loads from here, **not** src)
- `config.json` — local runtime config (gitignored; see `config.example.json`)

## Build & Run

```bash
npm install
npm run build          # tsc → dist/
```

For local development only (not via launchd):

```bash
node dist/bot.js
```

## Operations (production: macOS launchd + tmux)

### Why tmux? — macOS launchd inefficiency killer

macOS aggressively SIGTERMs `KeepAlive=true` LaunchAgents that stay running
long-term, logging `This service is defined to be constantly running and is
inherently inefficient`. `ProcessType=Background`/`Interactive`/`LegacyTimers`
/`NSAppSleepDisabled` do **not** fully suppress this — the service is still
killed every 30–200 seconds. Mid-request kills propagate SIGTERM to the
spawned `claude` child, which then surfaces to Discord as
`❌ error claude exited with code 143`.

Fix: launchd only manages a **short-lived** supervisor. The actual node bot
runs inside a **tmux session** whose parent is the tmux server, not launchd.
launchd's inefficiency heuristic never applies because its job exits within
a second.

### Process tree

```
launchd (every 60s, RunAtLoad + StartInterval)
 └── scripts/launchd-supervisor.sh         ← exits immediately
      └── tmux new-session -d discord-bridge
           └── (tmux server, detached from launchd)
                └── scripts/run-bot-loop.sh
                     └── while true; do node dist/bot.js; sleep 5; done
```

`AbandonProcessGroup=true` in the plist keeps the tmux server alive after
supervisor exits.

### Install / one-time setup

```bash
# 1. Build
npm run build

# 2. Copy plist
install -m 0600 launchd/com.example.discord-bridge.plist \
  ~/Library/LaunchAgents/

# 3. Ensure tmux is installed
brew install tmux

# 4. Load the agent
launchctl bootstrap gui/$(id -u) \
  ~/Library/LaunchAgents/com.example.discord-bridge.plist
```

### Daily commands

| Action | Command |
| --- | --- |
| Attach to live bot output | `tmux -L discord-bridge attach -t discord-bridge` (Ctrl-b d to detach) |
| List tmux sessions | `tmux -L discord-bridge ls` |
| Bind a new channel | `npm run bind-workspace -- --channel-id CHANNEL_ID` then rerun with `--apply` |
| Rebuild + restart bot | `npm run build && tmux -L discord-bridge kill-session -t discord-bridge` (supervisor restarts it within ≤60s, or run `bash scripts/launchd-supervisor.sh` for immediate restart) |
| Force immediate restart | `bash scripts/launchd-supervisor.sh` |
| Trigger supervisor via launchd | `launchctl kickstart gui/$(id -u)/com.example.discord-bridge` |
| Full stop | `launchctl bootout gui/$(id -u)/com.example.discord-bridge && tmux -L discord-bridge kill-session -t discord-bridge` |
| Check status | `launchctl print gui/$(id -u)/com.example.discord-bridge \| grep -E "state\|last exit"` + `tmux -L discord-bridge ls` + `pgrep -fl "dist/bot"` |

### Logs

- `~/Library/Logs/discord-bridge/bot.log` — timestamped bot output (tee'd from tmux pane)
- `~/Library/Logs/discord-bridge/supervisor.log` — supervisor ticks / bot restart events
- `~/Library/Logs/discord-bridge/launchd.{out,err}.log` — launchd-supervisor stdio
- tmux scrollback — live bot output, accessible via `tmux -L discord-bridge attach`

### Config

Runtime config at `<repo>/config.json` (0600,
gitignored). Required keys: `workspaces[]` (channel_id / cwd / optional
provider), `discord.{bot_token, guild_id, user_allowlist}`,
`claude.{binary, permission_mode, output_format}`. Optional:
`discord.notify_channel_name`
(default `discord-bridge`), `claude.{model, effort, timeout}` (defaults
`claude-opus-4-6[1m]` / `high` / `600000`), `codex.{binary, model, timeout,
sandbox_mode, approval_policy}` (defaults `codex` / `gpt-5.5` / `600000` /
the values defined in `src/config.ts`).

Optional voice input is configured under `voice`. `provider: "local"` runs
`ffmpeg` and `whisper-cli` on the bridge host. `provider: "http"` sends audio to
a compatible `/transcribe` endpoint, intended for a MacBook bridge that offloads
transcription to a Mac mini. `voice.server.enabled` exposes that endpoint from a
local bridge process; non-loopback hosts require `voice.server.token`.

`npm run bind-workspace -- --channel-id CHANNEL_ID` fetches the real Discord
channel name and derives `workspace.name` and `cwd` as `~/Dev/<channel-name>`.
The channel name is only captured at bind time; later Discord renames do not
auto-update `config.json`.

## Development notes

- `claude -p` is invoked per turn. Subsequent turns use `--continue` (or
  `--resume <sessionId>` after a restart, via `state.json`).
- `bypassPermissions` mode is used; denials come through
  `result.permission_denials[]` (formal) rather than text heuristics.
- Session manager keeps a per-workspace queue (max 3 pending). Queued turns
  carry their `channel + userMessage` context so output routes back to the
  originating channel.
- `bot.ts` shutdown handler intentionally does **not** kill claude children
  — if the bot is SIGTERM'd, the child orphans and exits on SIGPIPE; this
  prevents the `code 143` error from reaching Discord.
- Never commit `config.json`, `config.json.bak.*`, or anything containing the
  bot token.

## Known issues / backlog

Keep deployment-specific work queues and decision logs outside the public repo.
