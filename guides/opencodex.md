# OpenCodex-backed Codex and Claude Code sessions

Agent Conductor can register two optional runtime names over the native CLI integrations:
`opencodex` (Codex CLI) and `opencodex-claude` (Claude Code CLI). The proxy handles model requests;
Conductor still owns session identity, hooks, health, protected messaging, and terminal panes. It
does not install, configure, or authenticate the proxy. An optional operator-supplied executable
can ensure the proxy is ready before each launch. The existing `codex` and
`claude-code` runtime names are unchanged.

## Prerequisites and configuration

Install and configure [OpenCodex](https://github.com/lidge-jun/opencodex) separately, with its
HTTP proxy bound to loopback. Keep provider keys in the proxy's own secret mechanism. Do not put a
key or authenticated URL in Conductor YAML, an environment template, a prompt, or a launch command.
The bundled profiles assume the loopback listener admits local clients without a separate proxy
admission key; a listener that requires client credentials will reject them. Use a trusted external
runtime adapter for a different authentication arrangement.
Avoid OpenCodex setup modes that rewrite a shared Codex or Claude home if native sessions must stay
independent. OpenCodex's optional Claude agent injection can write to the effective Claude config
directory; use an isolated directory or disable that proxy feature when appropriate.

Add this to `.conductor/config/supervisor.yaml` (or the active named instance's supervisor file):

```yaml
runtimes:
  openCodex:
    enabled: true
    proxyOrigin: http://127.0.0.1:10100
    proxyEnsureCommand: null
    claudeConfigDir: null
    claudeCodeEnabled: false
```

`proxyOrigin` is required when enabled and accepts only a plain HTTP loopback origin. The optional
`proxyEnsureCommand` is an absolute path to a trusted, operator-owned executable. Conductor runs
it before the proxy health check on every start or continuation; a nonzero exit prevents the CLI
from launching. A small fleet-owned wrapper can read `VERCEL_AI_GATEWAY_TOKEN` from the fleet's
private environment, run OpenCodex's ensure command with isolated homes, and fail closed when the
key is absent. The token alone does not activate a provider or overwrite an existing OpenCodex
configuration: provider setup and proxy ownership remain explicit. Do not put the token or a
shell command string in YAML. The Codex
profile connects to its `/v1` Responses endpoint; the Claude profile uses its Anthropic-compatible
endpoint. The proxy port must match the separately running service. This setting is read at
Conductor startup, so run `conductor validate` and arrange a deliberate restart before selecting
the new runtime. A previously running Conductor cannot see the new names. To disable the harness,
stop its sessions, set `enabled: false`, and restart; if Claude was enabled, also set
`claudeCodeEnabled: false`.

If a fleet already has an external `runtimeAdapters` entry named `opencodex`, remove that entry in
the same supervisor edit that enables the bundled profile. Conductor rejects the collision with
an actionable config error. The external adapter may continue unchanged while the built-in flag
stays off; its separate setup and runbook remain its owner's responsibility.

Each session must select the new runtime and an explicit model from the proxy's live catalog:

```yaml
codename: proxy-worker
repo: /path/to/repository
runtime: opencodex
model: provider/model-id
```

The model identifier is passed through; Conductor does not require a provider prefix or a
particular vendor. `opencodex` uses launch-scoped Codex provider overrides, so it does not edit the
shared Codex config or change how ordinary `codex` sessions are launched. The runtime checks the
proxy's `/healthz` endpoint before each start or continuation; an unavailable proxy fails that
launch before the coding CLI starts. This check does not prove model access or tool compatibility.
Conductor's ordinary `defaults.bypassPermissions` and per-session `bypassPermissions` settings
also apply to these runtimes; review that setting before assigning code or credentials to a
proxy-backed model.

## Claude Code substrate

Enable `claudeCodeEnabled: true` only after configuring and qualifying OpenCodex's Claude Code
route. Conductor then registers `opencodex-claude`; a session selects it with `runtime:
opencodex-claude` and an explicit model. The profile launches Claude Code directly with a
loopback `ANTHROPIC_BASE_URL`, a non-secret gateway token placeholder, and gateway model discovery.
It clears inherited Anthropic provider and model variables before launch. It does not invoke
`ocx claude`, because [that command can intentionally fall back to native Claude](https://github.com/lidge-jun/opencodex/blob/main/docs-site/src/content/docs/guides/claude-code.md#native-fallback-when-claude-routing-is-off).

The bundled Claude profile keeps its folder-trust record and, by default, its Claude configuration
under this Conductor instance's data directory rather than changing the user's ordinary Claude
state. Set `runtimes.openCodex.claudeConfigDir` to an absolute directory only when the separately
configured OpenCodex agent synchronization uses that same directory. Do not set
`runtimes.claudeCode.env.CLAUDE_CONFIG_DIR` for this purpose: that would also change ordinary
Claude sessions. The proxy startup wrapper or operator must create and populate the chosen
directory before a routed child is invoked.

OpenCodex's Claude route has its own enable switch. If that route is off, the proxy can reject
`/v1/messages` even while `/healthz` is healthy. Treat this as an explicit acceptance failure; do
not move the session to native Claude credentials automatically. Direct proxy environment behavior
still needs a live check against your installed Claude Code and OpenCodex versions.

## Native children and limitations

Codex documents that native subagents inherit their parent's model and reasoning settings unless
overridden. Select a proxy catalog model explicitly for a different child, and use a non-inheriting
fork where that Codex version requires it. Verify the child route in OpenCodex's usage records,
not only from its self-reported model. A native child shares the parent's Conductor identity, so
it cannot receive `send_to_session` independently. Spawn another Conductor session for an
independently addressable worker. See [Codex subagent
configuration](https://learn.chatgpt.com/docs/agent-configuration/subagents) and [custom model
providers](https://learn.chatgpt.com/docs/config-file/config-advanced#custom-model-providers).

### Routed Codex children and the V1 transport

On the Codex V2 multi-agent surface, a native ChatGPT-model parent can submit an encrypted child
task that a routed non-ChatGPT provider cannot read. The spawn may be accepted, then fail before
the child runs with `unreadable_encrypted_agent_task`; a follow-up to that child fails the same
way. A healthy proxy and a listed model do not clear this gate. This is a child-task transport
failure, not evidence that the target provider is down. Do not silently retry on a native model
or treat the accepted spawn as successful inference.

OpenCodex's `ocx v2 mode v1` forces its V1 multi-agent surface for the selected OpenCodex home.
This is a catalog/transport setting, **not** a Codex binary downgrade or an Astra model change.
It affects other models and new conversations using that home, so coordinate the change with its
users. The following sequence was needed with OpenCodex 2.59.0; check your installed CLI's help
and live catalog because later versions may refresh differently. Replace the example paths and
origin with this fleet's actual installation; never point a missing proxy config at a shared user
home or create an empty `config.toml` to satisfy the command.

```sh
OCX_BIN=/absolute/path/to/ocx
OCX_DIR=/absolute/path/to/opencodex-home
PROXY_CODEX_DIR=/absolute/path/to/proxy-owned/codex-home
SESSION_CODEX_DIR=/absolute/path/to/fleet/.conductor/data/sessions/worker/codex-home
PROXY_ORIGIN=http://127.0.0.1:10100
PARENT_MODEL=your-parent-model-slug
CHILD_MODEL=your-routed-child-model-slug

test -f "$SESSION_CODEX_DIR/config.toml" &&
  env OPENCODEX_HOME="$OCX_DIR" CODEX_HOME="$SESSION_CODEX_DIR" "$OCX_BIN" v2 mode v1
env OPENCODEX_HOME="$OCX_DIR" CODEX_HOME="$SESSION_CODEX_DIR" "$OCX_BIN" v2 status
env OPENCODEX_HOME="$OCX_DIR" CODEX_HOME="$PROXY_CODEX_DIR" "$OCX_BIN" restart
env OPENCODEX_HOME="$OCX_DIR" CODEX_HOME="$PROXY_CODEX_DIR" "$OCX_BIN" sync
curl -fsS "$PROXY_ORIGIN/v1/catalog" |
  jq -r --arg model "$PARENT_MODEL" '.models[] | select(.slug == $model) | [.slug, .multi_agent_version] | @tsv'
env OPENCODEX_HOME="$OCX_DIR" CODEX_HOME="$SESSION_CODEX_DIR" "$OCX_BIN" sync
jq -r --arg parent "$PARENT_MODEL" --arg child "$CHILD_MODEL" \
  '.models[] | select(.slug == $parent or .slug == $child) | [.slug, .multi_agent_version] | @tsv' \
  "$SESSION_CODEX_DIR/models_cache.json"
```

Stop if the first command fails its `config.toml` check; do not proceed to the restart or sync.
The proxy-owned Codex home and Conductor's isolated per-session `CODEX_HOME` are different.
The former may have no `config.toml`, so `ocx v2 mode v1` can fail there; target the session's
existing config for that command. A successful `v2 status` alone is insufficient: the running
proxy's persisted `/v1/catalog` and the session's `models_cache.json` can still advertise V2.
In the observed 2.59.0 setup, restarting the proxy alone did not refresh that catalog; syncing
both homes as shown did. `ocx restart` is a proxy lifecycle operation, not a Conductor restart.
It can briefly affect active proxy-backed sessions. Do not use `ocx sync --restart-codex` merely
to refresh these caches: it can terminate live Codex conversations.

After both catalog checks report V1 for the parent and routed child, stop the affected Conductor
session and **start a new conversation**. `/continue` resumes the prior Codex conversation and
can retain its V2 tool surface even after the catalogs change. In the new session, check that
the native multi-agent tools expose V1 `spawn_agent`, `send_input`, and `resume_agent` rather than
the V2 `collaboration.spawn_agent` / `followup_task` surface. Then run a bounded child task with
an explicit routed model, verify its tool execution and a separate follow-up, and confirm the
actual upstream model and successful response in proxy records. A V1 catalog entry or child
self-report alone is not acceptance evidence. See the [manual acceptance guide](opencodex-acceptance.md).

For Claude Code, OpenCodex can generate `ocx-*` custom agent definitions from its
`subagentModels` roster into the isolated `CLAUDE_CONFIG_DIR`. Select the generated agent type,
not a general/default agent, for an explicitly routed child. Some Claude Code versions expose
only a tier alias such as `haiku` in the Agent tool's `model` argument; OpenCodex's generated
`ocx-route` directive controls the proxy route. A displayed tier alias is not routing evidence.
Check the proxy's recorded requested and selected models and successful upstream response.

Provider compatibility varies: a catalog entry alone does not establish reasoning effort,
tool-call, subagent, compaction, or message-delivery success. Use the
[manual acceptance guide](opencodex-acceptance.md) before relying on a new model or client
combination. The proxy's own configuration and credentials are outside Conductor's validation.
