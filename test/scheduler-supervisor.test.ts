import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Supervisor } from '../src/core/supervisor.js';
import type { PaneRef } from '../src/core/types.js';
import { FakeEventSubscriber } from './fakes/fake-subscriber.js';
import { FakeRuntime } from './fakes/fake-runtime.js';
import { FakeTerminalBackend } from './fakes/fake-terminal.js';

// Drive the real Supervisor scheduler deterministically without production clock waits.
vi.mock('croner', () => ({
  Cron: class {
    private stopped = false;

    nextRun(): Date | null {
      return this.stopped ? null : new Date(Date.now() + 1000);
    }

    stop(): void {
      this.stopped = true;
    }
  },
}));

let baseDir: string | undefined;
let supervisor: Supervisor | undefined;

class GatedLaunchTerminal extends FakeTerminalBackend {
  private releaseLaunch!: () => void;
  private markEntered!: () => void;
  readonly entered = new Promise<void>((resolve) => {
    this.markEntered = resolve;
  });
  private readonly launchGate = new Promise<void>((resolve) => {
    this.releaseLaunch = resolve;
  });

  override async launch(pane: PaneRef, command: string): Promise<void> {
    this.markEntered();
    await this.launchGate;
    await super.launch(pane, command);
  }

  release(): void {
    this.releaseLaunch();
  }
}

async function setup(
  scheduleOptions = '',
  options: { terminal?: FakeTerminalBackend; subscriber?: FakeEventSubscriber } = {},
): Promise<FakeTerminalBackend> {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-09-17T15:59:59.000Z'));
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
  const terminal = options.terminal ?? new FakeTerminalBackend();
  supervisor = new Supervisor(baseDir, {
    terminalBackend: terminal,
    runtimes: [new FakeRuntime()],
    eventSubscribers: options.subscriber === undefined ? undefined : [options.subscriber],
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
      await vi.advanceTimersByTimeAsync(2100);
      expect([...terminal.panes.values()].reduce((sum, pane) => sum + pane.launched.length, 0)).toBe(launchCount);
      expect([...terminal.panes.values()].flatMap((pane) => pane.received)).toEqual([]);
    },
  );

  it('starts an explicitly opted-in target through normal lifecycle', async () => {
    const terminal = await setup('    wakeIfStopped: true\n');
    await vi.advanceTimersByTimeAsync(1100);
    await vi.waitFor(() => expect(terminal.paneFor('alpha')?.sessionActive).toBe(true));
    expect(terminal.paneFor('alpha')?.launched[0]).toContain('scheduled work');
  });

  it.each([
    { name: 'ordinary', options: '    wakeIfStopped: true\n', outcome: 'fired' },
    { name: 'fresh-context', options: '    wakeIfStopped: true\n    freshContext: true\n', outcome: 'fired-fresh' },
  ])('retains a $name occurrence when a promptless start owns the concurrent launch', async ({ options, outcome }) => {
    const terminal = new GatedLaunchTerminal();
    const subscriber = new FakeEventSubscriber();
    await setup(options, { terminal, subscriber });

    const ordinaryStart = supervisor!.command('/start alpha');
    await terminal.entered;
    await vi.advanceTimersByTimeAsync(1100);
    terminal.release();
    expect(await ordinaryStart).toBe('alpha started.');

    await vi.waitFor(() => expect(terminal.paneFor('alpha')?.received).toHaveLength(1));
    const pane = terminal.paneFor('alpha')!;
    expect(pane.launched).toHaveLength(1);
    expect(pane.launched[0]).not.toContain('scheduled work');
    expect(pane.received[0]).toBe(
      '[Cron name="schedule-1" period="0 9 * * *" scheduled_at="2026-09-17T16:00:00.000Z" timezone="America/Denver"] scheduled work',
    );
    await vi.waitFor(() =>
      expect(subscriber.events).toContainEqual(
        expect.objectContaining({
          type: 'schedule',
          session: 'alpha',
          scheduledAt: '2026-09-17T16:00:00.000Z',
          timezone: 'America/Denver',
          outcome,
        }),
      ),
    );
  });

  it('stop all cancels a fresh-context restart already waiting in its settle delay', async () => {
    const terminal = await setup('    freshContext: true\n');
    await supervisor!.command('/start alpha');
    await vi.advanceTimersByTimeAsync(1100);
    expect([...terminal.panes.values()].some((pane) => pane.alive)).toBe(false);
    await supervisor!.command('/stop all');
    await vi.advanceTimersByTimeAsync(3100);
    await vi.advanceTimersByTimeAsync(0);
    expect([...terminal.panes.values()].reduce((sum, pane) => sum + pane.launched.length, 0)).toBe(1);
    expect([...terminal.panes.values()].some((pane) => pane.alive)).toBe(false);
  });
});
