import { PassThrough } from 'node:stream';
import type { ReadStream, WriteStream } from 'node:tty';
import { describe, expect, it } from 'vitest';
import {
  DEFAULT_STATUS_INTERVAL,
  parseStatusInterval,
  renderStatusDashboard,
  runStatusDashboard,
} from '../src/cli/live-status.js';

const options = {
  command: '/status',
  fleetDir: '/projects/fleet',
  intervalMs: 2000,
};

describe('parseStatusInterval', () => {
  it('defaults the live view to a fifteen-second cadence', () => {
    expect(parseStatusInterval(DEFAULT_STATUS_INTERVAL)).toBe(15_000);
  });

  it('accepts seconds and milliseconds with safe bounds', () => {
    expect(parseStatusInterval('2')).toBe(2000);
    expect(parseStatusInterval('1.5s')).toBe(1500);
    expect(parseStatusInterval('500ms')).toBe(500);
    expect(parseStatusInterval('60s')).toBe(60_000);
  });

  it('rejects malformed, overly aggressive, and excessive intervals', () => {
    expect(() => parseStatusInterval('fast')).toThrow('Invalid status refresh interval');
    expect(() => parseStatusInterval('100ms')).toThrow('between 250ms and 60s');
    expect(() => parseStatusInterval('61s')).toThrow('between 250ms and 60s');
  });
});

describe('renderStatusDashboard', () => {
  it('shows the initial connection check without inventing status', () => {
    const view = renderStatusDashboard({ connection: 'checking' }, options, false);
    expect(view).toContain('Agent Conductor Status  ◌ CHECKING');
    expect(view).toContain('Contacting the conductor… · fleet: /projects/fleet');
    expect(view).toContain('(loading status…)');
  });

  it('renders canonical status output and an online indicator', () => {
    const view = renderStatusDashboard(
      {
        connection: 'online',
        status: 'Sessions:\n  alpha - CC · 🟢 working',
        updatedAt: new Date('2026-07-23T12:00:00Z'),
      },
      options,
      false,
    );
    expect(view).toContain('● ONLINE');
    expect(view).toContain('Sessions:\n  alpha - CC · 🟢 working');
    expect(view).toContain('q quit · r refresh');
  });

  it('shows enabled fleet watch immediately after the online indicator', () => {
    const view = renderStatusDashboard(
      {
        connection: 'online',
        status: 'Agent Conductor Status 🔄\n\nSessions:\n  alpha - CC · 🟡 idle - auto 🔄',
      },
      options,
      false,
    );
    expect(view).toContain('Agent Conductor Status  ● ONLINE 🔄 fleet watch on');
    expect(view).not.toContain('Agent Conductor Status 🔄');
    expect(view.match(/Agent Conductor Status/gu)).toHaveLength(1);
    expect(view).toContain('alpha - CC · 🟡 idle - auto 🔄');
  });

  it('shows the Shepherd between the Conductor heading and metadata with matching online styling', () => {
    const view = renderStatusDashboard(
      {
        connection: 'online',
        status: 'Agent Conductor Status\nPR Shepherd Status Online\n\nSessions:\n  coordinator - CC 🐑 · 🟢 working',
        updatedAt: new Date('2026-07-23T12:00:00Z'),
      },
      options,
      true,
    );
    expect(view).toContain(
      '\u001b[1mAgent Conductor Status\u001b[22m  \u001b[32m● ONLINE\u001b[39m\n' +
        '\u001b[1mPR Shepherd Status\u001b[22m  \u001b[32m● ONLINE\u001b[39m\n' +
        '\u001b[2mUpdated: ',
    );
    expect(view).toContain('\u001b[1mcoordinator\u001b[22m - CC 🐑 · 🟢 working');
  });

  it('keeps the last good snapshot visible while offline', () => {
    const view = renderStatusDashboard(
      {
        connection: 'offline',
        status: 'Sessions:\n  alpha - CC · 🟡 idle',
        updatedAt: new Date('2026-07-23T12:00:00Z'),
      },
      options,
      false,
    );
    expect(view).toContain('○ OFFLINE');
    expect(view).toContain('Retrying every 2s.');
    expect(view).toContain('Last known status:\nSessions:\n  alpha - CC · 🟡 idle');
  });

  it('applies terminal styling only when requested', () => {
    const state = { connection: 'online' as const, status: 'Sessions:\n  alpha - CC · 🟢 working' };
    expect(renderStatusDashboard(state, options, true)).toContain('\u001b[1malpha\u001b[22m');
    expect(renderStatusDashboard(state, options, false)).not.toContain('\u001b[');
  });
});

function dashboardIo(): {
  input: ReadStream;
  output: WriteStream;
  outputText(): string;
  rawMode(): boolean;
} {
  const input = new PassThrough();
  const output = new PassThrough();
  let text = '';
  let raw = false;
  Object.defineProperties(input, {
    isTTY: { value: true },
    isRaw: { get: () => raw },
    setRawMode: {
      value: (enabled: boolean) => {
        raw = enabled;
        return input;
      },
    },
  });
  Object.defineProperty(output, 'isTTY', { value: true });
  output.on('data', (chunk: Buffer) => {
    text += chunk.toString('utf8');
  });
  return {
    input: input as unknown as ReadStream,
    output: output as unknown as WriteStream,
    outputText: () => text,
    rawMode: () => raw,
  };
}

describe('runStatusDashboard', () => {
  it('recovers from an offline check, refreshes on demand, and restores the terminal', async () => {
    const io = dashboardIo();
    let calls = 0;
    const running = runStatusDashboard({
      ...options,
      input: io.input,
      output: io.output,
      fetchStatus: () => {
        calls += 1;
        return calls === 1 ? Promise.reject(new Error('offline')) : Promise.resolve('Sessions:\n  alpha - CC');
      },
    });

    await expect.poll(() => calls).toBe(1);
    await expect.poll(() => io.outputText()).toContain('○ OFFLINE');
    expect(io.rawMode()).toBe(true);

    io.input.write('r');
    await expect.poll(() => calls).toBe(2);
    await expect.poll(() => io.outputText()).toContain('● ONLINE');

    io.input.write('q');
    await running;
    expect(io.rawMode()).toBe(false);
    expect(io.input.isPaused()).toBe(true);
    expect(io.outputText()).toContain('\u001b[?1049h\u001b[?25l');
    expect(io.outputText().split('\u001b[2J\u001b[3J\u001b[H')).toHaveLength(4);
    expect(io.outputText()).toContain('\u001b[?25h\u001b[?1049l');
  });

  it('aborts an in-flight status request when the operator quits', async () => {
    const io = dashboardIo();
    let requestSignal: AbortSignal | undefined;
    const running = runStatusDashboard({
      ...options,
      input: io.input,
      output: io.output,
      fetchStatus: (signal) => {
        requestSignal = signal;
        return new Promise((_resolve, reject) => {
          signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
        });
      },
    });

    await expect.poll(() => requestSignal).toBeDefined();
    io.input.write('q');
    await running;
    expect(requestSignal?.aborted).toBe(true);
  });
});
