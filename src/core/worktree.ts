import { execFile } from 'node:child_process';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

/**
 * Run git with any inherited GIT_* repo-scoping env stripped. When the
 * conductor (or its test suite) runs inside a git hook, git exports
 * GIT_DIR/GIT_INDEX_FILE/GIT_WORK_TREE pointing at the OUTER repo — inheriting
 * them would make these commands operate on the wrong repository.
 */
function git(args: string[]): Promise<{ stdout: string; stderr: string }> {
  const env = { ...process.env };
  for (const key of ['GIT_DIR', 'GIT_INDEX_FILE', 'GIT_WORK_TREE', 'GIT_OBJECT_DIRECTORY', 'GIT_PREFIX']) {
    delete env[key];
  }
  return execFileAsync('git', args, { env });
}

/** Parse the `gitdir: <path>` pointer inside a worktree's .git FILE. */
export function parseGitdirPointer(content: string): string | null {
  const match = /^gitdir:\s*(.+)\s*$/m.exec(content);
  return match?.[1]?.trim() ?? null;
}

/** Main repository working directory from a worktree gitdir (…/.git/worktrees/<name>). */
export function mainRepoFromGitdir(gitdir: string): string | null {
  const marker = `${join('.git', 'worktrees')}/`;
  const index = gitdir.lastIndexOf(marker);
  if (index === -1) return null;
  return dirname(join(gitdir.slice(0, index), '.git'));
}

/** Whether a directory is a linked git worktree (its .git is a pointer file). */
export function isWorktree(dir: string): boolean {
  const gitPath = join(dir, '.git');
  try {
    return statSync(gitPath).isFile();
  } catch {
    return false;
  }
}

/** Read the checked-out branch without spawning git. Returns null outside a repo or when detached. */
export function currentBranch(dir: string): string | null {
  let cursor = resolve(dir);
  for (;;) {
    const dotGit = join(cursor, '.git');
    let stat: ReturnType<typeof statSync>;
    try {
      stat = statSync(dotGit);
    } catch {
      const parent = dirname(cursor);
      if (parent === cursor) return null;
      cursor = parent;
      continue;
    }

    try {
      let gitDir = dotGit;
      if (stat.isFile()) {
        const pointer = parseGitdirPointer(readFileSync(dotGit, 'utf8'));
        if (pointer === null) return null;
        gitDir = isAbsolute(pointer) ? pointer : resolve(cursor, pointer);
      } else if (!stat.isDirectory()) {
        return null;
      }
      const head = readFileSync(join(gitDir, 'HEAD'), 'utf8').trim();
      return /^ref:\s+refs\/heads\/(.+)$/.exec(head)?.[1] ?? null;
    } catch {
      return null;
    }
  }
}

/**
 * Create a worktree of `repo` at `dir` on `branch`. Creates the branch when it
 * does not exist; checks out the existing branch when it does.
 */
export async function addWorktree(repo: string, dir: string, branch: string): Promise<void> {
  if (!existsSync(join(repo, '.git'))) {
    throw new Error(`${repo} is not a git repository`);
  }
  // A branch name is never an option: reject leading dashes so a value like
  // `--detach`/`--force` can't be smuggled in as a git flag, and pass `--` so
  // git stops option parsing before the branch/dir positionals.
  if (branch.startsWith('-')) {
    throw new Error(`Invalid branch name '${branch}': must not begin with '-'.`);
  }
  const exists = await branchExists(repo, branch);
  const args = exists
    ? ['-C', repo, 'worktree', 'add', '--', dir, branch]
    : ['-C', repo, 'worktree', 'add', '-b', branch, '--', dir];
  await git(args);
}

async function branchExists(repo: string, branch: string): Promise<boolean> {
  try {
    await git(['-C', repo, 'show-ref', '--verify', '--quiet', `refs/heads/${branch}`]);
    return true;
  } catch {
    return false;
  }
}

/** Remove a linked worktree via its main repository. Refuses dirty worktrees (no --force). */
/** Remove a linked worktree. Returns the branch it had checked out (kept in the main repo), or null if detached. */
export async function removeWorktree(dir: string): Promise<string | null> {
  const pointer = parseGitdirPointer(readFileSync(join(dir, '.git'), 'utf8'));
  if (pointer === null) throw new Error(`${dir}/.git has no gitdir pointer`);
  const mainRepo = mainRepoFromGitdir(pointer);
  if (mainRepo === null) throw new Error(`Cannot locate the main repository for worktree ${dir}`);
  const { stdout } = await git(['-C', dir, 'rev-parse', '--abbrev-ref', 'HEAD']);
  const branch = stdout.trim();
  await git(['-C', mainRepo, 'worktree', 'remove', dir]);
  return branch === 'HEAD' || branch.length === 0 ? null : branch;
}
