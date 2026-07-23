# Getting Started

A step-by-step first run. It builds up in the order that surfaces problems early:
one hand-driven session, then auto stall handling with a sentinel, then remote control.
Do them in order — each step assumes the previous one worked.

Prerequisites and install are in the [README](../README.md). This guide assumes
`conductor` is on your PATH. Create a fleet directory and start it:

```bash
mkdir ~/fleet && cd ~/fleet
conductor start
```

The first start creates every missing fleet scaffold file automatically, then opens the operator console.
Existing configuration and secrets are never overwritten. A new `supervisor.yaml` records the complete
effective defaults, including the values derived for this fleet and disabled Telegram and Slack blocks.

---

## Step 0 — Anatomy of a fleet directory

```
~/fleet/
└── .conductor/
    ├── env.template           # public copy of the environment-variable stubs
    ├── .env                   # owner-only, gitignored fleet secrets with inert stubs
    ├── .gitignore             # ignores only .env and data/
    ├── config/
    │   ├── supervisor.yaml    # fleet-wide settings
    │   └── sessions/
    │       ├── alpha.yaml     # one file per session (hot-reloaded)
    │       └── watch.yaml     # the stall sentinel (later)
    ├── prompts/               # optional: session-specific instructions
    │   └── sentinel.md
    └── data/                  # created on first run — SQLite, logs, per-session runtime config
```

Everything is relative to the fleet directory. Run `conductor` from inside it, or pass
`-C ~/fleet` from anywhere.

`supervisor.yaml` configures the whole fleet: terminal backend, defaults, channels, health policy, and
runtime hints. It is not tied to the agent you want to message. Each managed agent has its own YAML file
under `.conductor/config/sessions/`; `repo:` in that file selects the project directory where it works.

### Existing root-level fleets

Releases before the hidden layout used root-level `config/`, `data/`, `.env`, and `env.template` paths.
Those fleets remain supported in place. Conductor refuses to guess if both root-level and `.conductor/`
configuration exist.

To migrate, first stop the Conductor completely—close its owning console, or uninstall/stop its daemon—so
the SQLite database has no live lock or WAL writer. Then, from the fleet directory:

```bash
mkdir -p .conductor
mv config .conductor/config
[ ! -d data ] || mv data .conductor/data
[ ! -f env.template ] || mv env.template .conductor/env.template
[ ! -f .env ] || mv .env .conductor/.env # only if this is Conductor's fleet env
```

Run `conductor validate` before starting it again. The next `conductor start` fills in any scaffold files
that are still missing. Never copy or move `data/` while the old Conductor is running.

---

## Optional — richer runtime status lines

This is not part of fleet startup. If you want richer footers in managed Claude Code
and Codex panes, run the opt-in user setup once:

```bash
conductor statusline
```

It preserves unrelated runtime settings. New sessions use the configured lines immediately;
restart an already-running session to pick them up. See the README for the fields each runtime
can display.

---

## Step 1 — One hand-driven session (the shakedown)

Start here even if your goal is unattended operation. Auto is off by default, so _you_ drive:
the conductor launches the session and relays your messages, but does not route its stalls. This
isolates the terminal/launch machinery from the health/sentinel machinery, so if
something is wrong with your iTerm2 or `claude` setup you find out cleanly.

1. At the `conductor>` prompt opened above, register and start a session in a real repo you don't mind it
   touching:

   ```text
   /spawn alpha --path /path/to/some/project
   ```

   That writes `.conductor/config/sessions/alpha.yaml` and starts the session. Open the YAML to see the
   optional knobs (`runtime: codex`, `model:`, `effort:`, `schedules:`).

   To use Codex immediately, add `--runtime codex` to `/spawn`. To make it the fleet default, set
   `defaults.runtime: codex` in `.conductor/config/supervisor.yaml` and restart before spawning;
   a session-level `runtime` still overrides it.

2. Leave auto off for the shakedown (the default). To make the default explicit in
   `.conductor/config/supervisor.yaml`, use `defaults.auto: false`.

3. Exercise the session from the same `conductor>` prompt:

   ```
   /status                 # "Sessions:" then "  alpha - CC · 🟢 working"
   /tell alpha summarize what this project does
   /tail alpha 40          # see the session's pane contents
   /stop alpha
   ```

   On iTerm, session panes open **in this same window**, beside the console. Process
   output lives in `.conductor/data/conductor.out.log` (`conductor start --foreground` runs it
   visibly instead; `conductor console` attaches an extra console from elsewhere).

   `/tell` delivers your message into the session's pane. The session replies **in its own
   pane** unless it uses `send_to_operator`; that tool sends its reply to every connected
   operator adapter, including the local console and any enabled Telegram or Slack channel.

**If this step fails**, it's almost always one of: `claude` not on PATH, the `repo:` path
doesn't exist, or iTerm2 automation permission (macOS will prompt the first time
`osascript` drives iTerm2 — approve it). Check `conductor logs` and
`.conductor/data/conductor.log`.

---

## Step 2 — Auto stall handling with a sentinel

Auto sessions run unattended. When one stalls (finishes a turn, blocks on a prompt,
compacts, or wedges), the conductor routes the stall to the **sentinel** — a session you
designate — which decides whether to nudge, do nothing, or ask you with `send_to_operator`. Without a
sentinel, stall reports go straight to you instead. (The sentinel itself idles between
stalls — that's normal; the conductor only alerts you if a stall can't be delivered
because the sentinel is not running.)

1. Give the sentinel its instructions. Copy the shipped prompt into your fleet:

   ```bash
   mkdir -p ~/fleet/.conductor/prompts
   cp /path/to/agent-conductor/prompts/sentinel.md ~/fleet/.conductor/prompts/sentinel.md
   ```

2. Create `.conductor/config/sessions/watch.yaml`:

   ```yaml
   codename: watch
   repo: /absolute/path/to/a/scratch/dir # the sentinel needs its own working dir
   runtime: claude-code
   systemPromptFile: ./.conductor/prompts/sentinel.md # <- this is what makes it act as the sentinel
   ```

3. Point the supervisor at it. In `.conductor/config/supervisor.yaml`:

   ```yaml
   sentinel:
     codename: watch
   ```

   This is the initial designation. `/sentinel watch` or the `set_sentinel` MCP tool can
   change it immediately; omit the session to clear it. Tool-set choices persist across
   restarts.

4. Restart the conductor (supervisor.yaml is not hot-reloaded; session files are):

   ```
   /start watch            # bring the sentinel up first
   /auto alpha             # turn auto on for alpha
   /tell alpha <a real, multi-step task>
   ```

   When `alpha` finishes a turn or gets stuck, the conductor sends the sentinel ONE
   `[Stall]` message carrying the session, the stall kind, and the (truncated) last
   message alpha stalled on. The sentinel acts with ordinary tools: `tail_session` to
   look deeper, `send_to_session` to nudge, `send_to_operator` to ask you — or does
   nothing if the stall is fine. Watch both panes to see it happen. `conductor logs
alpha` shows the `stall_routed` trail.

**Key idea:** the conductor never uses an LLM itself — all judgment lives in the sentinel
session. The sentinel's own idle state is ignored. If it is not running when another session
stalls, the conductor alerts you directly.

---

## Step 3 — Remote control over Telegram

1. Create a bot with [@BotFather](https://t.me/BotFather), copy the token.
2. Get your chat id: message your bot, then open
   `https://api.telegram.org/bot<TOKEN>/getUpdates` and read `message.chat.id`.
3. Enable the bundled adapter in `.conductor/config/supervisor.yaml`:

   ```yaml
   channels:
     telegram:
       enabled: true
   ```

4. Fill in the Telegram values in the owner-only, gitignored `.conductor/.env` created by
   `conductor start`:

   ```bash
   ${EDITOR:-vi} .conductor/.env
   ```

   ```dotenv
   CONDUCTOR_TELEGRAM_TOKEN=123456:abc...
   CONDUCTOR_TELEGRAM_CHAT_ID=987654321
   ```

   You can instead export the same variables from `.bashrc`, `.zshrc`, CI, or a service
   environment:

   ```bash
   export CONDUCTOR_TELEGRAM_TOKEN=123456:abc...
   export CONDUCTOR_TELEGRAM_CHAT_ID=987654321
   ```

   Inherited variables override `.conductor/.env`. The conductor does not read shell startup files
   directly; launchd and systemd usually do not source them, so fleet `.conductor/.env` is the reliable
   fallback for daemons.

5. Restart `conductor start`. The log shows `telegram channel connected.` Enabling Telegram
   without both non-blank credentials fails at startup with the missing variable names.

Now every operator command works from your phone: `/status`, `/tell alpha …`, `/auto`,
`/pause`, etc. Sessions message you with the `send_to_operator` tool — each message
arrives signed with the sender's codename, and you reply with `/tell <codename> …`.
(This is why a session's terminal output doesn't reach your phone unless it uses that
tool — the conductor protocol prompt tells it to.)

A session can also call `send_to_operator` with an `options` array. Telegram renders inline
buttons; the local console renders numbered `/respond <request-id> <option-number>` commands.

Prefer a private Slack App Home conversation for work fleets? The bundled Slack adapter provides the
same command, talk, notification, and option-button flow over outbound Socket Mode. Follow the
[Slack adapter setup guide](../guides/slack-adapter.md) for its copyable app manifest and least-privilege
configuration.
The first response from any connected operator interface wins and is delivered back to the
requesting session as an ordinary `[Message from operator]` message. This is a communication
primitive, not an approval or execution queue.

---

## Step 4 — Scheduling, spawning, worktrees (as needed)

- **Scheduled prompts**: add a `schedules:` block to a session (see
  [examples/sessions/example-claude.yaml](../examples/sessions/example-claude.yaml)). An inactive
  runtime is restarted automatically; `/pause` suppresses its schedules until `/resume`.
- **Spawn a throwaway session**: `/spawn scratch` makes a directory, registers a config,
  and starts it; then `/tell scratch investigate X` gives it work. `/teardown scratch
--delete` reverses it. Every flag has a short alias (`-r` runtime, `-m` model, `-e` effort, `-d` path,
  `-t` template, `-w` worktree, `-b` branch, `-D` delete; placement `-P`/`-T`/`-W`) — `/help` lists them.
  `--runtime codex` spawns a Codex session instead of Claude Code; `--runtime cc` is shorthand
  for `--runtime claude-code` on spawn, start, and continue commands.
- **Template sessions**: `/spawn researcher --template agent` clones a registered Git source,
  registers the normal session config, and starts it. The `agent` template is configured by
  default; add, replace, or disable entries under `spawn.templates` in
  `.conductor/config/supervisor.yaml`. HTTPS/SSH sources and local paths are supported; an optional
  `ref` selects a branch, tag, or commit. The source remote is named `template`, repository scripts
  are not run, and `--template` cannot be combined with `--worktree`. Template registry changes
  take effect after restarting the conductor. Guarded `/teardown --delete` leaves a template clone
  intact because it is a Git repository.
- **Switch runtime for one run**: the session file remains the default, but `/start alpha
--runtime codex` or `/continue alpha --runtime claude-code` launches that run with the
  other agent. A model configured for the default runtime is ignored during an override so
  the selected runtime can use its own default model. Claude Code and Codex do not share
  conversation history; `continue` resumes the selected runtime's latest conversation.
  `spawn_session.model` advertises the non-exhaustive lists configured under
  `runtimes.claudeCode.availableModels` and `runtimes.codex.availableModels`; unknown model
  strings remain valid for newly released or third-party models. Detailed session status reports
  the model Conductor resolved, or `null` when model selection belongs to the runtime.
- **Pin reasoning effort**: use `/spawn scratch --effort xhigh` for a persisted session default,
  or `/start alpha --effort low` and `/continue alpha --effort max` for one process. MCP callers
  use the same `effort` argument on `spawn_session`, `start_session`, and `continue_session`.
  Values are passed through without validation. Configure fleet defaults and schema hints with
  `defaultEffort` and `availableEfforts` under each runtime. Precedence is per-run, session,
  runtime default, then the CLI's own default; cross-runtime launches do not inherit the other
  runtime's effort. Detailed status reports the resolved effort or `null`.
- **Worktree sessions** (parallel work on one repo): `/spawn reviewer --worktree
/path/to/repo --branch review-pass`. Full file isolation, shared git history.
  The destination follows `spawn.dirPattern` unless `--path` is supplied. A new branch starts
  at the source repo's current `HEAD`; Conductor does not fetch first. Existing branches are
  checked out as-is. Do not `git checkout main` when `main` is already checked out in the source
  worktree—use `origin/main` as a comparison/rebase target instead. Gitignored and untracked
  files (including local settings, secrets, and dependencies) are not copied, so run the repo's
  setup/install steps before build work.
  `/teardown --delete` refuses a dirty worktree and keeps the stopped session registered so you
  can clean it and retry. Successful removal keeps the branch. Git-ignored files do not count as
  dirty; local reports, `.env.local`, and other ignored artifacts are deleted with the worktree.
- **Codex sessions**: set `runtime: codex`. Before every start or continue, the conductor
  ensures `AGENTS.override.md` injects the protocol. Existing tracked instructions are
  preserved; otherwise the generated file is added to the repo's `.gitignore` automatically.
  Each Codex session gets an isolated `CODEX_HOME` so sessions don't cross, plus a mechanically
  scoped Conductor MCP endpoint and lifecycle notify hook.

---

## Running unattended (headless / daemon)

- **tmux backend** (`terminal.backend: tmux` in supervisor.yaml) runs with no GUI — works
  over SSH on a Linux box. `conductor start --foreground --start-all`
  runs the supervisor in the terminal and starts every configured session immediately.
- **As a service**: `conductor daemon install` writes a launchd (macOS) or systemd-user
  (Linux) unit that keeps the conductor running across logins. `conductor daemon
uninstall` removes it. (Requires `pnpm build` + `pnpm link --global` first, so the
  service runs the compiled binary.)
- **Multiple fleets**: just use separate fleet directories — ports, tmux session names,
  and daemon service names are derived per fleet dir, so nothing collides. Telegram
  needs a distinct bot token per fleet (Telegram allows one poller per token). Slack needs
  a separate app per running fleet because Socket Mode distributes events across connections.

## Command reference

`/help` lists everything in the console. Full reference is in the [README](../README.md).
Every fleet command works identically in the console, via `conductor cmd '<command>'`, and
over Telegram. Slack exposes the same commands with an `!` prefix inside its private App Home
conversation. `/clear` is local to the interactive console.

## Troubleshooting

| Symptom                                                 | Likely cause                                                                           |
| ------------------------------------------------------- | -------------------------------------------------------------------------------------- |
| `command not found: conductor`                          | `pnpm link --global` not run, or use `-C`/`npx tsx` (README Install)                   |
| `conductor validate` says OK but nothing is configured  | You ran it outside the fleet dir — `cd` in, or pass `-C ~/fleet`                       |
| Pane never launches / hangs on start                    | `claude`/`codex` not on PATH, or bad `repo:` path                                      |
| macOS dialog on first start                             | iTerm2 automation permission — approve it (System Settings → Privacy → Automation)     |
| Auto session stalls but nothing happens                 | No sentinel configured/running, or the sentinel lacks `systemPromptFile`               |
| Session replies in its pane but not on a remote channel | Expected — it must use `send_to_operator`; check the protocol prompt is being injected |
