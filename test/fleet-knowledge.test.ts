import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { findFederationRoot, fleetKnowledgeNotice } from '../src/core/documentation.js';
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

  it('adds the Federation sentence only when an ancestor holds both marker and index', () => {
    const federation = join(dir, 'federation');
    const fleet = join(federation, 'fleets', 'alpha');
    mkdirSync(fleet, { recursive: true });
    const federationSentence = 'Federation knowledge base';

    expect(fleetKnowledgeNotice(fleet)).toBeUndefined();

    writeFileSync(join(federation, 'federation.toml'), 'name = "home"\n');
    expect(findFederationRoot(fleet)).toBe(federation);
    expect(fleetKnowledgeNotice(fleet)).toBeUndefined();

    rmSync(join(federation, 'federation.toml'));
    writeFileSync(join(federation, 'knowledge-index.toml'), 'include = ["knowledge"]\nexclude = []\n');
    expect(findFederationRoot(fleet)).toBeUndefined();
    expect(fleetKnowledgeNotice(fleet)).toBeUndefined();

    writeFileSync(join(federation, 'federation.toml'), 'name = "home"\n');
    const both = fleetKnowledgeNotice(fleet);
    expect(both).toContain(federationSentence);
    expect(both).toContain(`listed in \`${join(federation, 'knowledge-index.toml')}\``);
    expect(both).toContain('`_inbox/`');
    expect(both).not.toContain('This fleet has a shared knowledge base');

    writeFileSync(join(fleet, 'knowledge-index.toml'), 'include = ["knowledge"]\nexclude = []\n');
    const withFleet = fleetKnowledgeNotice(fleet);
    expect(withFleet?.indexOf('This fleet has a shared knowledge base')).toBe(0);
    expect(withFleet).toContain(federationSentence);
  });

  it('never treats the fleet directory itself as its Federation root', () => {
    writeFileSync(join(dir, 'federation.toml'), 'name = "home"\n');
    writeFileSync(join(dir, 'knowledge-index.toml'), 'include = ["knowledge"]\nexclude = []\n');
    expect(fleetKnowledgeNotice(dir)).not.toContain('Federation knowledge base');
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
