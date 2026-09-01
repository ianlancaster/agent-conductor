# Declared MCP tools for managed Codex sessions

Agent Conductor can translate a project's strict, runtime-neutral MCP declaration into the
private `config.toml` of each managed Codex session. It never edits the repository, shared Codex
configuration, or Claude Code configuration. Codex does not consume `.mcp.json`; use the v1 YAML
declaration described here. The translation targets Codex's official
[`mcp_servers` configuration](https://developers.openai.com/codex/mcp) and
[configuration reference](https://developers.openai.com/codex/config-reference).

The bridge separates two decisions:

1. A declaration defines servers and complete, non-inheriting server allowlists.
2. Fleet configuration composes one or more declaration profiles under an explicit tool-profile
   name. A session selects that name mechanically; Conductor never infers privilege from a
   codename or worktree path.

The declaration producer owns canonical server/tool identities, authorization policy, and
cross-runtime discovery semantics. Agent Conductor is a generic consumer: it validates the bounded
shape, selects referenced IDs, and translates supported fields without inventing or endorsing a
service-specific authentication flow. A server may remain declared but absent from every selected
profile; it then produces no Codex config or readiness entry and is not provisioned.

## Configure fleet-owned compositions

Add `declaredMcp` below `runtimes.codex` in `.conductor/config/supervisor.yaml`:

```yaml
runtimes:
  codex:
    declaredMcp:
      defaultProfile: worker
      profiles:
        worker:
          sources:
            - scope: repo
              file: .conductor/mcp.yaml
              profile: worker
        engineering-manager:
          sources:
            - scope: repo
              file: .conductor/mcp.yaml
              profile: worker
            - scope: fleet
              file: .conductor/config/mcp-engineering-manager.yaml
              profile: engineering-manager
          preserveSharedServers: [linear]
```

`scope: repo` resolves inside the session repository. `scope: fleet` resolves inside the fleet
root. `file` must be relative and cannot escape that scope lexically or through a symlink. Duplicate
sources, unknown profiles, and duplicate selected server IDs fail validation or preparation.

`preserveSharedServers` is an optional per-profile allowlist of shared-connector MCP IDs — servers
the operator already configured in shared or project Codex config, typically with their own stored
OAuth credentials — that survive this profile's isolation. A preserved ID keeps its existing
`mcp_servers` table in the session's private copy of shared config and is exempted from the
project-server disable overrides; Conductor copies the table verbatim and never reads, parses, or
forwards its credential values. Every other shared or project server remains removed or disabled.
Only fleet configuration can grant preservation — a declaration or project cannot approve its own
IDs — and it is per profile, so a connector approved for a management profile does not leak into
ordinary workers. `conductor` is reserved (always preserved through its own launch overrides), and
a preserved ID may not collide with a selected declared server ID.

The default must be the least-privileged ordinary profile. A project may define only `worker` and
contain no privileged server at all. The fleet can then compose an explicit management profile
from the project worker surface plus a separately owned overlay. This is the recommended way to
ensure a Slack MCP server or another management-only surface cannot appear in ordinary workers.

Supervisor changes require a deliberate Conductor restart. Declaration changes are read on every
session prepare. Start or continue the session to create a fresh Codex process and connection.

## Declare servers and profiles

The declaration is strict YAML with no unknown fields:

```yaml
version: 1
id: example-project
servers:
  - id: project-api
    transport: streamable-http
    url: https://tools.example.com/mcp
    auth: oauth
    required: true
    tools: [search]
    startupTimeoutSec: 10
    toolTimeoutSec: 120

  - id: project-local
    transport: stdio
    command: node
    args: [scripts/project-mcp.mjs]
    cwd: .
    required: false
    envVars: [PROJECT_CONTEXT]
    envMap:
      SERVICE_TOKEN: PROJECT_SERVICE_TOKEN
    literalEnv:
      SERVICE_REGION: us-central1

profiles:
  worker:
    servers: [project-api, project-local]
```

Every `id`, profile name, and server reference uses letters, digits, `_`, or `-`, begins with an
alphanumeric character, and is at most 64 characters. `conductor` is reserved as a server ID.
Server and profile arrays reject duplicates, and each profile is an exact server allowlist.

Supported common server fields are:

- `required`: mandatory boolean. A missing command, directory, or named credential blocks prepare
  for a required server. An optional server is emitted disabled and reported as degraded.
- `tools`: optional exact Codex `enabled_tools` allowlist. Omitting it does not claim a tool count.
- `startupTimeoutSec` and `toolTimeoutSec`: optional positive integer Codex timeouts.

For `transport: stdio`, use `command`, optional `args` and `cwd`, and these environment fields:

- `envVars`: same-name environment variables Codex may forward.
- `envMap`: target name to source name, such as `DATABASE_URI: PROJECT_DATABASE_URL`. Conductor
  creates a private name-only wrapper; it does not serialize the source value.
- `literalEnv`: bounded, non-secret selectors such as project or region. Credential-like names,
  interpolation, and credential-shaped values are rejected.

The command must be a bare executable on `PATH` or a relative executable contained in the
declaration's scope. `cwd` must also remain inside that scope.

For `transport: streamable-http`, use an HTTP(S) `url` and at most one authorization mechanism:

- `auth: oauth` maps truthfully to Codex's stored/default OAuth flow.
- `bearerTokenEnvVar: NAME` maps to Codex `bearer_token_env_var`.
- `envHttpHeaders` maps a header to an environment name. A value may also be
  `{ env: NAME, prefix: 'Basic ' }`; Conductor derives that header in the private launch process.

Non-secret literal headers may be declared separately:

- `httpHeaders` maps a header name to a bounded literal value, such as
  `X-Datadog-MCP-Toolsets: 'core,apm'`, translated to Codex `http_headers`. It is for
  explicitly non-secret request selectors only and fails closed on anything credential-like:
  header names containing `auth`, `bearer`, `cookie`, `credential`, `key`, `pass`, `secret`, or
  `token` in any case (covering `Authorization`, `Proxy-Authorization`, `Cookie`, `Set-Cookie`,
  `X-Api-Key`, and equivalents) are rejected — use a name-only `envHttpHeaders` reference instead.
  Values are limited to 256 characters of a printable selector charset, rejecting control
  characters, quotes, interpolation, `name=value` credential shapes, and leading/trailing spaces.
  Header names may not duplicate or case-collide with each other or with `envHttpHeaders` names.
  Literal header values appear only in the session's private Codex config, never in readiness
  output.

URLs with embedded credentials or credential-like query parameters are rejected. Arguments,
paths, URLs, and literals reject shell/template interpolation. Declarations contain environment
variable names only, never credential values. The selected names may come from the inherited
process environment or the fleet's owner-only `.conductor/.env`; only selected names are copied
from that fleet file or forwarded/derived for a declared server. The runtime otherwise retains its
normal inherited process environment.

Field support does not prove that a particular service's authentication is suitable for unattended
or end-user operation. Keep that server unselected until its authoritative producer contract names
a supported flow; interactive OAuth or a shared bearer must not be treated as identity proof merely
because Codex can transport it.

Complete copyable declarations are in
[`examples/mcp-project.yaml`](../examples/mcp-project.yaml) and
[`examples/mcp-engineering-manager.yaml`](../examples/mcp-engineering-manager.yaml).

## Select a session profile

Omitting `toolProfile` selects `defaultProfile`. Select a privileged composition explicitly:

```text
/spawn manager -r codex --tool-profile engineering-manager
```

Or persist it in an existing session file:

```yaml
codename: manager
repo: /path/to/project
runtime: codex
toolProfile: engineering-manager
```

An explicit profile on a runtime without declared-MCP support is rejected. A profile name that is
not defined in the fleet composition fails preparation.

When this feature is enabled, Conductor builds the selected MCP surface deterministically. It
removes shared `mcp_servers` tables only from the session's private copy of shared Codex config and
disables unselected project-local MCP IDs with launch overrides, except IDs the selected profile
names in `preserveSharedServers`. A selected declaration ID that conflicts with a project-local ID
fails preparation. The Conductor MCP server remains enabled and is never selectable from a
declaration.

## Read readiness truthfully

Every prepare writes an owner-only file at:

```text
<session configDir>/codex-mcp-readiness.json
```

Its v1 shape is:

```json
{
  "version": 1,
  "toolProfile": "worker",
  "schemaCacheDisposition": "fresh-process-on-launch",
  "callableParity": "not-asserted",
  "preservedSharedServerIds": [],
  "servers": [
    {
      "id": "project-api",
      "declarationId": "example-project",
      "transport": "streamable-http",
      "required": true,
      "declared": true,
      "configured": true,
      "enabled": true,
      "authenticated": "not-asserted",
      "connected": "not-asserted",
      "listed": "not-asserted",
      "invoked": "not-asserted",
      "declaredToolCount": 1,
      "schemaStatus": "pending-runtime-initialization",
      "missingCredentialNames": [],
      "missingPrerequisites": []
    }
  ]
}
```

This file is declared-to-configured evidence only. `pending-runtime-initialization` means the next
fresh Codex process must initialize the server schema. It is never proof that a tool is callable,
so `callableParity` remains `not-asserted`. A runtime-aware readiness consumer must compare it with
a separate live, freshly initialized callable-name snapshot.

`preservedSharedServerIds` lists the profile's approved shared connectors by name only; their
configuration and credentials stay wherever the operator set them up and are never inspected.
`missingCredentialNames` contains names only. `missingPrerequisites` contains bounded classes such
as `command` or `cwd`. No credential value, preview, or hash is written or logged. Required failures
still write this readiness artifact before start is rejected; optional failures remain visible with
`degraded-missing-prerequisites` and `enabled: false`.

The per-server stages keep declaration/configuration evidence separate from runtime evidence.
`authenticated`, `connected`, `listed`, and `invoked` are `not-attempted` when configuration is
incomplete and `not-asserted` after a valid prepare. A separate runtime consumer may advance those
states only from live evidence; the bridge never infers them from config text.

## Verify and troubleshoot

Validate fleet configuration before restart:

```bash
conductor validate
```

Run the repository's disposable no-credential fixture during development:

```bash
pnpm test:codex-mcp-fixture
```

The fixture launches a temporary Codex app-server process, initializes one harmless stdio MCP
schema, and asserts one callable tool without using a credential value.

If preparation fails, inspect the name-only readiness file. Repair the named environment variable,
command, or directory and start/continue again. If the declaration changed while Codex was already
running, restart/continue deliberately: a running connection retains its prior schema, and config
text alone cannot establish callable parity. OAuth may still require an interactive Codex login;
`required: true` makes Codex fail startup or resume if initialization cannot complete.

If unrelated shared or project MCP tools disappear, confirm that `declaredMcp` is intentionally
enabled. Deterministic isolation replaces the inherited MCP surface for that managed session; add
the required server to a selected declaration profile instead of relying on ambient configuration.
For a shared connector whose configuration and credentials should stay operator-owned (such as a
stored-OAuth service), add its ID to the selected profile's `preserveSharedServers` list instead of
redeclaring it.
