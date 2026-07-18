# agent-conductor

A lightweight supervisor for terminal coding agents — Claude Code and OpenAI Codex — that
gives them powerful communication primitives: authenticated inter-session messaging, an
event-driven health system with a session-based stall sentinel, remote operator channels,
and cron scheduling. One process, panes in iTerm2 or tmux.

## Why

Running one coding agent is easy. Running a fleet surfaces three problems nothing else solves
together:

1. **Who said what?** Sessions coordinating over keystrokes or self-declared names can
   impersonate each other. Here, every session gets its own MCP URL (`/mcp/<codename>`) —
   the conductor derives identity from the connection, so identity is unforgeable.
2. **Who's stuck?** Runtimes push lifecycle events (Claude Code hooks, Codex `notify`) to the
   conductor; a pane-diff watchdog catches what events miss. Every stall of an autonomous
   session is routed to a **stall sentinel** — a session you designate — which reads the pane and
   decides: nudge with a precise instruction, dismiss, or escalate to you.
3. **Where's the operator?** Channel adapters (Telegram today; the interface is small) give
   you full fleet control from anywhere: status, start/stop, messaging, and mode changes.
   Sessions message you with `send_to_operator`; you reply with `/tell` — no ceremony.

## Prerequisites

- **Node.js 22+** and **pnpm**
- At least one agent CLI on your `PATH`: **`claude`** (Claude Code) and/or **`codex`** (OpenAI Codex)
- A terminal backend: **iTerm2** (macOS) or **tmux** (macOS/Linux, headless-capable)
- **`curl`** (used by the lifecycle hooks that drive health monitoring)
- Optional: a **Telegram** bot token + chat id for remote control

## Install

Not yet published to npm — run from a checkout. From the `agent-conductor` repo:

```bash
pnpm install
pnpm build            # compiles to dist/
pnpm link --global    # puts `conductor` on your PATH
```

Now `conductor` works anywhere. (Prefer not to link? Use
`pnpm --dir <repo> cli -- <args>`, or `npx tsx <repo>/src/cli/index.ts <args>`. Every command
also accepts `-C, --dir <fleet-dir>` so you needn't be inside the fleet directory.)

## Quick start

A "fleet directory" holds your `config/`. Scaffold one:

```bash
mkdir ~/fleet && cd ~/fleet
conductor init --session alpha --repo ~/code/my-project   # any project dir the session will work in
conductor validate                  # catches config mistakes before launch
conductor start                     # this terminal becomes the conductor> console
```

`init` writes a minimal commented `config/supervisor.yaml` (every setting is optional —
ports and names are derived per fleet dir) and `config/sessions/alpha.yaml`. The full
reference config with every knob lives in `examples/supervisor.yaml`.

`start` boots the conductor as a hidden background process (terminal output in
`data/conductor.out.log`, structured log in `data/conductor.log`) and turns the current
terminal into the operator console. Closing the console stops the conductor. At the
`conductor>` prompt, type `/help`. `/start alpha` opens a pane running Claude Code —
in this same window on iTerm2 — wired to the conductor; `/tell alpha <message>` talks
to it; `/status` shows the fleet. Messages sessions send you (`send_to_operator`,
stall reports) print live above the prompt with a cyan `[Message from <name>]`
signature. Session YAMLs hot-reload — drop a new file in `config/sessions/` and it
registers itself, no restart.

Two variants: `conductor console` attaches a second console to a running conductor
(exiting it does NOT stop anything), and `conductor start --foreground` runs the
supervisor visibly in the current terminal (the log feed — what daemons use).

**New here? Follow [docs/getting-started.md](docs/getting-started.md)** — a step-by-step
first run (single session → sentinel → Telegram) with the shakedown order that surfaces
problems early.

## Concepts

| Term                 | Meaning                                                                                                                                                                                                                           |
| -------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Session**          | The managed unit: a codename + a working directory + a runtime, living in a pane. Defined by a YAML in `config/sessions/` or created on the fly with `/spawn`.                                                                    |
| **Run**              | One launch of a session's CLI (start → stop). A session accumulates many runs; `continue` resumes the previous run's conversation.                                                                                                |
| **Runtime**          | The agent CLI: `claude-code` or `codex`. Owns launch flags, identity wiring, lifecycle-event parsing.                                                                                                                             |
| **Terminal backend** | Where panes live: `iterm` (macOS, focus tracking) or `tmux` (headless, SSH, Linux).                                                                                                                                               |
| **Channel**          | An operator surface: the built-in console, Telegram, more via `ChannelAdapter`.                                                                                                                                                   |
| **Autonomy**         | `facilitated` — you drive; stalls are ignored. `autonomous` — stalls route to the sentinel.                                                                                                                                       |
| **Sentinel**         | The session designated in `sentinel.codename`. Receives every stall with pane capture + last message; resolves with `nudge` / `suppress` / `escalate`. The conductor watches the watcher: a stalled sentinel alerts you directly. |
| **Agent project**    | A repo containing the marker file (`.conductor-agent`) — flagged 🤖 in status. Distinguishes purpose-built agents from sessions doing ordinary work in ordinary repos. Display-only.                                              |

## Operator commands

Same language everywhere (`conductor console`, `conductor cmd`, Telegram):

```
/status [session]            /start <session|all> [placement]
/talk <session>              /continue <session|all> [placement]
/tell <session> <msg>        /stop <session|all>
/broadcast <msg>             /tail <session> [lines]
/auto <session|all>          /pause | /resume <session|all>
/facilitated <session|all>   /tag <session> [text]
/spawn <name> [flags] [placement]
    -r/--runtime <claude-code|codex>   runtime (default claude-code)
    -m/--model <model>                 model override
    -p/--prompt "…"                    initial prompt
    -d/--path <dir>                    working dir (default spawn.dirPattern —
                                       ./<name> inside the fleet dir; set
                                       '../{codename}' for siblings)
    -w/--worktree <repo>               create the dir as a git worktree of repo
    -b/--branch <name>                 worktree branch (default: the codename)
/teardown <name> [-D/--delete]
/autopause [on|off]

placement (anywhere it appears): -P/--pane (default) · -T/--tab · -W/--window
```

## Session-facing MCP tools

`send_to_session` · `broadcast` (sparingly) · `notify_sessions` · `send_to_operator` ·
`start_session` / `stop_session` / `continue_session` ·
`spawn_session` / `teardown_session` · `create_worktree` / `remove_worktree` ·
`set_autonomy` · `set_tag` / `get_tag` · `whoami` · `list_sessions` / `get_session_status` /
`session_exists` · `tail_session` · `type_in_pane` · `request_restart`

Sentinel-only: `get_stall_queue` · `resolve_stall`.

## Worktrees

`/spawn reviewer --worktree ../my-project --branch review-pass` gives a session a git
worktree of an existing repo: instant, fully isolated working directory, same object store,
branches visible across the fleet without pushing. Separate clones work exactly as well —
worktrees are the fast path, not a requirement. `remove_worktree` / `--delete` refuses
dirty worktrees.

## Telegram

Set `CONDUCTOR_TELEGRAM_TOKEN` and `CONDUCTOR_TELEGRAM_CHAT_ID` (create a bot with
@BotFather). Every command above works remotely; sentinel escalations and
`send_to_operator` messages arrive as signed messages.

## Security posture

The MCP/events/command surface binds to `127.0.0.1` only and rejects any request
carrying a browser `Origin`/`Referer` header, so a web page you visit cannot drive your
fleet. Identity is mechanical (the codename comes from the URL path the session was
configured with). There is no per-session bearer auth yet — a _different_ local process
could still assume a codename; hardening that is planned alongside the cross-machine relay.
Run the conductor only on a trusted machine.

Codex sessions each get an isolated `CODEX_HOME` (under the conductor's data dir) so
`resume` only ever sees that session's own history; your shared `auth.json`/`config.toml`
are symlinked in, so login still works. Codex protocol injection writes
`AGENTS.override.md` into each session's repo — **add it to that repo's `.gitignore`.**

## Running headless

`terminal.backend: tmux` runs the whole fleet detached — a Linux box over SSH works.
`conductor daemon install` sets up launchd (macOS) or a systemd user unit (Linux).

## Running multiple fleets

Each fleet directory is a fully independent conductor — run as many as you like at once.
The instance-scoped defaults (MCP port, tmux session name, window title, daemon service
name) are derived from the fleet directory path, so two fleets never collide and the
values stay stable across restarts. Set `mcp: port:` / `terminal: tmux: sessionName:`
explicitly only if you want specific values. Two things to know:

- **One conductor per fleet directory** — a pid lockfile (`data/conductor.lock`) makes a
  second `conductor start` in the same fleet dir refuse with a clear error.
- **Telegram needs one bot token per fleet.** Telegram allows a single poller per token;
  a second conductor on the same token logs a 409 conflict until you give it its own
  token (or disable telegram for that fleet).

## Development

```bash
pnpm install
pnpm typecheck && pnpm lint && pnpm format:check && pnpm test
```

Architecture and design history live in `docs/`. The three seams (`TerminalBackend`,
`SessionRuntime`, `ChannelAdapter`) have in-memory fakes under `test/fakes/` — new backends,
runtimes, and channels get the whole core test suite for free.

## License

MIT
