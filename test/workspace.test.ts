import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { isolatedGitEnvironment } from '../src/core/git.js';
import { materializeWorkspace, resolveTemplateSource } from '../src/core/workspace.js';

let baseDir: string;
let source: string;

const gitEnv = isolatedGitEnvironment();

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', ['-C', cwd, '-c', 'user.name=test', '-c', 'user.email=test@example.com', ...args], {
    encoding: 'utf8',
    env: gitEnv,
  });
}

beforeEach(() => {
  baseDir = mkdtempSync(join(tmpdir(), 'conductor-workspace-'));
  source = join(baseDir, 'source-template');
  mkdirSync(source);
  git(source, 'init', '-b', 'main');
  writeFileSync(join(source, 'version.txt'), 'one\n');
  git(source, 'add', '.');
  git(source, 'commit', '-m', 'version one');
  git(source, 'tag', 'v1');
  writeFileSync(join(source, 'version.txt'), 'two\n');
  git(source, 'add', '.');
  git(source, 'commit', '-m', 'version two');
});

afterEach(() => {
  rmSync(baseDir, { recursive: true, force: true });
});

describe('template workspace materialization', () => {
  it('clones a relative registered source, names its remote template, and checks out a configured ref', async () => {
    const destination = join(baseDir, 'nested', 'spawned');
    await materializeWorkspace(destination, {
      kind: 'template',
      template: { source: './source-template', ref: 'v1' },
      baseDir,
      timeoutMs: 5_000,
    });

    expect(git(destination, 'remote', 'get-url', 'template').trim()).toBe(source);
    expect(git(destination, 'describe', '--tags', '--exact-match').trim()).toBe('v1');
    expect(git(destination, 'show', 'HEAD:version.txt')).toBe('one\n');
  });

  it('does not merge a template into a non-empty destination', async () => {
    const destination = join(baseDir, 'occupied');
    mkdirSync(destination);
    writeFileSync(join(destination, 'keep.txt'), 'keep\n');

    await expect(
      materializeWorkspace(destination, {
        kind: 'template',
        template: { source },
        baseDir,
        timeoutMs: 5_000,
      }),
    ).rejects.toThrow(/not empty/);
    expect(existsSync(join(destination, 'keep.txt'))).toBe(true);
  });

  it('rejects an option-like ref before cloning', async () => {
    const destination = join(baseDir, 'bad-ref');
    await expect(
      materializeWorkspace(destination, {
        kind: 'template',
        template: { source, ref: '--orphan' },
        baseDir,
        timeoutMs: 5_000,
      }),
    ).rejects.toThrow(/must not begin/);
    expect(existsSync(destination)).toBe(false);
  });

  it('removes its private staging clone when ref checkout fails', async () => {
    const destination = join(baseDir, 'missing-ref');
    await expect(
      materializeWorkspace(destination, {
        kind: 'template',
        template: { source, ref: 'does-not-exist' },
        baseDir,
        timeoutMs: 5_000,
      }),
    ).rejects.toThrow();
    expect(existsSync(destination)).toBe(false);
  });
});

describe('template source resolution', () => {
  it('resolves relative paths while retaining URLs and scp-style sources', () => {
    expect(resolveTemplateSource('../template', '/fleet/root')).toBe('/fleet/template');
    expect(resolveTemplateSource('https://example.com/template.git', '/fleet/root')).toBe(
      'https://example.com/template.git',
    );
    expect(resolveTemplateSource('git@example.com:org/template.git', '/fleet/root')).toBe(
      'git@example.com:org/template.git',
    );
  });
});
