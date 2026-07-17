# Getting Started

A step-by-step first run. It builds up in the order that surfaces problems early:
one hand-driven agent, then autonomous mode with a sentinel, then remote control.
Do them in order — each step assumes the previous one worked.

Prerequisites and install are in the [README](../README.md). This guide assumes
`conductor` is on your PATH and you have a fleet directory (`~/fleet` below) with a
`config/` inside it.

---

## Step 0 — Anatomy of a fleet directory

```
~/fleet/
├── config/
│   ├── supervisor.yaml        # global settings
│   └── agents/
│       ├── alpha.yaml         # one file per agent (hot-reloaded)
│       └── watch.yaml         # the stall sentinel (later)
├── prompts/                   # optional: agent-specific instructions
│   └── sentinel.md
└── data/                      # created on first run — SQLite, logs, per-agent config
```

Everything is relative to the fleet directory. Run `conductor` from inside it, or pass
`-C ~/fleet` from anywhere.

---

## Step 1 — One facilitated agent (the shakedown)

Start here even if your goal is full autonomy. **Facilitated** mode means _you_ drive:
the conductor launches the agent and relays your messages, but does not nudge it. This
isolates the terminal/launch machinery from the health/sentinel machinery, so if
something is wrong with your iTerm2 or `claude` setup you find out cleanly.

1. Create `config/agents/alpha.yaml`:

   ```yaml
   codename: alpha
   repo: /absolute/path/to/some/project # a real repo you don't mind an agent touching
   runtime: claude-code
   # model: claude-opus-4-6               # optional
   ```

2. Confirm defaults are facilitated in `config/supervisor.yaml` (they are unless you
   changed them): `defaults.autonomy: facilitated`.

3. Launch:

   ```bash
   cd ~/fleet
   conductor validate      # expect: Config OK.
   conductor start
   ```

   A new iTerm2 window (or tmux session) appears. At the `conductor>` prompt:

   ```
   /start alpha            # opens a pane, launches `claude` in your repo
   /status                 # 🟢 alpha [facilitated]
   /tell alpha summarize what this project does
   /tail alpha 40          # see the agent's pane contents
   /stop alpha
   ```

   `/tell` delivers your message into the agent's pane. The agent replies **in its own
   pane** (watch it in iTerm2). To have replies come back to _you_ over a channel, that's
   Telegram (Step 3).

**If this step fails**, it's almost always one of: `claude` not on PATH, the `repo:` path
doesn't exist, or iTerm2 automation permission (macOS will prompt the first time
`osascript` drives iTerm2 — approve it). Check `conductor logs` and `data/conductor.log`.

---

## Step 2 — Autonomous mode with a stall sentinel

Autonomous agents run unattended. When one stalls (finishes a turn, blocks on a prompt,
compacts, or wedges), the conductor routes the stall to the **sentinel** — an agent you
designate — which decides whether to nudge, dismiss, or escalate to you. Without a
sentinel, autonomous agents are unsupervised (and the conductor warns you).

1. Give the sentinel its instructions. Copy the shipped prompt into your fleet:

   ```bash
   mkdir -p ~/fleet/prompts
   cp "$(npm root -g)/agent-conductor/prompts/sentinel.md" ~/fleet/prompts/sentinel.md
   ```

2. Create `config/agents/watch.yaml`:

   ```yaml
   codename: watch
   repo: /absolute/path/to/a/scratch/dir # the sentinel needs its own working dir
   runtime: claude-code
   systemPromptFile: ./prompts/sentinel.md # <- this is what makes it act as the sentinel
   ```

3. Point the supervisor at it. In `config/supervisor.yaml`:

   ```yaml
   sentinel:
     codename: watch
   ```

4. Restart the conductor (supervisor.yaml is not hot-reloaded; agent files are):

   ```
   /start watch            # bring the sentinel up first
   /auto alpha             # alpha is now autonomous
   /tell alpha <a real, multi-step task>
   ```

   When `alpha` finishes a turn or gets stuck, the conductor sends the sentinel a
   `[Stall]` message; the sentinel calls `get_stall_queue`, reads alpha's pane and last
   message, and either nudges alpha (`resolve_stall` with an instruction), dismisses it,
   or escalates to you. Watch both panes to see it happen. `conductor logs alpha` shows
   the `stall_routed` / `stall_nudged` trail.

**Key idea:** the conductor never uses an LLM itself — all judgment lives in the sentinel
agent. If the sentinel itself stalls or isn't running, the conductor alerts you directly.

---

## Step 3 — Remote control over Telegram

1. Create a bot with [@BotFather](https://t.me/BotFather), copy the token.
2. Get your chat id: message your bot, then open
   `https://api.telegram.org/bot<TOKEN>/getUpdates` and read `message.chat.id`.
3. Put both in the environment (a `.env` you source, or your shell profile):

   ```bash
   export CONDUCTOR_TELEGRAM_TOKEN=123456:abc...
   export CONDUCTOR_TELEGRAM_CHAT_ID=987654321
   ```

4. Restart `conductor start`. The log shows `Telegram channel connected.`

Now every operator command works from your phone: `/status`, `/tell alpha …`, `/auto`,
`/pause`, etc. When an agent calls `request_human_input`, or the sentinel escalates, you
get a message with inline buttons — tap to answer. Agents reply to you with the
`respond_to_user` tool (this is why an agent's terminal reply doesn't reach your phone
unless it uses that tool — the conductor protocol prompt tells it to).

---

## Step 4 — Scheduling, spawning, worktrees (as needed)

- **Scheduled prompts**: add a `schedules:` block to an agent (see
  [examples/agents/example-claude.yaml](../examples/agents/example-claude.yaml)).
- **Spawn a throwaway agent**: `/spawn scratch --prompt "investigate X"` — makes a
  directory, registers a config, starts it. `/teardown scratch --delete` reverses it.
- **Worktree agents** (parallel work on one repo): `/spawn reviewer --worktree
/path/to/repo --branch review-pass`. Full file isolation, shared git history.
  `remove_worktree` / `--delete` refuses a dirty worktree.
- **Codex agents**: set `runtime: codex`. The conductor writes `AGENTS.override.md` into
  the agent's repo to inject the protocol — **add `AGENTS.override.md` to that repo's
  `.gitignore`.** Each codex agent gets an isolated `CODEX_HOME` so sessions don't cross.

---

## Running unattended (headless / daemon)

- **tmux backend** (`terminal.backend: tmux` in supervisor.yaml) runs with no GUI — works
  over SSH on a Linux box. `conductor start --no-console --start-all` starts every agent
  and skips the interactive prompt.
- **As a service**: `conductor daemon install` writes a launchd (macOS) or systemd-user
  (Linux) unit that keeps the conductor running across logins. `conductor daemon
uninstall` removes it. (Requires `pnpm build` + `pnpm link --global` first, so the
  service runs the compiled binary.)
- **Multiple fleets**: just use separate fleet directories — ports, tmux session names,
  and daemon service names are derived per fleet dir, so nothing collides. Telegram
  needs a distinct bot token per fleet (Telegram allows one poller per token).

## Command reference

`/help` lists everything in the console. Full reference is in the [README](../README.md).
Every command works identically in the console, via `conductor cmd '<command>'`, and over
Telegram.

## Troubleshooting

| Symptom                                                | Likely cause                                                                          |
| ------------------------------------------------------ | ------------------------------------------------------------------------------------- |
| `command not found: conductor`                         | `pnpm link --global` not run, or use `-C`/`npx tsx` (README Install)                  |
| `conductor validate` says OK but nothing is configured | You ran it outside the fleet dir — `cd` in, or pass `-C ~/fleet`                      |
| Pane never launches / hangs on start                   | `claude`/`codex` not on PATH, or bad `repo:` path                                     |
| macOS dialog on first start                            | iTerm2 automation permission — approve it (System Settings → Privacy → Automation)    |
| Autonomous agent stalls but nothing happens            | No sentinel configured/running, or the sentinel lacks `systemPromptFile`              |
| Agent replies in its pane but not on Telegram          | Expected — it must use `respond_to_user`; check the protocol prompt is being injected |
