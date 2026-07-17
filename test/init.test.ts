import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { initFleet } from '../src/cli/init.js';
import { loadAgentConfigs, loadSupervisorConfig, validateConfig } from '../src/config/loader.js';

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
    expect(existsSync(join(baseDir, 'config', 'agents'))).toBe(true);
    expect(validateConfig(baseDir)).toEqual([]);
    // The template must not preconfigure a dangling sentinel (startup warning).
    expect(loadSupervisorConfig(baseDir).sentinel.codename).toBeUndefined();
  });

  it('writes a loadable first agent with --agent/--repo', () => {
    initFleet(baseDir, { agent: 'tester', repo: repoDir });
    const agents = loadAgentConfigs(baseDir);
    expect(agents.get('tester')?.repo).toBe(repoDir);
    expect(agents.get('tester')?.runtime).toBe('claude-code');
    expect(validateConfig(baseDir)).toEqual([]);
  });

  it('tells the user the exact next steps, including /start for a created agent', () => {
    const lines = initFleet(baseDir, { agent: 'tester', repo: repoDir });
    const text = lines.join('\n');
    expect(text).toContain('conductor validate');
    expect(text).toContain('conductor start');
    expect(text).toContain('/start tester');
  });

  it('suggests adding an agent when none was created', () => {
    const text = initFleet(baseDir).join('\n');
    expect(text).toContain('conductor init --agent <codename> --repo <project-path>');
  });

  it('never overwrites existing files', () => {
    const supervisorFile = join(baseDir, 'config', 'supervisor.yaml');
    mkdirSync(join(baseDir, 'config'), { recursive: true });
    writeFileSync(supervisorFile, 'defaults:\n  autonomy: autonomous\n');
    const agentFile = join(baseDir, 'config', 'agents', 'tester.yaml');
    mkdirSync(join(baseDir, 'config', 'agents'), { recursive: true });
    writeFileSync(agentFile, `codename: tester\nrepo: ${repoDir}\n`);

    const lines = initFleet(baseDir, { agent: 'tester', repo: repoDir });
    expect(lines.filter((l) => l.startsWith('kept')).length).toBe(2);
    expect(readFileSync(supervisorFile, 'utf8')).toContain('autonomous');
  });

  it('rejects an invalid codename', () => {
    expect(() => initFleet(baseDir, { agent: 'has space', repo: repoDir })).toThrow(/Invalid codename/);
  });

  it('requires --repo with --agent', () => {
    expect(() => initFleet(baseDir, { agent: 'tester' })).toThrow(/--repo/);
  });

  it('rejects a repo path that does not exist', () => {
    expect(() => initFleet(baseDir, { agent: 'tester', repo: join(baseDir, 'nope') })).toThrow(/does not exist/);
  });
});
