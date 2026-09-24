import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { fleetKnowledgeNotice } from '../src/core/documentation.js';
import { Supervisor } from '../src/core/supervisor.js';
import { FakeTerminalBackend } from './fakes/fake-terminal.js';

let dir: string;
let supervisor: Supervisor | undefined;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'conductor-fleet-knowledge-'));
});

afterEach(async () => {
  await supervisor?.stop();
  supervisor = undefined;
  rmSync(dir, { recursive: true, force: true });
});

describe('fleet knowledge protocol notice', () => {
  it('names the index file only when it exists', () => {
    expect(fleetKnowledgeNotice(dir)).toBeUndefined();
    writeFileSync(join(dir, 'knowledge-index.toml'), 'include = ["knowledge"]\nexclude = []\n');
    const notice = fleetKnowledgeNotice(dir);
    expect(notice).toContain(`the markdown folders listed in \`${join(dir, 'knowledge-index.toml')}\``);
    expect(notice).toContain('topic `fleet-knowledge` before adding a folder');
  });

  it('follows the index file at each session start without a Conductor restart', async () => {
    const configDir = join(dir, 'config');
    mkdirSync(join(configDir, 'sessions'), { recursive: true });
    writeFileSync(join(configDir, 'sessions', 'worker.yaml'), `codename: worker\nrepo: ${dir}\nruntime: claude-code\n`);
    writeFileSync(join(configDir, 'supervisor.yaml'), 'terminal:\n  backend: tmux\n');
    supervisor = new Supervisor(dir, {
      terminalBackend: new FakeTerminalBackend(),
      includeConfiguredChannels: false,
      claudeJsonPath: join(dir, 'claude.json'),
      env: {},
    });
    const snapshot = join(dir, 'data', 'sessions', 'worker', 'conductor-protocol.md');

    await supervisor.command('/start worker');
    expect(readFileSync(snapshot, 'utf8')).not.toContain('shared knowledge base');
    await supervisor.command('/stop worker');

    writeFileSync(join(dir, 'knowledge-index.toml'), 'include = ["knowledge"]\nexclude = []\n');
    await supervisor.command('/start worker');
    expect(readFileSync(snapshot, 'utf8')).toContain('This fleet has a shared knowledge base');

    await supervisor.command('/stop worker');
    rmSync(join(dir, 'knowledge-index.toml'));
    await supervisor.command('/start worker');
    expect(readFileSync(snapshot, 'utf8')).not.toContain('shared knowledge base');
  });
});
