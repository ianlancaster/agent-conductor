# GitHub Beta Onboarding Certification

Run this only in disposable directories. It does not use, stop, restart, or edit an existing fleet.
Run the Claude Code and Codex lanes separately so a failure has one clear runtime boundary.

## Candidate setup

Before the GitHub prerelease exists, create a pre-versioned package candidate from a clean `main`
checkout. It exercises the exact code and contents; the protected release workflow later materializes
the `0.2.0-beta.0` version and checksum:

```bash
pnpm verify:package
CANDIDATE_DIR="$(mktemp -d)"
npm pack --pack-destination "$CANDIDATE_DIR"
PREFIX="$(mktemp -d)"
npm install --global --prefix "$PREFIX" "$CANDIDATE_DIR"/agent-conductor-*.tgz
export PATH="$PREFIX/bin:$PATH"
conductor --version
pr-shepherd --version
```

After the authorized prerelease is created, repeat with its GitHub asset URL instead of the local
tarball. Both binary versions must equal the asset version.

## Lane A — Claude Code onboarding in iTerm2

1. Create and enter a new empty directory: `FLEET="$(mktemp -d)" && cd "$FLEET"`.
2. Read the iTerm2 Automation-permission note in `docs/getting-started.md`, then run
   `conductor doctor` and require no failures.
3. Run `conductor start`. Require the scaffold list and the `conductor>` prompt in the same
   terminal. Require no onboarding promotion or platform-permission reminder in routine CLI output.
4. Follow the README quick start: run `/spawn onboarding-helper`, move to the agent pane Conductor
   opens, and paste the documented onboarding brief directly into the assistant.
5. Require the Claude Code session to call `get_conductor_docs`, read `onboarding` and
   `fleet-configuration`, identify the authoritative disposable paths, and ask one decision at a
   time. Confirm it does not expose `.env` values or enable optional automation without approval.
6. Approve only a minimal hand-driven setup. Require clean `conductor validate` and
   `conductor doctor`, a message round trip, status, stop, and continue.
7. Stop with Ctrl-C. Require the Conductor process to end. Run `conductor start` again and require
   clean, concise startup output.
8. Delete only the disposable fleet after recording evidence.

## Lane B — Codex onboarding

1. Create a second disposable fleet and run `conductor start`.
2. Run the documented Codex variant: `/spawn onboarding-helper -r codex`.
3. Move to the agent pane Conductor opens and paste the README's onboarding brief directly into the
   assistant.
4. Require the same handbook discovery, one-decision interview, secret handling, manual-session
   shakedown, validation, doctor, status, stop, and continue evidence as Lane A.
5. Inspect only the disposable fleet. Require a per-session
   `.conductor/data/sessions/onboarding-helper/codex-home/AGENTS.override.md`, no generated
   repository-root `AGENTS.override.md`, and no Conductor-added repository `.gitignore` entry.
6. Continue the session and require the managed home override to still contain inherited operator
   guidance first, followed by the current Conductor protocol and any approved session prompt.
7. Delete only the disposable fleet after recording evidence.

## Release-asset confirmation

After the protected workflow creates the prerelease:

1. Verify the `.sha256` file against the downloaded tarball.
2. Install the GitHub URL with npm and one alternate manager used by the cohort (pnpm or Yarn
   Classic 1.x).
3. Repeat `conductor --version`, `conductor --help`, `conductor doctor`, and one fresh scaffold.
4. Record the release tag, source commit, package checksum, platform, terminal, Node version, and
   runtime versions in `BETA-CERTIFICATION.md`.

Do not create the GitHub prerelease until the operator separately authorizes the protected release
workflow.
