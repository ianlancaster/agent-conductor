import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Supervisor } from '../src/core/supervisor.js';
import { FakeRuntime } from './fakes/fake-runtime.js';
import { FakeTerminalBackend } from './fakes/fake-terminal.js';

// Drive the real Supervisor scheduler deterministically without production clock waits.
const { ticks } = vi.hoisted(() => ({ ticks: [] as (() => Promise<void>)[] }));
vi.mock('croner', () => ({
  Cron: class {
    constructor(_pattern: string, _options: unknown, tick: () => Promise<void>) {
      ticks.push(tick);
    }
    stop(): void {
      // No real timer was armed by this test double.
    }
  },
}));

let baseDir: string | undefined;
let supervisor: Supervisor | undefined;

async function setup(scheduleOptions = ''): Promise<FakeTerminalBackend> {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('Missing test port');
  const port = address.port;
  await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
  baseDir = mkdtempSync(join(tmpdir(), 'conductor-schedule-seam-'));
  mkdirSync(join(baseDir, 'config', 'sessions'), { recursive: true });
  writeFileSync(join(baseDir, 'config', 'supervisor.yaml'), `mcp:\n  port: ${String(port)}\n`);
  writeFileSync(
    join(baseDir, 'config', 'sessions', 'alpha.yaml'),
    `codename: alpha\nrepo: ${baseDir}\nschedules:\n  - cron: '0 9 * * *'\n    prompt: scheduled work\n${scheduleOptions}`,
  );
  const terminal = new FakeTerminalBackend();
  supervisor = new Supervisor(baseDir, {
    terminalBackend: terminal,
    runtimes: [new FakeRuntime()],
    includeConfiguredChannels: false,
    env: {},
  });
  await supervisor.start();
  return terminal;
}

afterEach(async () => {
  vi.useRealTimers();
  await supervisor?.stop();
  supervisor = undefined;
  if (baseDir !== undefined) rmSync(baseDir, { recursive: true, force: true });
  baseDir = undefined;
  ticks.length = 0;
});

describe('Supervisor schedule lifecycle policy', () => {
  it.each(['never started', 'stop all', 'runtime exit'])(
    'does not wake a default schedule target after %s',
    async (mode) => {
      const terminal = await setup();
      if (mode !== 'never started') {
        await supervisor!.command('/start alpha');
        if (mode === 'stop all') await supervisor!.command('/stop all');
        else terminal.paneFor('alpha')!.sessionActive = false;
      }
      const launchCount = [...terminal.panes.values()].reduce((sum, pane) => sum + pane.launched.length, 0);
      await ticks[0]!();
      await ticks[0]!();
      expect([...terminal.panes.values()].reduce((sum, pane) => sum + pane.launched.length, 0)).toBe(launchCount);
      expect([...terminal.panes.values()].flatMap((pane) => pane.received)).toEqual([]);
    },
  );

  it('starts an explicitly opted-in target through normal lifecycle', async () => {
    const terminal = await setup('    wakeIfStopped: true\n');
    await ticks[0]!();
    expect(terminal.paneFor('alpha')?.sessionActive).toBe(true);
    expect(terminal.paneFor('alpha')?.launched[0]).toContain('scheduled work');
  });

  it('stop all cancels a fresh-context restart already waiting in its settle delay', async () => {
    const terminal = await setup('    freshContext: true\n');
    await supervisor!.command('/start alpha');
    vi.useFakeTimers();
    const pending = ticks[0]!();
    await vi.advanceTimersByTimeAsync(0);
    expect([...terminal.panes.values()].some((pane) => pane.alive)).toBe(false);
    await supervisor!.command('/stop all');
    await vi.advanceTimersByTimeAsync(3100);
    await pending;
    expect([...terminal.panes.values()].reduce((sum, pane) => sum + pane.launched.length, 0)).toBe(1);
    expect([...terminal.panes.values()].some((pane) => pane.alive)).toBe(false);
  });
});
