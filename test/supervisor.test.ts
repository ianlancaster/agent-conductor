import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Supervisor } from '../src/core/supervisor.js';

let baseDir: string;
let supervisor: Supervisor | undefined;

function writeConfig(supervisorYaml: string, sessions: Record<string, string>): void {
  mkdirSync(join(baseDir, 'config', 'sessions'), { recursive: true });
  writeFileSync(join(baseDir, 'config', 'supervisor.yaml'), supervisorYaml);
  for (const [name, content] of Object.entries(sessions)) {
    writeFileSync(join(baseDir, 'config', 'sessions', `${name}.yaml`), content);
  }
}

beforeEach(() => {
  baseDir = mkdtempSync(join(tmpdir(), 'conductor-sup-'));
});

afterEach(async () => {
  await supervisor?.stop();
  supervisor = undefined;
  rmSync(baseDir, { recursive: true, force: true });
});

/**
 * Construction smoke test: the full dependency graph must assemble from config
 * alone — wiring mistakes (wrong config slice, circular init) fail here instead
 * of at runtime. No terminal/network side effects before start().
 */
describe('Supervisor construction', () => {
  it('assembles the full graph from a tmux config and reports status', async () => {
    writeConfig('terminal:\n  backend: tmux\nmcp:\n  port: 43391\nsentinel:\n  codename: watch\n', {
      alpha: `codename: alpha\nrepo: ${baseDir}\n`,
      watch: `codename: watch\nrepo: ${baseDir}\n`,
    });
    supervisor = new Supervisor(baseDir);

    const status = supervisor.statusReport();
    expect(status).toContain('alpha');
    expect(status).toContain('watch');
    expect(status).toContain('🛡'); // sentinel marker
    expect(status).not.toContain('No sentinel configured');
  });

  it('assembles with the iTerm backend and warns about a missing sentinel', () => {
    writeConfig('terminal:\n  backend: iterm\nmcp:\n  port: 43392\n', {
      alpha: `codename: alpha\nrepo: ${baseDir}\n`,
    });
    supervisor = new Supervisor(baseDir);
    expect(supervisor.statusReport()).toContain('No sentinel configured');
  });

  it('routes operator commands through the shared router', async () => {
    writeConfig('terminal:\n  backend: tmux\nmcp:\n  port: 43393\n', {
      alpha: `codename: alpha\nrepo: ${baseDir}\n`,
    });
    supervisor = new Supervisor(baseDir);

    expect(await supervisor.command('/help')).toContain('/status');
    expect(await supervisor.command('/start ghost')).toBe('Unknown session: ghost');
    expect(await supervisor.command('/tag alpha smoke test')).toContain('smoke test');
    expect(await supervisor.command('/auto alpha')).toBe('alpha set to autonomous.');
    expect(supervisor.statusReport('alpha')).toContain('"autonomy": "autonomous"');
  });

  it('persists session state across supervisor instances (single SQLite store)', async () => {
    writeConfig('terminal:\n  backend: tmux\nmcp:\n  port: 43394\n', {
      alpha: `codename: alpha\nrepo: ${baseDir}\n`,
    });
    supervisor = new Supervisor(baseDir);
    await supervisor.command('/auto alpha');
    await supervisor.command('/tag alpha carry-over');
    await supervisor.stop();

    supervisor = new Supervisor(baseDir);
    const status = supervisor.statusReport('alpha');
    expect(status).toContain('"autonomy": "autonomous"');
    expect(status).toContain('"tag": "carry-over"');
  });

  it('keeps persisted state when a config transiently fails to parse (M13)', async () => {
    writeConfig('terminal:\n  backend: tmux\nmcp:\n  port: 43396\n', {
      alpha: `codename: alpha\nrepo: ${baseDir}\n`,
    });
    supervisor = new Supervisor(baseDir);
    await supervisor.command('/auto alpha');

    // Simulate an editor's mid-write atomic save: the file exists but is invalid.
    writeFileSync(join(baseDir, 'config', 'sessions', 'alpha.yaml'), 'codename: alpha\nrepo:\n  - bad');
    await supervisor.command('/status'); // any op; the reload runs on the watcher, so force one:
    supervisor.reloadSessionsForTest();

    expect(supervisor.statusReport()).toContain('alpha');
    expect(supervisor.statusReport('alpha')).toContain('"autonomy": "autonomous"');
  });

  it('deregisters and clears state when a config is genuinely removed', async () => {
    writeConfig('terminal:\n  backend: tmux\nmcp:\n  port: 43397\n', {
      alpha: `codename: alpha\nrepo: ${baseDir}\n`,
    });
    supervisor = new Supervisor(baseDir);
    await supervisor.command('/auto alpha');
    rmSync(join(baseDir, 'config', 'sessions', 'alpha.yaml'));
    supervisor.reloadSessionsForTest();
    expect(supervisor.statusReport()).toContain('No sessions configured');
  });

  it('flags marker-file repos as agent projects in status', () => {
    const repo = join(baseDir, 'session-repo');
    mkdirSync(repo, { recursive: true });
    writeFileSync(join(repo, '.conductor-agent'), '');
    writeConfig('terminal:\n  backend: tmux\nmcp:\n  port: 43395\n', {
      alpha: `codename: alpha\nrepo: ${repo}\n`,
    });
    supervisor = new Supervisor(baseDir);
    expect(supervisor.statusReport()).toContain('🤖');
  });
});
