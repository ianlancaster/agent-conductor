# agent-conductor

A lightweight supervisor for terminal coding agents — Claude Code and OpenAI Codex — that
gives them powerful communication primitives: authenticated inter-agent messaging, an
event-driven health system with an agent-based stall sentinel, remote operator channels,
and cron scheduling. One process, panes in iTerm2 or tmux.

## Why

Running one coding agent is easy. Running a fleet surfaces three problems nothing else solves
together:

1. **Who said what?** Agents coordinating over keystrokes or self-declared names can
   impersonate each other. Here, every agent gets its own MCP URL (`/mcp/<codename>`) —
   the conductor derives identity from the connection, so identity is unforgeable.
2. **Who's stuck?** Runtimes push lifecycle events (Claude Code hooks, Codex `notify`) to the
   conductor; a pane-diff watchdog catches what events miss. Every stall of an autonomous
   agent is routed to a **stall sentinel** — an agent you designate — which reads the pane and
   decides: nudge with a precise instruction, dismiss, or escalate to you.
3. **Where's the operator?** Channel adapters (Telegram today; the interface is small) give
   you full fleet control from anywhere: status, start/stop, messaging, mode changes, and
   answer-with-a-button escalations.

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
conductor init --agent alpha --repo ~/code/my-project   # any project dir the agent will work in
conductor validate                  # catches config mistakes before launch
conductor start                     # foreground, with an interactive console
```

`init` writes a minimal commented `config/supervisor.yaml` (every setting is optional —
ports and names are derived per fleet dir) and `config/agents/alpha.yaml`. The full
reference config with every knob lives in `examples/supervisor.yaml`.

At the `conductor>` prompt, type `/help`. `/start alpha` opens an iTerm2 (or tmux) pane
running Claude Code wired to the conductor; `/tell alpha <message>` talks to it;
`/status` shows the fleet. Agent YAMLs hot-reload — drop a new file in `config/agents/`
and it registers itself, no restart.

**New here? Follow [docs/getting-started.md](docs/getting-started.md)** — a step-by-step
first run (single agent → sentinel → Telegram) with the shakedown order that surfaces
problems early.

## Concepts

| Term                 | Meaning                                                                                                                                                                                                                         |
| -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Runtime**          | The agent CLI: `claude-code` or `codex`. Owns launch flags, identity wiring, lifecycle-event parsing.                                                                                                                           |
| **Terminal backend** | Where panes live: `iterm` (macOS, focus tracking) or `tmux` (headless, SSH, Linux).                                                                                                                                             |
| **Channel**          | An operator surface: the built-in console, Telegram, more via `ChannelAdapter`.                                                                                                                                                 |
| **Autonomy**         | `facilitated` — you drive; stalls are ignored. `autonomous` — stalls route to the sentinel.                                                                                                                                     |
| **Sentinel**         | The agent designated in `sentinel.codename`. Receives every stall with pane capture + last message; resolves with `nudge` / `suppress` / `escalate`. The conductor watches the watcher: a stalled sentinel alerts you directly. |
| **Agent project**    | A repo containing the marker file (`.conductor-agent`) — flagged 🤖 in status. Display-only.                                                                                                                                    |

## Operator commands

Same language everywhere (console, `conductor cmd`, Telegram):

```
/status [agent]            /start <agent|all> [--tab|--window]
/talk <agent>              /continue <agent|all>
/tell <agent> <msg>        /stop <agent|all>
/broadcast <msg>           /tail <agent> [lines]
/auto <agent|all>          /pause | /resume <agent|all>
/facilitated <agent|all>   /tag <agent> [text]
/spawn <name> [--worktree <repo>] [--branch <b>] [--model m] [--prompt "…"]
/teardown <name> [--delete]
/answer <id> <text>        /autopause [on|off]
```

## Agent-facing MCP tools

`send_to_agent` · `broadcast` (sparingly) · `notify_agents` · `respond_to_user` ·
`request_human_input` · `start_agent` / `stop_agent` / `continue_agent` ·
`spawn_agent` / `teardown_agent` · `create_worktree` / `remove_worktree` ·
`set_autonomy` · `set_tag` / `get_tag` · `whoami` · `list_agents` / `get_agent_status` /
`agent_exists` · `tail_agent` · `type_in_pane` · `request_restart`

Sentinel-only: `get_stall_queue` · `resolve_stall` · `answer_human_input`.

## Worktrees

`/spawn reviewer --worktree ../my-project --branch review-pass` gives an agent a git
worktree of an existing repo: instant, fully isolated working directory, same object store,
branches visible across the fleet without pushing. Separate clones work exactly as well —
worktrees are the fast path, not a requirement. `remove_worktree` / `--delete` refuses
dirty worktrees.

## Telegram

Set `CONDUCTOR_TELEGRAM_TOKEN` and `CONDUCTOR_TELEGRAM_CHAT_ID` (create a bot with
@BotFather). Every command above works remotely; escalations and human-input requests
arrive with inline buttons.

## Security posture

The MCP/events/command surface binds to `127.0.0.1` only and rejects any request
carrying a browser `Origin`/`Referer` header, so a web page you visit cannot drive your
fleet. Identity is mechanical (the codename comes from the URL path the agent was
configured with). There is no per-agent bearer auth yet — a _different_ local process
could still assume a codename; hardening that is planned alongside the cross-machine relay.
Run the conductor only on a trusted machine.

Codex agents each get an isolated `CODEX_HOME` (under the conductor's data dir) so
`resume` only ever sees that agent's own sessions; your shared `auth.json`/`config.toml`
are symlinked in, so login still works. Codex protocol injection writes
`AGENTS.override.md` into each agent's repo — **add it to that repo's `.gitignore`.**

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
`AgentRuntime`, `ChannelAdapter`) have in-memory fakes under `test/fakes/` — new backends,
runtimes, and channels get the whole core test suite for free.

## License

MIT
