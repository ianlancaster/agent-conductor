import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  addWorktree,
  isWorktree,
  mainRepoFromGitdir,
  parseGitdirPointer,
  removeWorktree,
} from '../src/core/worktree.js';

describe('pure helpers', () => {
  it('parses gitdir pointer files', () => {
    expect(parseGitdirPointer('gitdir: /home/x/repo/.git/worktrees/agent-1\n')).toBe(
      '/home/x/repo/.git/worktrees/agent-1',
    );
    expect(parseGitdirPointer('not a pointer')).toBeNull();
  });

  it('derives the main repo from a worktree gitdir', () => {
    expect(mainRepoFromGitdir('/home/x/repo/.git/worktrees/agent-1')).toBe('/home/x/repo');
    expect(mainRepoFromGitdir('/home/x/elsewhere')).toBeNull();
  });
});

describe('git integration', () => {
  let base: string;
  let repo: string;

  const git = (cwd: string, ...args: string[]): string =>
    execFileSync('git', ['-C', cwd, '-c', 'user.name=t', '-c', 'user.email=t@t', ...args], { encoding: 'utf8' });

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
    const dir = join(base, 'agent-1');
    await addWorktree(repo, dir, 'agent-1');
    expect(existsSync(join(dir, 'README.md'))).toBe(true);
    expect(isWorktree(dir)).toBe(true);
    expect(isWorktree(repo)).toBe(false);
    expect(git(dir, 'rev-parse', '--abbrev-ref', 'HEAD').trim()).toBe('agent-1');

    await removeWorktree(dir);
    expect(existsSync(dir)).toBe(false);
    expect(git(repo, 'worktree', 'list')).not.toContain('agent-1');
  });

  it('checks out an existing branch when it already exists', async () => {
    git(repo, 'branch', 'feature-x');
    const dir = join(base, 'agent-2');
    await addWorktree(repo, dir, 'feature-x');
    expect(git(dir, 'rev-parse', '--abbrev-ref', 'HEAD').trim()).toBe('feature-x');
    await removeWorktree(dir);
  });

  it('refuses to remove a dirty worktree', async () => {
    const dir = join(base, 'agent-3');
    await addWorktree(repo, dir, 'agent-3');
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
});
