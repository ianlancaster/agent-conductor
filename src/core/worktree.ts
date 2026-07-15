import { execFile } from 'node:child_process';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

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
  await execFileAsync('git', args);
}

async function branchExists(repo: string, branch: string): Promise<boolean> {
  try {
    await execFileAsync('git', ['-C', repo, 'show-ref', '--verify', '--quiet', `refs/heads/${branch}`]);
    return true;
  } catch {
    return false;
  }
}

/** Remove a linked worktree via its main repository. Refuses dirty worktrees (no --force). */
export async function removeWorktree(dir: string): Promise<void> {
  const pointer = parseGitdirPointer(readFileSync(join(dir, '.git'), 'utf8'));
  if (pointer === null) throw new Error(`${dir}/.git has no gitdir pointer`);
  const mainRepo = mainRepoFromGitdir(pointer);
  if (mainRepo === null) throw new Error(`Cannot locate the main repository for worktree ${dir}`);
  await execFileAsync('git', ['-C', mainRepo, 'worktree', 'remove', dir]);
}
