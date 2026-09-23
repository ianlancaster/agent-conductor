import { realpath } from 'node:fs/promises';
import path from 'node:path';
import { runGit } from './git.js';

const GIT_TIMEOUT_MS = 5_000;

/**
 * Paths a session's working directory should be pre-trusted under, for any
 * runtime whose folder-trust gate compares RESOLVED paths and applies trust
 * at the Git repository ROOT rather than necessarily the literal cwd. Shared
 * by the Codex and Claude Code runtimes — both compare resolved paths, and
 * both apply trust at the repository root for a linked worktree, which is
 * the MAIN worktree's root, not the worktree's own directory.
 *
 * Returns, in order and without duplicates:
 *  - the literal, unresolved cwd (harmless to keep; preserves behavior for
 *    any runtime code path that compares literally instead of resolving
 *    symlinks);
 *  - the realpath of the cwd (symlinks resolved — e.g. macOS's /tmp ->
 *    /private/tmp);
 *  - the resolved worktree's own top level (`git rev-parse --show-toplevel`);
 *  - the resolved repository root, derived from `git rev-parse
 *    --git-common-dir`, ONLY when the common dir sits directly inside it as
 *    `.git` (the standard layout). A bare repository or `--separate-git-dir`
 *    puts the common dir elsewhere (e.g. /x/repos/foo.git), and naively
 *    trusting its dirname would trust the PARENT directory — one that can
 *    hold many unrelated repositories. Trust is a security control, so that
 *    entry is skipped rather than trusted too broadly.
 *
 * Not a Git repository (or git unavailable): only the cwd entries are
 * returned.
 */
export async function resolveTrustPaths(repo: string): Promise<string[]> {
  const paths: string[] = [];
  const addUnique = (candidate: string): void => {
    if (!paths.includes(candidate)) paths.push(candidate);
  };

  addUnique(repo);
  addUnique(await realpathOrSelf(repo));

  try {
    const [commonDirResult, toplevelResult] = await Promise.all([
      runGit(['-C', repo, 'rev-parse', '--path-format=absolute', '--git-common-dir'], { timeoutMs: GIT_TIMEOUT_MS }),
      runGit(['-C', repo, 'rev-parse', '--path-format=absolute', '--show-toplevel'], { timeoutMs: GIT_TIMEOUT_MS }),
    ]);
    const commonDir = commonDirResult.stdout.trim();
    const toplevel = toplevelResult.stdout.trim();
    if (toplevel.length > 0) addUnique(await realpathOrSelf(toplevel));
    if (commonDir.length > 0 && path.basename(commonDir) === '.git') {
      addUnique(await realpathOrSelf(path.dirname(commonDir)));
    }
  } catch {
    // Not a Git repository (or git unavailable) — trusting the cwd is enough.
  }

  return paths;
}

/** realpath() resolves symlinks; a missing/unreadable path just trusts itself as given. */
async function realpathOrSelf(candidate: string): Promise<string> {
  try {
    return await realpath(candidate);
  } catch {
    return candidate;
  }
}
