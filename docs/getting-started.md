# Getting Started

A step-by-step first run. It builds up in the order that surfaces problems early:
one hand-driven session, then auto stall handling with a sentinel, then remote control.
Do them in order — each step assumes the previous one worked.

Prerequisites and install are in the [README](../README.md). This guide assumes
`conductor` is on your PATH. Create a fleet directory and start it:

Managed Claude Code and Codex sessions receive a small mandatory protocol plus the session-only
`get_conductor_docs` tool. The tool lists version-matched handbook topics and the active fleet's
authoritative configuration paths, so an agent can help operate or maintain Conductor without
preloading the full [managed-agent handbook](agent-guide.md).

```bash
mkdir ~/fleet && cd ~/fleet
conductor start
```

Before launch, `conductor start` runs the same blocking checks as `conductor doctor`. The first start
also prints a pane-driven onboarding flow. At the new `conductor>` prompt, run
`/spawn onboarding-helper` for Claude Code or `/spawn onboarding-helper -r codex` for Codex. Move to
the agent pane Conductor opens and paste the printed onboarding brief directly into the assistant.
The agent will interview you one decision at a time and will keep optional automation off until one
hand-driven session works. It can then offer the live runbook catalog. To request the built-in
baseline directly, say: “Show me the runbook catalog and help me configure Engineering Management
Tier 1.” Choose a workflow and topic before allowing it to configure an opinionated fleet
arrangement; reading a runbook alone never applies it.

Run the diagnostic report directly at any time:

```bash
conductor doctor
```

Failures block startup and include remediation. Warnings identify optional or first-use concerns,
such as an unselected runtime, iTerm automation permission, or daemon installation from a source
checkout.

The first start creates every missing fleet scaffold file automatically, then opens the operator console.
Existing configuration and secrets are never overwritten. A new `supervisor.yaml` records the complete
effective defaults, including the values derived for this fleet and disabled Telegram and Slack blocks.
It also creates an inert `config/pr-shepherd.yaml` profile. That profile is safe to inspect and edit but
cannot poll until `profile.githubUser` is configured; PR Shepherd remains disabled in the supervisor.

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
    │   ├── pr-shepherd.yaml   # inert, copy-once optional Shepherd profile
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
restart an already-running session to pick them up. Claude Code's line shows model, context used,
cost, project, worktree, Git branch, and staged/modified counts. Codex uses its native status line
for model and reasoning, context used, tokens used, project, and Git branch; Codex does not expose
dollar cost, worktree name, or working-tree change counts as native status-line items.

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
   The console opened by `conductor start` owns its Conductor, so `Ctrl+C` or closing that console
   stops the core. If a core is already running, `conductor start` refuses to attach; use
   `conductor console` only when a deliberately non-owning additional console is wanted. If the
   owning console is already gone but its core survived, run `conductor kill` from this fleet
   directory. It uses the fleet ownership lock, verifies the process before signaling it, and
   leaves session panes running. A launchd/systemd-managed Conductor is expected to restart after
   an ordinary process signal; use `conductor daemon uninstall` to take that service down.

   `/tell` delivers your message into the session's pane. The session replies **in its own
   pane** unless it uses `send_to_operator`; that tool sends its reply to every connected
   operator adapter, including the local console and any enabled Telegram or Slack channel.

**If this step fails**, it's almost always one of: `claude` not on PATH, the `repo:` path
doesn't exist, or iTerm2 automation permission (macOS will prompt the first time
`osascript` drives iTerm2 — approve it). Check `conductor logs` and
`.conductor/data/conductor.log`.

Once the shakedown works, you can stay hand-driven or adopt an example workflow. The
[engineering management runbook](../runbooks/agent-conductor/engineering-management/README.md) starts with one persistent EM
and disposable worker tabs, then adds plans, independent review, PR Shepherd, and bounded autonomy
one tier at a time. Its recommended main window keeps the EM on the right and stacks persistent
status, the Conductor console, and the Stall Sentinel on the left.

These shareable workflow bundles are called **runbooks**. Ask the onboarding agent to show the live
catalog rather than relying on a remembered name. After you choose a topic, it can load the exact
instructions, interview you for fleet-specific choices, and drive an approved setup. If you want
the condition recorded for later event-log analysis, the agent prepares an exact `/runbook adopt`
command for you to run; managed sessions cannot record operator approval themselves. See
[Authoring and sharing runbooks](../guides/runbooks.md) to add or publish your own.

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

4. Restart the conductor (session files hot-reload; supervisor settings do not):

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

This is the compact setup path. The [Telegram adapter guide](../guides/telegram-adapter.md)
covers token handling, private-chat ID discovery, security, verification, and troubleshooting.

1. Create a bot with [@BotFather](https://t.me/BotFather), copy the token.
2. Message the bot, then use the environment-safe `getUpdates` command in the
   [Telegram adapter guide](../guides/telegram-adapter.md) and copy `message.chat.id`.
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

   Values in `.conductor/.env` override inherited variables, so a simple restart reliably picks up
   fleet credential edits even when the parent process is long-lived. The conductor does not read shell
   startup files directly; launchd and systemd usually do not source them, so fleet `.conductor/.env` is
   the reliable source for daemons.

5. Restart `conductor start`. The log shows `telegram channel connected.` If credentials are missing
   or rejected, the log names the problem; the core Conductor remains online so lifecycle and agent
   messaging continue to work.

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
--delete` reverses it. Every common flag has a short alias (`-r` runtime, `-m` model, `-e` effort,
  `-d` path, `-t` template, `-w` worktree, `-b` branch, `-a` additional directory, `-D` delete;
  placement `-P`/`-T`/`-W`) — `/help` lists them. `--system-prompt` attaches a role prompt.
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
  generates `AGENTS.override.md` inside that session's isolated `CODEX_HOME`. The generated file
  inherits the active global Codex instructions, then adds the Conductor protocol and optional
  session prompt. Repository instruction files still load through Codex normally; Conductor does
  not edit the repository or its `.gitignore`. The session also receives a mechanically scoped
  Conductor MCP endpoint and lifecycle notify hook.

---

## Running unattended (headless / daemon)

- **tmux backend** (`terminal.backend: tmux` in supervisor.yaml) runs with no GUI — works
  over SSH on a Linux box. `conductor start --foreground --start-all`
  runs the supervisor in the terminal and starts every configured session immediately.
- **As a service**: `conductor daemon install` writes a launchd (macOS) or systemd-user
  (Linux) unit that keeps the conductor running across logins. `conductor daemon
uninstall` removes it. Install the GitHub release tarball globally first so the service has a
  stable executable path; source-checkout and temporary package-runner paths are rejected.
- **Multiple fleets**: just use separate fleet directories — ports, tmux session names,
  and daemon service names are derived per fleet dir, so nothing collides. Telegram
  needs a distinct bot token per fleet (Telegram allows one poller per token). Slack needs
  a separate app per running fleet because Socket Mode distributes events across connections.

## Command reference

`/help` is the authoritative operator-command reference.
Every fleet command works identically in the console, via `conductor cmd '<command>'`, and
over Telegram. Slack exposes the same commands with an `!` prefix inside its private App Home
conversation. `/clear` is local to the interactive console.

Run `conductor status` from the fleet directory for a read-only live panel that shows the
canonical `/status` output and whether the conductor is online. It keeps retrying across
conductor restarts; press `q` to exit. Use `conductor status --once` for a single interactive
snapshot. Piped or redirected status output is automatically one-shot.

## Troubleshooting

| Symptom                                                 | Likely cause                                                                           |
| ------------------------------------------------------- | -------------------------------------------------------------------------------------- |
| `command not found: conductor`                          | Install the GitHub release tarball globally; then confirm its bin directory is on PATH |
| `conductor validate` says OK but nothing is configured  | You ran it outside the fleet dir — `cd` in, or pass `-C ~/fleet`                       |
| Pane never launches / hangs on start                    | `claude`/`codex` not on PATH, or bad `repo:` path                                      |
| macOS dialog on first start                             | iTerm2 automation permission — approve it (System Settings → Privacy → Automation)     |
| Auto session stalls but nothing happens                 | No sentinel configured/running, or the sentinel lacks `systemPromptFile`               |
| Session replies in its pane but not on a remote channel | Expected — it must use `send_to_operator`; check the protocol prompt is being injected |
