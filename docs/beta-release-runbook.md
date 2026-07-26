# GitHub Beta Release Runbook

The internal beta ships as one npm-compatible tarball attached to a GitHub prerelease. It is not a
Git dependency and does not require npm publication. The exact bytes certified by CI are the bytes
installed by the cohort and can later be published to npm without rebuilding.

## One-time repository setup

Create a protected GitHub environment named `beta-release`. Require an approving reviewer and
restrict deployment branches to `main`. The release workflow also requires an explicit `release`
confirmation input and refuses non-main refs.

## Prepare and review

1. Confirm `main` is green and the working tree contains a Changeset for every user-visible change.
2. Review the pending Changesets and the target version. The first cohort build is
   `0.2.0-beta.0`.
3. Run `pnpm verify:package` locally. It packs the project, audits the allowlist, installs into a
   temporary global prefix without pnpm, exercises both binaries, scaffolds a disposable fleet,
   runs doctor/start, initializes PR Shepherd, and compiles an external consumer.
4. Review `README.md`, `CHANGELOG.md` when materialized, and the release-note policy below.

## Create the prerelease

From GitHub Actions, manually dispatch **GitHub beta release** on `main`. Enter the exact version and
type `release`. Approving the protected environment is the final authorization for the externally
visible release.

The workflow enters (or reuses) Changesets beta prerelease mode, materializes the version/changelog,
runs the full quality and coverage gate including real tmux E2E, packs and inspects the artifact,
installs it into disposable consumer prefixes, writes a SHA-256 checksum, creates the GitHub
prerelease at the source commit, and repeats installation from the final asset URL.

## Cohort installation

```bash
npm install --global https://github.com/ianlancaster/agent-conductor/releases/download/v0.2.0-beta.0/agent-conductor-0.2.0-beta.0.tgz
# or: pnpm add --global https://github.com/ianlancaster/agent-conductor/releases/download/v0.2.0-beta.0/agent-conductor-0.2.0-beta.0.tgz
# Yarn Classic 1.x only: yarn global add https://github.com/ianlancaster/agent-conductor/releases/download/v0.2.0-beta.0/agent-conductor-0.2.0-beta.0.tgz
conductor --version
conductor --help
```

npm and pnpm both document remote tarball sources; Yarn Classic documents global packages, while
[Yarn Modern removed `yarn global`](https://yarnpkg.com/migration/guide#cli-changes). Modern Yarn
users should use npm or pnpm for this durable CLI installation.

Upgrade by repeating the install with the next asset URL. Uninstall with:

```bash
npm uninstall --global agent-conductor
# pnpm remove --global agent-conductor
# Yarn Classic: yarn global remove agent-conductor
```

## Release policy

- Record the exact source commit in every release and publish the adjacent checksum.
- Keep a one-to-two-week internal feedback window before npm publication.
- Beta configuration and public APIs may change, but each change requires a Changeset and release
  note. Avoid silent migrations.
- `SessionRuntime`, `TerminalBackend`, and `ChannelAdapter` are the intended extension seams. The
  shipped Claude Code and Codex runtime classes remain explicitly experimental during beta.
- Never rebuild an already-published version. Promote or publish the certified tarball itself.
- Creating, editing, or deleting a GitHub release remains a separately approved external action.
