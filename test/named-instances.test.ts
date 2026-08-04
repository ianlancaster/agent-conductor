import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ensureFleetScaffold } from '../src/cli/scaffold.js';
import { launchdLabel, renderLaunchdPlist, renderSystemdService, systemdUnit } from '../src/cli/daemon.js';
import { loadSupervisorConfig } from '../src/config/loader.js';
import { resolveConductorInstance } from '../src/config/paths.js';
import { Supervisor } from '../src/core/supervisor.js';
import { encodeSessionVar, parseRediscoveryOutput } from '../src/terminals/iterm/applescript.js';
import { encodeSessionOption, parseSessionPanes } from '../src/terminals/tmux/tmux.js';
import { FakeEventSubscriber } from './fakes/fake-subscriber.js';
import { FakeRuntime } from './fakes/fake-runtime.js';
import { FakeTerminalBackend } from './fakes/fake-terminal.js';

let baseDir: string;
const supervisors: Supervisor[] = [];

beforeEach(() => {
  baseDir = mkdtempSync(join(tmpdir(), 'conductor-named-instances-'));
});

afterEach(async () => {
  for (const supervisor of supervisors.splice(0).reverse()) await supervisor.stop();
  rmSync(baseDir, { recursive: true, force: true });
});

function addSession(instance: string | undefined): void {
  ensureFleetScaffold(baseDir, instance);
  const resolved = resolveConductorInstance(baseDir, instance);
  const repo = join(baseDir, `workspace-${instance ?? 'default'}`);
  mkdirSync(repo, { recursive: true });
  writeFileSync(
    join(resolved.paths.sessionsDir, 'worker.yaml'),
    `codename: worker\nrepo: ${repo}\nruntime: claude-code\n`,
  );
}

describe('named instances', () => {
  it('runs the default and two named instances with isolated process, pane, event, and storage identity', async () => {
    addSession(undefined);
    addSession('frontend');
    addSession('backend');

    const selections = [undefined, 'frontend', 'backend'] as const;
    const resolved = selections.map((name) => resolveConductorInstance(baseDir, name));
    const configs = resolved.map((instance) => loadSupervisorConfig(instance));
    expect(new Set(resolved.map((instance) => instance.fleetId))).toHaveLength(3);
    expect(new Set(configs.map((config) => config.mcp.port))).toHaveLength(3);
    expect(new Set(configs.map((config) => config.terminal.tmux.sessionName))).toHaveLength(3);
    expect(new Set(configs.map((config) => config.terminal.windowName))).toHaveLength(3);
    expect(new Set(selections.map((name) => launchdLabel(baseDir, name)))).toHaveLength(3);
    expect(new Set(selections.map((name) => systemdUnit(baseDir, name)))).toHaveLength(3);

    const [defaultInstance, frontendInstance, backendInstance] = resolved;
    expect(defaultInstance).toBeDefined();
    expect(frontendInstance).toBeDefined();
    expect(backendInstance).toBeDefined();
    const tmuxMarkers = [
      `%1 ${encodeSessionOption(frontendInstance!.fleetId, 'worker')}`,
      `%2 ${encodeSessionOption(backendInstance!.fleetId, 'worker')}`,
    ].join('\n');
    expect(parseSessionPanes(tmuxMarkers, frontendInstance!.fleetId)).toEqual(new Map([['worker', '%1']]));
    const itermMarkers = [
      `frontend-pane|${encodeSessionVar(frontendInstance!.fleetId, 'worker')}`,
      `backend-pane|${encodeSessionVar(backendInstance!.fleetId, 'worker')}`,
    ].join('\n');
    expect(parseRediscoveryOutput(itermMarkers, frontendInstance!.fleetId)).toEqual(
      new Map([['worker', 'frontend-pane']]),
    );
    expect(renderLaunchdPlist(baseDir, '/tmp/data', 'frontend', '/usr/bin/node', '/usr/bin/conductor')).toContain(
      '<string>--instance</string>\n    <string>frontend</string>\n    <string>start</string>',
    );
    expect(renderSystemdService(baseDir, 'frontend', '/usr/bin/node', '/usr/bin/conductor')).toContain(
      'ExecStart=/usr/bin/node /usr/bin/conductor --instance frontend start --foreground',
    );
    expect(renderSystemdService(baseDir, undefined, '/usr/bin/node', '/usr/bin/conductor')).toContain(
      'ExecStart=/usr/bin/node /usr/bin/conductor start --foreground',
    );

    const subscribers = selections.map(() => new FakeEventSubscriber());
    for (const [index, name] of selections.entries()) {
      const supervisor = new Supervisor(baseDir, {
        ...(name === undefined ? {} : { instance: name }),
        terminalBackend: new FakeTerminalBackend(),
        runtimes: [new FakeRuntime('claude-code')],
        includeConfiguredChannels: false,
        eventSubscribers: [subscribers[index]!],
        env: {},
      });
      supervisors.push(supervisor);
      await supervisor.start();
    }

    const emittedFleetIds = subscribers.map((subscriber) => subscriber.events[0]?.fleetId);
    expect(new Set(emittedFleetIds)).toHaveLength(3);
    for (const instance of resolved) {
      const dataDir = join(baseDir, loadSupervisorConfig(instance).paths.dataDir);
      expect(existsSync(join(dataDir, 'conductor.db'))).toBe(true);
      expect(existsSync(join(dataDir, 'conductor.lock'))).toBe(true);
    }
  });
});
