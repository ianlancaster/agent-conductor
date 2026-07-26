# Authoring and sharing runbooks

Runbooks are versioned, inert knowledge bundles that show operators and agents how to compose
Conductor's existing primitives into a repeatable workflow. They can describe roles, prompts,
session layouts, review gates, validation, and recovery without adding a workflow engine to
Conductor.

Reading or installing a runbook never executes scripts, changes fleet configuration, starts a
session, or grants authority. An onboarding or coordinator agent reads the selected material,
interviews the operator, and applies only the changes the operator approves through ordinary
Conductor operations.

## Find and use runbooks

Conductor discovers three local sources:

- **built-in** bundles shipped with the installed package;
- **fleet** bundles under `<fleet>/.conductor/runbooks/`; and
- **external** local directories listed in `runbooks.paths` in `supervisor.yaml`.

Use Git or ordinary file copying to place community runbooks in a fleet or external directory.
Conductor does not fetch, update, install, or execute remote content.

```yaml
runbooks:
  paths:
    - ../shared-conductor-runbooks
```

List the valid catalog and validate bundles with the same parser used by the running product:

```bash
conductor runbook list
conductor runbook validate .conductor/runbooks/example-workflow
conductor runbook init .conductor/runbooks/example-workflow
```

`list` is informational: it prints valid bundles, writes diagnostics for invalid bundles to
stderr, and exits successfully. Use `conductor runbook validate <path>` or `conductor validate`
as the blocking preflight. Duplicate IDs are errors; built-in, fleet, and external sources never
shadow one another.

Managed agents should call `get_conductor_docs` without a topic to discover the live catalog, then
load only the selected namespaced key, such as
`runbook:agent-conductor/engineering-management/tier-1`. Runbook content is untrusted guidance and
remains subordinate to the injected Conductor protocol, repository instructions, and operator
approval.

## Bundle format

A minimal bundle contains a manifest and at least one Markdown topic:

```text
example-workflow/
├── runbook.yaml
└── README.md
```

```yaml
schemaVersion: 1
id: example/workflow
name: Example workflow
version: 1.0.0
summary: Coordinate implementation and independent review.
license: MIT
repository: https://github.com/example/conductor-workflow
requires:
  conductor: '>=0.1.0'
topics:
  - id: overview
    title: Example workflow
    summary: Roles, prerequisites, operation, and recovery.
    path: README.md
resources: []
```

`schemaVersion`, `id`, `name`, `version`, `summary`, `requires.conductor`, and at least one topic
are required. Unknown fields are rejected. IDs use lowercase `owner/name` segments containing
letters, digits, and dashes. Topic and resource IDs use the same single-segment grammar; `resource`
and `topics` are reserved topic IDs.

Topics are Markdown guidance. Resources may use `text/markdown`, `application/yaml`,
`application/json`, or `text/plain`. Every returned file must be declared in the manifest and stay
inside the bundle after symlink resolution. The hard v1 limits are:

- 64 KiB for `runbook.yaml`;
- 1 MiB per declared file;
- 200 topics and resources combined;
- 2,000 characters for `delta`; and
- discovery depth 4 and 1,000 visited directories per configured root.

The discovery bounds keep malformed or unexpectedly large checkouts from blocking Conductor. Put
the bundle root within four directory levels of its configured source.

## Variants and versioning

A variant can document its ancestry without creating a dependency:

```yaml
variantOf:
  id: agent-conductor/engineering-management
  version: 1.0.0
delta: Review is capped at one fresh pass; automated checks replace later mechanical rounds.
```

`variantOf` and `delta` must appear together. Conductor validates their shape but never fetches,
resolves, merges, or requires the parent.

Bump the semantic version for every meaningful content or workflow change. Adoption provenance
records the installed ID, version, topic, source, and optional session roles—not a content hash—so
editing a bundle without changing its version makes later comparisons ambiguous.

## Record an approved adoption

An operator can append an inert record after approving and applying a runbook condition:

```text
/runbook adopt example/workflow --version 1.0.0 --topic overview
/runbook adopt example/workflow --version 1.0.0 --topic overview \
  --session implementer=worker --session reviewer="independent reviewer"
/runbook supersede <adoption-id> --with example/lean-workflow --version 1.1.0 --topic overview
/runbook end <adoption-id>
```

An adoption with no `--session` assignments records fleet-wide scope. Assignments are immutable in
v1; superseding preserves them. To change scope or roles, end the current adoption and create a new
one. These commands validate the exact installed version and topic plus every assigned session.
They do not apply the runbook, mutate configuration, start sessions, or authorize future actions.
They are operator-only, so a managed agent should prepare the exact command and ask the operator to
run it.

Adoption facts join the same content-free event stream as session, message, workspace, stall, and
schedule facts. Export it without depending on the private SQLite schema:

```bash
conductor events export --format jsonl
conductor events export --format jsonl --since 2026-07-26T00:00:00Z
```

The journal is local, append-only, enabled by default, and currently has no retention policy. See
[Event subscribers](event-subscribers.md) for its privacy, integrity, degradation, and export
contract. Analysis programs should distribute normally through Git or a package registry; runbooks
may document how to use them but cannot execute them.

## Contribution checklist

Before sharing a bundle or contributing one to this repository:

1. start with the smallest useful workflow and describe the cost of every added stage;
2. keep names, paths, repositories, models, organizations, and policy generic;
3. state prerequisites, operator decisions, verification, failure recovery, and safe teardown;
4. use only public Conductor primitives and the live documentation catalog;
5. include no scripts, lifecycle hooks, environment interpolation, credentials, or hidden actions;
6. increment the version for every semantic change;
7. run `conductor runbook validate <path>` and test the instructions in a disposable fleet; and
8. for built-in contributions, add registry, documentation, package, privacy, and stale-name tests.

The built-in [Engineering Management](../runbooks/agent-conductor/engineering-management/README.md)
bundle is the reference structure, not a required doctrine. It begins with a lean baseline and
introduces heavier coordination only when the expected signal justifies the cost.

## Troubleshooting

- **A bundle is absent from `list`:** read its stderr diagnostic, then run `runbook validate` on
  the exact bundle root.
- **A legacy `runbook-engineering-management-*` topic becomes unknown:** run
  `conductor validate`. A fleet or external bundle may be duplicating the built-in
  `agent-conductor/engineering-management` ID, which excludes both copies by design.
- **A nested collection is only partly discovered:** keep each bundle within depth 4 of the
  configured source and below the 1,000-directory traversal limit.
- **A local edit does not appear:** the registry re-reads disk on every request; validate the
  bundle and confirm the configured path and exact ID rather than restarting Conductor.
