# Agent Conductor

Agent Conductor is a lightweight supervisor for fleets of terminal coding agents. It lets
Claude Code and OpenAI Codex sessions communicate with each other and with an operator,
while a designated agent watches auto sessions for stalls.

It is deliberately small. The conductor provides lifecycle, messaging, observability,
and stall-routing primitives; the agents decide how to use them. There is no workflow
engine, dashboard, task graph, or LLM hidden inside the supervisor.

> **Project status:** Agent Conductor is in an internal GitHub-distributed beta and is not yet
> published to npm. Interfaces may change before the first stable release.

## Why Agent Conductor?

Running one coding agent is simple. Running several introduces a few practical problems:

- **Identity:** messages need a trustworthy sender. Each managed session gets its own MCP
  endpoint, and the conductor derives the sender from that connection rather than accepting
  a caller-supplied name.
- **Coordination:** sessions need direct, signed communication without scraping terminals or
  sharing a chat transcript.
- **Supervision:** an auto session that stops, blocks, compacts, or wedges needs
  attention without requiring a human to watch every pane.
- **Operator access:** the same fleet controls work in the local console, Telegram, Slack,
  and injected operator adapters.

Agent Conductor handles those mechanics and leaves judgment to the agents and operator.

## How it works

```text
 Claude Code ─┐                          ┌─ iTerm2 panes
              ├─ session-facing MCP ─┐  ├─ tmux panes
 Codex ───────┘                      │  │
                                    ▼  ▼
                              ConductorOperations
                              canonical control plane
                                    ▲  ▲
                                    │  │
 Operator console ─┐                │  └─ lifecycle events + pane watchdog
 Telegram ─────────┼─ operator adapter
 Slack ────────────┼─ operator adapter
 Other channels ───┘

```

The canonical operation registry owns behavior, validation, descriptions, and MCP schemas.
MCP and operator commands are adapters over that registry, so shared capabilities cannot
quietly develop different implementations.

The conductor itself never calls an LLM. When an auto session stalls, the conductor
sends one self-contained message to the configured **stall sentinel**. The sentinel is a
normal Claude Code or Codex session that inspects the situation and acts with ordinary
tools: message the session, ask the operator, or do nothing.

## Requirements

- Node.js 22.13 or newer (the non-LTS Node 23 line requires 23.4 or newer)
- Claude Code (`claude`) and/or OpenAI Codex (`codex`)
- iTerm2 on macOS, or tmux on macOS/Linux
- `curl` for runtime lifecycle hooks
- GitHub CLI (`gh`) only when using the optional PR Shepherd

Telegram and Slack are optional.

## Install the GitHub beta

The beta is one ordinary npm-compatible tarball attached to the GitHub prerelease. npm and pnpm can
install that exact URL globally without publishing it to a registry:

```bash
RELEASE=https://github.com/ianlancaster/agent-conductor/releases/download/v0.2.0-beta.0/agent-conductor-0.2.0-beta.0.tgz
npm install --global "$RELEASE"
# or: pnpm add --global "$RELEASE"
```

Yarn Classic 1.x also supports `yarn global add "$RELEASE"`. Yarn Modern removed global installs;
use npm or pnpm for a durable CLI installation instead of `yarn dlx`. These forms follow the package
managers' documented [npm tarball URL](https://docs.npmjs.com/cli/v11/commands/npm-install/),
[pnpm remote tarball](https://pnpm.io/package-sources#remote-tarball), and
[Yarn Classic global](https://classic.yarnpkg.com/lang/en/docs/cli/global/) behavior.

The install provides both `conductor` and `pr-shepherd`. Verify the downloaded release checksum
before installation when your environment requires it; the matching `.sha256` file is attached to
the release.

To upgrade within the beta, repeat the install command with the new release asset URL. To uninstall:

```bash
npm uninstall --global agent-conductor
# or: pnpm remove --global agent-conductor
# Yarn Classic: yarn global remove agent-conductor
```

## Quick start

Create a fleet directory and register a project:

```bash
mkdir ~/my-fleet
cd ~/my-fleet
conductor start
```

On first use, `conductor start` creates the complete `.conductor/` scaffold without overwriting
anything already present. It then launches the supervisor and turns the current terminal into an
operator console. The generated `supervisor.yaml` contains the full effective configuration—including
fleet-derived values and disabled Telegram and Slack channel blocks—instead of commented examples.
That console owns the supervisor it launched: `Ctrl+C` or closing the console stops the Conductor.
If the fleet is already running, `conductor start` exits instead of creating a misleading non-owning
console; use `conductor console` when an additional attachment is intentional.
Register and start the first project from the `conductor>` prompt:

```text
/spawn alpha --path /absolute/path/to/my-project
/tell alpha inspect this repository and summarize its architecture
/status
/tail alpha 40
/stop alpha
```

Session configuration lives in `.conductor/config/sessions/alpha.yaml`:

```yaml
codename: alpha
repo: /absolute/path/to/my-project
runtime: claude-code # or codex
# bypassPermissions: false # optional override of the fleet default
# model: claude-opus-4-8
# effort: xhigh # optional per-session default; accepted values depend on runtime/model
```

Sessions that omit `runtime` use `defaults.runtime` from `.conductor/config/supervisor.yaml`:

```yaml
defaults:
  runtime: codex # default: claude-code
  bypassPermissions: true # default: true
```

`bypassPermissions` controls Claude Code's permission bypass and Codex's approval/sandbox
bypass through one runtime-neutral setting. Set it under `defaults` for the fleet, or in a
session file for an override. `/spawn` also accepts `--bypass-permissions` or
`--require-permissions`; `spawn_session` exposes the same `bypassPermissions` boolean.

Model and effort values remain free text. Their operation schemas advertise configurable,
per-runtime availability hints; the lists are discoverability aids, never validators. This lets
new models, effort levels, and third-party provider values pass through without waiting for a
Conductor release. `spawn_session` persists `model` and `effort` as session defaults, while
`start_session` and `continue_session` accept a per-process `effort` override. Operator and channel
adapters expose the same behavior as `/spawn --effort`, `/start --effort`, and
`/continue --effort` (`-e`).

```yaml
runtimes:
  claudeCode:
    availableModels: [claude-fable-5, claude-opus-4-8, claude-sonnet-5]
    defaultEffort: xhigh # optional; omit to let Claude Code choose
    availableEfforts: [low, medium, high, xhigh, max]
  codex:
    availableModels: [gpt-5.6, gpt-5.6-sol, third-party/model-id]
    defaultEffort: xhigh # optional; omit to let Codex choose
    availableEfforts: [none, minimal, low, medium, high, xhigh, max, ultra]
```

Effort precedence is per-run argument, then the session's `effort`, then the selected runtime's
`defaultEffort`, then the runtime's own default. A runtime override does not carry the original
runtime's model or effort into the other family. `get_session_status` reports the model and effort
Conductor resolved, using `null` when selection belongs to the runtime.

See [examples/supervisor.yaml](examples/supervisor.yaml) for the complete user-facing
supervisor configuration.

An explicit `runtime` in a session file becomes that session's default. `/start`, `/continue`,
`start_session`, and `continue_session` accept a per-run runtime override without modifying
the session file; command and tool arguments accept `cc` as shorthand for `claude-code`.
`/spawn` and `spawn_session` use the fleet default when runtime is omitted.
Claude Code and Codex keep separate conversation histories: a runtime-overridden `continue`
resumes the selected runtime's latest conversation, not a conversation created by the other runtime.

Session files hot-reload. Add, edit, or remove a YAML file under `.conductor/config/sessions/` without
restarting the conductor. Unknown configuration keys are validation errors, so stale or
misspelled settings never fail silently.

`conductor start` creates any missing fleet scaffold files, including an owner-only `.conductor/.env`,
and keeps Conductor-owned configuration,
secrets, runtime state, and logs together under `.conductor/`; it does not create generic `config/` or
`data/` directories in the fleet root. Existing files are never replaced. Fleets made by older releases
continue to load from root-level `config/`, `data/`, and `.env`. See the
[migration note](docs/getting-started.md#existing-root-level-fleets) before moving a running fleet.

The terminal backend is selected automatically: starting inside tmux uses tmux; starting in
iTerm2 on macOS uses iTerm2. Set `terminal.backend` explicitly when running as a daemon.

For a guided first fleet, including a sentinel and Telegram, see
[Getting Started](docs/getting-started.md).

Every managed agent also receives a session-only `get_conductor_docs` tool. It exposes the
version-matched [extended agent handbook](docs/agent-guide.md) as lazy topics and returns the
active fleet's authoritative configuration paths. The small injected protocol tells agents when
to consult it without preloading the full handbook into every context.

The mandatory protocol contains only turn-zero identity, envelope, communication, and safety
rules. MCP tool descriptions are canonical for operation arguments and return mechanics; task
recipes and configuration walkthroughs live in the lazy handbook.

`conductor doctor` checks the selected runtime, terminal backend, fleet paths, port, and enabled
optional services with actionable pass/warn/fail output. `conductor start` runs its blocking checks
before launching and, on the first scaffold only, prints a copyable two-command agent-led onboarding
flow.

## Documentation

- [Getting Started](docs/getting-started.md) — build a first fleet, sentinel, remote channel,
  schedules, worktrees, and daemon.
- [Managed-agent handbook](docs/agent-guide.md) — feature map, composition recipes,
  configuration maintenance, adapters, and troubleshooting; also available lazily through
  `get_conductor_docs`.
- [Complete supervisor example](examples/supervisor.yaml) — every setting and effective default.
- [Telegram adapter](guides/telegram-adapter.md) and [Slack adapter](guides/slack-adapter.md) —
  least-privilege external operator setup.
- [External adapters and embedding](guides/external-adapters.md) — public contracts for operator
  channels, terminal backends, and experimental session runtimes.
- [PR Shepherd V2](docs/pr-shepherd.md) — standalone or Conductor-managed GitHub polling,
  policy, and Conductor delivery.
- [GitHub beta release runbook](docs/beta-release-runbook.md) — protected prerelease workflow,
  packed-artifact certification, checksums, and cohort policy.
- [Contributor guide](CONTRIBUTING.md) and [architecture guide](CLAUDE.md) — mandatory context
  for extending the product.

## Optional runtime status lines

For a richer terminal footer, run this once:

```bash
conductor statusline
```

This optional setup is separate from fleet startup. It configures the user-level
Claude Code and Codex settings used by newly started sessions; restart an existing managed
session to pick it up.

Claude Code receives a conductor-supplied status-line command showing model, context used,
cost, project, worktree, Git branch, and staged/modified counts. It detects linked worktrees
from Git when Claude Code did not create the worktree itself. Codex uses its native
`tui.status_line` with the closest supported fields: model and reasoning, context used,
tokens used, project, and Git branch. Codex does not currently expose dollar cost, worktree
name, or working-tree change counts as native status-line items. You can further customize
Codex interactively with `/statusline` inside Codex.

## The operator console

Run `/help` in any connected operator interface for the authoritative command reference.
The same command language works in:

- the console opened by `conductor start`
- an additional console opened by `conductor console`
- one-shot commands such as `conductor cmd /status`
- Telegram
- Slack (using `!` instead of `/` for commands inside the private App Home conversation)
- injected `ChannelAdapter` implementations

For a read-only live view in its own terminal panel, run `conductor status`. It shows the
canonical `/status` output, marks the conductor online or offline, and reconnects after a
restart. Press `q` to leave the view. Redirected output remains one-shot; use `--once` to
request the same behavior interactively or `--interval <duration>` to change the fifteen-second
refresh cadence.

Common examples:

```text
/status [session]
/start <session|all> [-r|--runtime <registered-name>] [placement]
/continue <session|all> [-r|--runtime <registered-name>] [placement]
/stop <session|all>

/tell <session> <message>
/talk <session>
/broadcast <message>
/respond <request-id> <option-number>
/message-status <message-id>
/cancel-message <message-id>
/tail <session> [lines]
/type <session> <text>

/auto <session|all>
/pause <session|all>
/resume <session|all>
/sentinel [session]
/fleet-watch
/tag <session> [text]

/spawn <name> [--runtime <runtime>] [--path <dir>] [--model <model>] [--template <name>]
              [--worktree <repo>] [--branch <name>]
              [--bypass-permissions|--require-permissions] [placement]
/teardown <name> [--delete]
```

Placement flags are `-P/--pane`, `-T/--tab`, and `-W/--window`. `-H/--headless` places the
session in the detached fleet tmux session.

`/auto` toggles stall supervision for a session. `/pause` temporarily suppresses its
schedules and stall routing without changing that auto setting; `/resume` removes the pause.

`/sentinel watch` changes the stall sentinel immediately and persists the selection.
Running `/sentinel` with no session clears it.

Fleet watch covers campaigns where individual stalls are normal but the entire fleet being
stalled at once is not. It is one fleet-level toggle:

```text
/fleet-watch
```

The setting survives Conductor restarts, like auto mode. When enabled, it always watches every
registered session except the designated sentinel, and membership follows session registration
automatically. With fewer than two eligible sessions it remains enabled but does not alert.

Each member first passes through ordinary stall detection. Once all members are stalled,
the watch waits `health.fleetStallConfirmMs` (15 seconds by default) and sends one `[Fleet Stall]`
alert to the sentinel, or directly to the operator when no sentinel is configured. A submitted
message, restart, later completed turn, membership change, or sentinel change starts a fresh
confirmation cycle.

## Session-facing MCP tools

Every managed session receives the same session-facing MCP surface. `tools/list` is the
authoritative machine-readable reference, including argument schemas.

### Shared fleet primitives

These operations are available through both MCP and operator adapters:

| MCP operation        | Operator command    | Purpose                                                             |
| -------------------- | ------------------- | ------------------------------------------------------------------- |
| `send_to_session`    | `/tell`             | Send a signed message; starts a stopped recipient when needed       |
| `get_message_status` | `/message-status`   | Inspect receipt state and the latest delivery-loop decision         |
| `cancel_message`     | `/cancel-message`   | Cancel a pending direct message before its pane write begins        |
| `broadcast`          | `/broadcast`        | Message every active session except the sender                      |
| `start_session`      | `/start`            | Start sessions, optionally overriding runtime and effort            |
| `stop_session`       | `/stop`             | Stop one session or all sessions                                    |
| `continue_session`   | `/continue`         | Continue sessions, optionally overriding runtime and effort         |
| `spawn_session`      | `/spawn`            | Create, register, and start an empty, template, or worktree session |
| `teardown_session`   | `/teardown`         | Stop and deregister a session; optionally remove its directory      |
| `toggle_auto`        | `/auto`             | Toggle automatic stall routing                                      |
| `pause_session`      | `/pause`            | Suppress schedules and stall routing temporarily                    |
| `resume_session`     | `/resume`           | Resume schedules and configured stall routing                       |
| `set_sentinel`       | `/sentinel`         | Set or clear the fleet sentinel                                     |
| `toggle_fleet_watch` | `/fleet-watch`      | Toggle full-fleet stall detection                                   |
| `set_tag`            | `/tag`              | Set or clear a status label                                         |
| `list_sessions`      | `/status`           | Show fleet status                                                   |
| `get_session_status` | `/status <session>` | Show detailed status for one session                                |
| `tail_session`       | `/tail`             | Read trailing pane output                                           |
| `type_in_pane`       | `/type`             | Type raw text immediately, bypassing envelope and safety queue      |

### Session-only tools

- `whoami` returns the caller identity derived from its MCP connection.
- `get_conductor_docs` lists or reads one topic from the version-matched extended handbook and
  returns the active fleet's configuration paths. It is intentionally lazy so agents can discover
  recipes and troubleshooting without carrying the entire guide in every system prompt.
- `send_to_operator` sends a signed message to connected operator adapters. Its optional
  `options` array carries 1–8 short, unique choices and returns a request ID.

Operator-only conveniences such as `/talk`, `/respond`, `/summon`, and `/banish` are
intentionally not exposed as agent tools. `/respond <request-id> <option-number>` sends the
first selected response back to the requesting session; it does not approve or execute an
action.

`send_to_session` returns `{ messageId, recipient, status, deduplicated }`. Its optional
1–128 character `idempotencyKey` is scoped to the mechanically assigned sender; retrying the
same key returns the original receipt without inserting or delivering another message. A
`queued` receipt is protected only for the lifetime of the current Conductor process. Restarting
the Conductor cancels queued local messages instead of replaying stale conversation; restarting
only the recipient pane within the same run keeps the queue. Receipts can be inspected with
`get_message_status` or `/message-status`; status includes
`deliveredAt`, `lastFlushAttempt`, and `flushSkipReason`. Before falling back to raw pane
input, the sender can use `cancel_message` or `/cancel-message` to prevent a later queued
delivery. Cancellation succeeds only while the receipt is pending and its pane write has not
begun. `type_in_pane` is intentionally different: it writes immediately for
interactive prompts and slash commands, so callers must avoid using it while the operator is
composing in that pane.

## PR Shepherd V2

The package also ships the opt-in `pr-shepherd` GitHub polling service with a pure policy engine,
strict YAML profiles, SQLite event/outbox persistence, and optional durable delivery to a
Conductor coordinator session. `conductor start` copy-once scaffolds an inert profile beside the
supervisor. After a safe shadow run, a root-level `shepherd` block can opt into Conductor-owned
start/stop; managed operation is headless by default. While it is healthy, `/status` shows
`PR Shepherd Status Online` and marks its configured coordinator session with `🐑`. Disabled
companions are omitted from fleet status. See the complete
[getting-started and configuration guide](docs/pr-shepherd.md) and
[generic example profile](examples/pr-shepherd.yaml).

## Auto sessions and the stall sentinel

Auto is off by default. Run `/auto <session>` to turn it on or off. When auto is on,
detected stalls are routed to the sentinel; otherwise the operator drives the session.

Runtime lifecycle events are the primary signal. Claude Code hooks and Codex notifications
report session starts, stops, blocked prompts, compaction, and termination. A pane-diff
watchdog catches silent or wedged sessions when events stop flowing.

To configure a sentinel, copy the shipped `prompts/sentinel.md` into your fleet's
`.conductor/prompts/` directory, then:

1. Create a normal session with the supplied sentinel instructions:

   ```yaml
   # .conductor/config/sessions/watch.yaml
   codename: watch
   repo: /absolute/path/to/a/scratch-directory
   runtime: claude-code
   systemPromptFile: ./.conductor/prompts/sentinel.md
   ```

2. Set the initial designation in `.conductor/config/supervisor.yaml`:

   ```yaml
   sentinel:
     codename: watch
   ```

3. Start the sentinel before turning auto on for other sessions:

   ```text
   /start watch
   /auto alpha
   /tell alpha complete the requested implementation and verify it
   ```

If no sentinel is configured, stalls are reported directly to the operator. If a sentinel is
configured but not running, the conductor alerts the operator that the stall could not be
delivered.

## Scheduling

Sessions can receive cron-driven prompts:

```yaml
codename: reviewer
repo: /absolute/path/to/project
runtime: codex
schedules:
  - label: weekday review
    cron: '0 9 * * 1-5'
    prompt: Review open pull requests and report important findings to the operator.
    freshContext: false
```

An active session receives the prompt as a message. An inactive session — including one whose
runtime was ended with Ctrl-C but whose pane remains open — restarts with the prompt internally.
Schedules targeting the same session are serialized so simultaneous jobs do not lose prompts.
Public lifecycle tools do not expose a start-with-prompt option; this is an internal composition
of scheduling and lifecycle primitives.

Pausing the session suppresses all of its schedules until it is resumed. Individual schedule
entries can also be disabled with `paused: true`. Set `freshContext: true` to stop an active
session and start a new run with the scheduled prompt. Missed triggers are never backfilled:
the conductor only runs cron events reached while it is running.

## Templates, worktrees, and spawned sessions

Register any number of Git-backed templates in `.conductor/config/supervisor.yaml`:

```yaml
spawn:
  templates:
    agent:
      source: https://github.com/ianlancaster/cognitive-agent-template
      # ref: main # optional branch, tag, or commit
```

The `agent` entry above is the built-in default. Select it with `/spawn researcher -t agent` or
the `spawn_session.template` argument. `--path` still overrides the destination. Conductor accepts
configured HTTPS/SSH Git sources and local paths, clones into an empty destination, and names the
source remote `template` so `origin` remains available for the new project. It does not execute
scripts or interpret template contents. A configured `ref` is checked out after cloning; omit it
to use the source's default branch. Template and worktree sources are mutually exclusive.
Supervisor configuration changes take effect after restart. Because the resulting workspace is a
Git repository, guarded `/teardown --delete` deregisters it but leaves its directory intact.

Create an isolated worktree session without cloning the repository again:

```text
/spawn reviewer --worktree /path/to/project --branch review-pass
/tell reviewer review the current changes for correctness
```

The equivalent MCP call is `spawn_session` with `worktreeRepo` and an optional `branch`.
The destination is the explicit `path`, or `spawn.dirPattern` with `{codename}` substituted;
both relative paths are resolved from the fleet directory. When the requested branch does not
exist, Git creates it at the source repository's currently checked-out `HEAD`. Conductor does
not fetch or choose a remote base implicitly. If the branch already exists, it is checked out
as-is.

Linked worktrees share Git history but have independent checked-out files. A branch already
checked out elsewhere cannot also be checked out in the new worktree, so workflows should diff,
rebase, or merge against a remote-tracking ref such as `origin/main` instead of running
`git checkout main` inside the worktree. Gitignored and untracked files are not copied from the
source working tree: local settings, secrets, dependency directories, and build artifacts must
be seeded or recreated explicitly. For build work, fetch the desired refs and run the project's
normal dependency/setup commands before making changes.

Remove the session with `/teardown reviewer --delete`, or `teardown_session` with
`deleteDir: true`. The conductor refuses to remove a dirty worktree, leaves the stopped session
registered so cleanup can be retried, and keeps its branch in the main repository after a
successful removal. Git determines dirtiness: ignored files such as `.env.local`, local settings,
and reports under ignored directories do not block removal and are deleted with the worktree.

## Telegram

Telegram is bundled but disabled by default. Enable it in `.conductor/config/supervisor.yaml`:

```yaml
channels:
  telegram:
    enabled: true
```

The first `conductor start` creates an owner-only, gitignored `.conductor/.env` with organized credential
stubs, without overwriting an existing file. Fill in the Telegram values and restart:

```bash
${EDITOR:-vi} .conductor/.env
conductor start
```

```dotenv
CONDUCTOR_TELEGRAM_TOKEN=123456:token
CONDUCTOR_TELEGRAM_CHAT_ID=987654321
```

You may instead export those variables globally from `.bashrc`, `.zshrc`, CI, or a service
environment when the fleet file omits them. Values defined in `.conductor/.env` are authoritative,
so editing that file and restarting cannot be defeated by stale variables in a long-lived parent
process. The conductor does not source shell startup files itself; launchd and systemd normally do not
source interactive shell files, so a fleet `.conductor/.env` is the reliable daemon source. Enabling Telegram without both non-blank
credentials marks that channel unavailable without printing secret values; the Conductor control plane
continues running so lifecycle and agent messaging remain available.
The adapter also validates the bot token with Telegram before reporting the channel as connected,
so stale, revoked, or malformed tokens degrade only Telegram instead of entering a silent retry loop.

Telegram accepts the same operator commands as the local console. Messages sent with
`send_to_operator`, including sentinel questions and undeliverable-stall warnings, are sent
to every connected operator adapter. When a session includes `options`, Telegram renders
inline buttons and text-only consoles render exact `/respond` commands. The first response
from any interface wins and returns to the requesting session as an ordinary operator message.
This records an answer only; it is not an approval or escalation queue.
Because Telegram requires the operator to initiate a bot conversation, a bare `/start` returns the
fleet status followed by the command help. `/start <session|all>` retains its normal lifecycle meaning.

Telegram permits only one long-polling process per bot token. Use a separate bot token for
each concurrently running fleet. The complete BotFather, private-chat authorization, verification,
security, and troubleshooting walkthrough is in the
[Telegram adapter guide](guides/telegram-adapter.md).

Its `🔄` marker identifies sessions with auto stall routing enabled and appears in the
live status header as `ONLINE 🔄 fleet watch on` while fleet watch is enabled.
An attached `conductor>` console reconnects its operator feed silently. A failed `send_to_operator`
reports `NOT delivered` unless an attached console or at least one channel actually accepted the message.

## Slack

Slack is also bundled, optional, and disabled by default. It connects outbound through Socket Mode and
restricts control to one configured member's private App Home conversation—there is no public webhook,
channel access, or workspace slash command. Enable it with:

```yaml
channels:
  slack:
    enabled: true
```

The first `conductor start` scaffolds the required `CONDUCTOR_SLACK_*` values in `.conductor/.env`.
Creating the private Slack app, assigning its least-privilege scopes, and finding the operator member ID
are covered by the copyable manifest and walkthrough in the [Slack adapter guide](guides/slack-adapter.md).
Use a separate Slack app for each concurrently running fleet.

Inside **Apps > Agent Conductor > Messages**, prefix Conductor commands with `!` (`!status`, `!talk
alpha`, `!help`). Ordinary text goes to the active talk session. `!send /compact` sends a leading-slash
line through to that session, and `!!important` sends literal text beginning with `!`.

Slack's runtime packages are optional dependencies installed by default. A consumer intentionally using
`--omit=optional` keeps the core/Telegram installation lean, but must reinstall optional dependencies
before enabling Slack. When multiple operator adapters are enabled, all receive outbound notifications;
responses remain scoped to the originating conversation and the first `/respond` answer wins.

## Adding an operator adapter

Operator transports implement the small `ChannelAdapter` interface:

```ts
interface ChannelAdapter {
  readonly name: string;
  start(handlers: ChannelHandlers): Promise<void>;
  send(message: ChannelMessage): Promise<void>;
  stop(): Promise<void>;
}

interface ChannelMessage {
  text: string;
  actions?: readonly { label: string; command: string }[];
}
```

Inject adapters when embedding the supervisor:

```ts
import { Supervisor } from 'agent-conductor';

const supervisor = new Supervisor('/path/to/fleet', {
  channels: [mySlackAdapter],
});

await supervisor.start();
```

External session runtimes use the same injection boundary:

```ts
const supervisor = new Supervisor('/path/to/fleet', {
  runtimes: [myRuntime],
});
```

The final built-in plus injected registry drives configuration validation, spawn/start/continue
schemas, MCP validation, and operator help. An injected runtime may replace a built-in by name;
duplicate injected names are rejected, and `cc` remains reserved as the `claude-code` UI alias.

Each incoming command includes a conversation ID, so stateful operator conveniences such as
`/talk` remain isolated between adapters and users. The operation registry is audience-aware,
leaving a clean path for future agent-facing adapters without duplicating command handlers.

`ChannelAdapter` is specifically the external operator-transport seam. The local console is a
native client of the conductor's `/cmd` endpoint and `/feed` event stream, while session-facing
MCP is rendered directly from `ConductorOperations`. A channel should authenticate or allowlist
callers from trusted transport metadata, translate inbound input into `ChannelHandlers`, and
own only service-specific concerns such as formatting, message limits, retries, and shutdown.
Core lifecycle and messaging policy stays in the canonical operations.

Semantic actions contain canonical commands such as `/respond 42 2`. Rich adapters may render
native controls; text-only adapters can use the exported `renderChannelMessage` fallback.
`TelegramAdapter`, `SlackAdapter`, their configuration types, and all channel contract types are exported
for embedding. Importing the package does not load Slack's optional SDK modules unless the Slack adapter
is actually started.

Bundled channels are opt-in integrations whose configuration and credential discovery ship
with the package. Injected channels are constructed by the embedding application and may use
its own configuration and secret provider. See [CONTRIBUTING.md](CONTRIBUTING.md) and the
[developer guide](CLAUDE.md#extension-taxonomy) for the adapter checklist and test layers.
The complete public contract and runnable host are in the
[external adapter guide](guides/external-adapters.md).

## Running headless

The tmux backend works without a GUI and is suitable for SSH hosts and Linux servers.

```yaml
terminal:
  backend: tmux
  tmux:
    attachToCurrent: false
```

`--headless` starts a session in the detached fleet tmux session. `/summon` moves its pane
into the operator's current tmux window, and `/banish` moves it back without stopping it.

For a long-running service:

```bash
conductor daemon install
conductor daemon uninstall
```

The daemon uses the compiled package, so run `pnpm build` and ensure `conductor` is on the
service user's `PATH` first.

## CLI reference

```text
conductor statusline           configure optional Claude Code and Codex status lines
conductor start                initialize missing fleet files, then start the supervisor and console
conductor start --start-all    start the supervisor and every configured session
conductor start --foreground   run the supervisor in the current process
conductor console              attach another operator console
conductor cmd /status          send one operator command
conductor status [session]     show live fleet status (one-shot when piped or with --once)
conductor logs [session]       show recent health events
conductor validate             validate configuration
conductor daemon install       install a user service
conductor daemon uninstall     remove the user service
```

All commands accept `-C, --dir <fleet-directory>`.

## Security model

The HTTP control surface binds to `127.0.0.1` by default and rejects requests carrying
browser `Origin` or `Referer` headers, which blocks drive-by browser access to localhost.

Session identity is mechanical within the conductor: the codename comes from the MCP URL
wired into that session, not from tool arguments. There is not yet per-session bearer
authentication, so another trusted local process could call a session endpoint directly.
Run the conductor only on a trusted machine and do not expose its HTTP port publicly.

Codex sessions receive isolated `CODEX_HOME` directories so `resume --last` cannot select
another managed session's history. Before every start or continue, the conductor generates
`$CODEX_HOME/AGENTS.override.md` for that session. It inherits the operator's active global Codex
instructions, then appends the mandatory Conductor protocol and any session-specific prompt.
Consumer repositories and their `.gitignore` files are not modified. The launch also receives a
mechanically scoped Conductor MCP URL and lifecycle notify hook, so Codex has the same fleet tools
as Claude Code without trusting caller-supplied identity.

## Development

```bash
pnpm install
pnpm typecheck
pnpm lint
pnpm format:check
pnpm test
```

The global `conductor` command runs compiled `dist/` code, not the TypeScript source. After
pulling or changing code, refresh it before black-box CLI testing:

```bash
pnpm build
pnpm add --global .
conductor --help
```

Use `pnpm cli <arguments>` when you intentionally want to execute source through `tsx`.
Rebuilding does not replace code already loaded by a running Conductor; restart only the
fleet you intend to test, at a safe point.

Before contributing, read [CONTRIBUTING.md](CONTRIBUTING.md) and the canonical architecture
guide in [CLAUDE.md](CLAUDE.md). They define the open-source/generalization contract,
extension boundaries, applicable-surface audit, testing expectations, configuration and
migration rules, and pull-request workflow.

The test suite uses in-memory terminal, runtime, and channel adapters, plus real HTTP and
tmux integration tests. Contract tests ensure every shared operation appears through both
MCP and operator adapters and remains documented.

For black-box verification with real Claude Code and Codex sessions, use the
[basic agent messaging test](test/manual/primitives/PRIMITIVE-TEST-SCRIPT.md) and its
accompanying kickoff and results template.

When adding a shared fleet primitive:

1. Add its schema, audiences, description, and handler to `ConductorOperations`.
2. Add its operator syntax to `buildOperatorCommands`.
3. Update this README and the conductor protocol prompt.
4. Add behavior and contract tests.

## License

MIT
