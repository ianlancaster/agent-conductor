import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { initFleet } from '../src/cli/init.js';
import { loadSessionConfigs, loadSupervisorConfig, validateConfig } from '../src/config/loader.js';

let baseDir: string;
let repoDir: string;

beforeEach(() => {
  baseDir = mkdtempSync(join(tmpdir(), 'conductor-init-'));
  repoDir = join(baseDir, 'some-project');
  mkdirSync(repoDir);
});

afterEach(() => {
  rmSync(baseDir, { recursive: true, force: true });
});

describe('initFleet', () => {
  it('scaffolds a fleet dir that immediately validates and starts warning-free', () => {
    const lines = initFleet(baseDir);
    expect(lines[0]).toMatch(/^created .*supervisor\.yaml$/);
    expect(existsSync(join(baseDir, 'env.template'))).toBe(true);
    expect(existsSync(join(baseDir, 'config', 'sessions'))).toBe(true);
    expect(validateConfig(baseDir)).toEqual([]);
    // The template must not preconfigure a dangling sentinel (startup warning).
    expect(loadSupervisorConfig(baseDir).sentinel.codename).toBeUndefined();
  });

  it('writes a loadable first session with --session/--repo', () => {
    initFleet(baseDir, { session: 'tester', repo: repoDir });
    const sessions = loadSessionConfigs(baseDir);
    expect(sessions.get('tester')?.repo).toBe(repoDir);
    expect(sessions.get('tester')?.runtime).toBe('claude-code');
    expect(validateConfig(baseDir)).toEqual([]);
  });

  it('tells the user the exact next steps, including /start for a created session', () => {
    const lines = initFleet(baseDir, { session: 'tester', repo: repoDir });
    const text = lines.join('\n');
    expect(text).toContain('conductor validate');
    expect(text).toContain('conductor start');
    expect(text).toContain('/start tester');
  });

  it('suggests adding a session when none was created', () => {
    const text = initFleet(baseDir).join('\n');
    expect(text).toContain('conductor init --session <codename> --repo <project-path>');
  });

  it('never overwrites existing files', () => {
    const supervisorFile = join(baseDir, 'config', 'supervisor.yaml');
    mkdirSync(join(baseDir, 'config'), { recursive: true });
    writeFileSync(supervisorFile, 'defaults:\n  auto: true\n');
    const sessionFile = join(baseDir, 'config', 'sessions', 'tester.yaml');
    mkdirSync(join(baseDir, 'config', 'sessions'), { recursive: true });
    writeFileSync(sessionFile, `codename: tester\nrepo: ${repoDir}\n`);
    const environmentTemplate = join(baseDir, 'env.template');
    writeFileSync(environmentTemplate, 'KEEP_ME=yes\n');

    const lines = initFleet(baseDir, { session: 'tester', repo: repoDir });

    expect(lines.filter((l) => l.startsWith('kept')).length).toBe(3);
    expect(readFileSync(supervisorFile, 'utf8')).toContain('auto: true');
    expect(readFileSync(environmentTemplate, 'utf8')).toBe('KEEP_ME=yes\n');
  });

  it('rejects an invalid codename', () => {
    expect(() => initFleet(baseDir, { session: 'has space', repo: repoDir })).toThrow(/Invalid codename/);
  });

  it('requires --repo with --session', () => {
    expect(() => initFleet(baseDir, { session: 'tester' })).toThrow(/--repo/);
  });

  it('rejects a repo path that does not exist', () => {
    expect(() => initFleet(baseDir, { session: 'tester', repo: join(baseDir, 'nope') })).toThrow(/does not exist/);
  });
});
