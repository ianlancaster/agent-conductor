import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { isolatedGitEnvironment, runGit } from '../src/core/git.js';
import {
  addWorktree,
  currentBranch,
  isWorktree,
  mainRepoFromGitdir,
  parseGitdirPointer,
  removeWorktree,
} from '../src/core/worktree.js';

describe('pure helpers', () => {
  it('parses gitdir pointer files', () => {
    expect(parseGitdirPointer('gitdir: /home/x/repo/.git/worktrees/session-1\n')).toBe(
      '/home/x/repo/.git/worktrees/session-1',
    );
    expect(parseGitdirPointer('not a pointer')).toBeNull();
  });

  it('derives the main repo from a worktree gitdir', () => {
    expect(mainRepoFromGitdir('/home/x/repo/.git/worktrees/session-1')).toBe('/home/x/repo');
    expect(mainRepoFromGitdir('/home/x/elsewhere')).toBeNull();
  });

  it('removes outer repository scope from a Git child environment', () => {
    const env = isolatedGitEnvironment({
      KEEP_ME: 'yes',
      GIT_COMMON_DIR: '/outer/.git',
      GIT_CONFIG_COUNT: '1',
      GIT_CONFIG_KEY_0: 'core.bare',
      GIT_CONFIG_VALUE_0: 'true',
      GIT_DIR: '/outer/.git/worktrees/linked',
      GIT_INDEX_FILE: '/outer/.git/worktrees/linked/index',
      GIT_WORK_TREE: '/outer/linked',
    });

    expect(env).toMatchObject({ KEEP_ME: 'yes', GIT_TERMINAL_PROMPT: '0' });
    expect(Object.keys(env).filter((key) => key.startsWith('GIT_'))).toEqual(['GIT_TERMINAL_PROMPT']);
  });
});

describe('git integration', () => {
  let base: string;
  let repo: string;

  // Strip repo-scoping GIT_* vars: when the suite runs inside a git hook
  // (husky pre-commit), the inherited GIT_DIR/GIT_INDEX_FILE point at the
  // conductor repo and would corrupt these tmp-repo commands.
  const gitEnv = isolatedGitEnvironment();
  const git = (cwd: string, ...args: string[]): string =>
    execFileSync('git', ['-C', cwd, '-c', 'user.name=t', '-c', 'user.email=t@t', ...args], {
      encoding: 'utf8',
      env: gitEnv,
    });

  beforeEach(() => {
    base = mkdtempSync(join(tmpdir(), 'conductor-wt-'));
    repo = join(base, 'main-repo');
    mkdirSync(repo);
    git(base, 'init', '-b', 'main', repo);
    writeFileSync(join(repo, 'README.md'), 'hello');
    git(repo, 'add', '.');
    git(repo, 'commit', '-m', 'init');
  });

  afterEach(() => {
    rmSync(base, { recursive: true, force: true });
  });

  it('adds a worktree on a new branch, detects it, and removes it', async () => {
    const dir = join(base, 'session-1');
    await addWorktree(repo, dir, 'session-1');
    expect(existsSync(join(dir, 'README.md'))).toBe(true);
    expect(isWorktree(dir)).toBe(true);
    expect(isWorktree(repo)).toBe(false);
    expect(currentBranch(repo)).toBe('main');
    expect(currentBranch(dir)).toBe('session-1');
    const nested = join(dir, 'nested');
    mkdirSync(nested);
    expect(currentBranch(nested)).toBe('session-1');
    expect(git(dir, 'rev-parse', '--abbrev-ref', 'HEAD').trim()).toBe('session-1');

    expect(await removeWorktree(dir)).toBe('session-1'); // reports the branch left behind
    expect(existsSync(dir)).toBe(false);
    expect(git(repo, 'worktree', 'list')).not.toContain('session-1');
  });

  it('checks out an existing branch when it already exists', async () => {
    git(repo, 'branch', 'feature-x');
    const dir = join(base, 'session-2');
    await addWorktree(repo, dir, 'feature-x');
    expect(git(dir, 'rev-parse', '--abbrev-ref', 'HEAD').trim()).toBe('feature-x');
    await removeWorktree(dir);
  });

  it('refuses to remove a dirty worktree', async () => {
    const dir = join(base, 'session-3');
    await addWorktree(repo, dir, 'session-3');
    writeFileSync(join(dir, 'uncommitted.txt'), 'work in progress');
    await expect(removeWorktree(dir)).rejects.toThrow();
    expect(existsSync(dir)).toBe(true);
  });

  it('rejects non-git repos', async () => {
    const notRepo = join(base, 'plain-dir');
    mkdirSync(notRepo);
    await expect(addWorktree(notRepo, join(base, 'x'), 'b')).rejects.toThrow(/not a git repository/);
  });

  it('rejects a branch name that could be smuggled in as a git flag (M15)', async () => {
    await expect(addWorktree(repo, join(base, 'x'), '--detach')).rejects.toThrow(/must not begin with/);
    expect(existsSync(join(base, 'x'))).toBe(false);
  });

  it('does not inherit linked-worktree hook scope into child Git commands', async () => {
    const hookWorktree = join(base, 'hook-worktree');
    git(repo, 'worktree', 'add', '-b', 'hook-worktree', hookWorktree);
    const hookGitDir = git(hookWorktree, 'rev-parse', '--absolute-git-dir').trim();
    const scratchRepo = join(base, 'scratch-repo');
    mkdirSync(scratchRepo);

    // This is the environment Git gives a pre-commit child in a linked
    // worktree. Without isolation, `git init` reinitializes hookGitDir,
    // changes the source's shared core.bare to true, and lists it as bare.
    const hookEnv = {
      ...process.env,
      GIT_DIR: hookGitDir,
      GIT_INDEX_FILE: join(hookGitDir, 'index'),
      GIT_COMMON_DIR: join(repo, '.git'),
      GIT_PREFIX: '',
    };
    await runGit(['-C', scratchRepo, 'init', '-b', 'main'], { env: hookEnv });

    expect(git(scratchRepo, 'rev-parse', '--show-toplevel').trim()).toBe(realpathSync(scratchRepo));
    expect(git(repo, 'config', '--get', 'core.bare').trim()).toBe('false');
    expect(git(repo, 'status', '--porcelain')).toBe('');
    const sourceEntry = git(repo, 'worktree', 'list', '--porcelain')
      .split('\n\n')
      .find((entry) => entry.startsWith(`worktree ${realpathSync(repo)}\n`));
    expect(sourceEntry).toBeDefined();
    expect(sourceEntry).not.toContain('\nbare');
  });
});
