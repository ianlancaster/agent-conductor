import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Supervisor } from '../src/core/supervisor.js';
import { log } from '../src/logger.js';
import { FakeRuntime } from './fakes/fake-runtime.js';
import { FakeTerminalBackend } from './fakes/fake-terminal.js';
import { FakeEventSubscriber } from './fakes/fake-subscriber.js';

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
let subscriber: FakeEventSubscriber;

async function setup(
  scheduleOptions = '',
  {
    startAll = false,
    beforeStart,
    otherSessions = {},
  }: { startAll?: boolean; beforeStart?: () => void; otherSessions?: Record<string, string> } = {},
): Promise<FakeTerminalBackend> {
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
  for (const [name, content] of Object.entries(otherSessions)) {
    writeFileSync(join(baseDir, 'config', 'sessions', `${name}.yaml`), content);
  }
  const terminal = new FakeTerminalBackend();
  subscriber = new FakeEventSubscriber();
  supervisor = new Supervisor(baseDir, {
    terminalBackend: terminal,
    runtimes: [new FakeRuntime()],
    includeConfiguredChannels: false,
    env: {},
    eventSubscribers: [subscriber],
  });
  beforeStart?.();
  await supervisor.start({ startAll });
  return terminal;
}

let edits = 0;

/** Rewrite a session file with a distinctly newer mtime, before the watcher's next poll. */
function editSessionFile(name: string, content: string): void {
  const file = join(baseDir!, 'config', 'sessions', `${name}.yaml`);
  writeFileSync(file, content);
  edits += 1;
  const later = new Date(Date.now() + edits * 60_000);
  utimesSync(file, later, later);
}

/** Leave alpha's file unloadable, as an agent's mid-rewrite would. */
function breakSessionFile(): void {
  editSessionFile('alpha', `codename: alpha\nrepo: ${baseDir!}\nunknownKey: 1\n`);
}

/** Fire alpha's first-armed cron tick through a fresh-context settle delay. */
async function fireFreshTick(): Promise<void> {
  vi.useFakeTimers();
  const pending = ticks[0]!();
  await vi.advanceTimersByTimeAsync(3100);
  await pending;
  vi.useRealTimers();
  await eventsSettled();
}

function scheduleOutcomes(): string[] {
  return subscriber.events.flatMap((event) => (event.type === 'schedule' ? [event.outcome] : []));
}

function launchCount(terminal: FakeTerminalBackend): number {
  return [...terminal.panes.values()].reduce((sum, pane) => sum + pane.launched.length, 0);
}

async function eventsSettled(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 20));
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

  it('leaves a running session alive when a fresh-context fire meets a held session file', async () => {
    const terminal = await setup('    freshContext: true\n');
    expect(await supervisor!.command('/start alpha')).toContain('alpha started');
    const warn = vi.spyOn(log(), 'warn');
    breakSessionFile();

    await ticks[0]!();
    await eventsSettled();

    expect(terminal.paneFor('alpha')?.sessionActive).toBe(true);
    expect(launchCount(terminal)).toBe(1);
    expect(scheduleOutcomes()).toEqual(['refused']);
    expect(warn).toHaveBeenCalledWith('scheduler', expect.stringContaining("'schedule-1' refused: Not starting alpha"));
  });

  it('keeps a fresh-context fire valid across a reload caused by another session file', async () => {
    const terminal = await setup('    freshContext: true\n', {
      otherSessions: { beta: `codename: beta\nrepo: ${tmpdir()}\n` },
    });
    expect(await supervisor!.command('/start alpha')).toContain('alpha started');
    editSessionFile('beta', `codename: beta\nrepo: ${tmpdir()}\nbypassPermissions: false\n`);

    await fireFreshTick();

    expect(terminal.paneFor('alpha')?.sessionActive).toBe(true);
    expect(launchCount(terminal)).toBe(2);
    expect(scheduleOutcomes()).toEqual(['fired-fresh']);
  });

  it('fires fresh in the new repo right after its own repo: edit', async () => {
    const terminal = await setup('    freshContext: true\n');
    expect(await supervisor!.command('/start alpha')).toContain('alpha started');
    const newRepo = join(baseDir!, 'new-repo');
    mkdirSync(newRepo);
    editSessionFile(
      'alpha',
      `codename: alpha\nrepo: ${newRepo}\nschedules:\n  - cron: '0 9 * * *'\n    prompt: scheduled work\n    freshContext: true\n`,
    );

    await fireFreshTick();

    expect(terminal.paneFor('alpha')?.cwd).toBe(newRepo);
    expect(terminal.paneFor('alpha')?.launched.at(-1)).toContain('scheduled work');
    expect(scheduleOutcomes()).toEqual(['fired-fresh']);
  });

  it.each([
    ['removed', ''],
    ['changed', `schedules:\n  - cron: '0 9 * * *'\n    prompt: different work\n    freshContext: true\n`],
  ])(
    'cancels a fire whose own schedule entry was %s by the edit, without stopping the session',
    async (_kind, tail) => {
      const terminal = await setup('    freshContext: true\n');
      expect(await supervisor!.command('/start alpha')).toContain('alpha started');
      editSessionFile('alpha', `codename: alpha\nrepo: ${baseDir!}\n${tail}`);

      await fireFreshTick();

      expect(terminal.paneFor('alpha')?.sessionActive).toBe(true);
      expect(launchCount(terminal)).toBe(1);
      expect(scheduleOutcomes()).toEqual(['skipped-cancelled']);
    },
  );

  it('reports a refused wake instead of a fire when the session file is held', async () => {
    const terminal = await setup('    wakeIfStopped: true\n');
    const warn = vi.spyOn(log(), 'warn');
    breakSessionFile();

    await ticks[0]!();
    await eventsSettled();

    expect(launchCount(terminal)).toBe(0);
    expect(scheduleOutcomes()).toEqual(['refused']);
    expect(warn).toHaveBeenCalledWith('scheduler', expect.stringContaining('its session config file'));
  });

  it('warns instead of silently dropping a boot start refused by a held session file', async () => {
    let warn: ReturnType<typeof vi.spyOn> | undefined;
    const terminal = await setup('', {
      startAll: true,
      beforeStart: () => {
        breakSessionFile();
        warn = vi.spyOn(log(), 'warn');
      },
    });

    expect(launchCount(terminal)).toBe(0);
    expect(warn).toHaveBeenCalledWith('supervisor', expect.stringContaining('alpha not started: Not starting alpha'));
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
