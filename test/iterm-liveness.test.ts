import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Store } from '../src/store/index.js';

const mocks = vi.hoisted(() => ({
  runOsa: vi.fn<(script: string, args?: readonly string[]) => Promise<string>>(),
  ttysHaveForegroundJobs: vi.fn<(ttys: readonly string[]) => Promise<ReadonlyMap<string, boolean>>>(),
}));

vi.mock('../src/terminals/iterm/applescript.js', async (importOriginal) => ({
  ...(await importOriginal()),
  runOsa: mocks.runOsa,
}));

vi.mock('../src/terminals/process.js', async (importOriginal) => ({
  ...(await importOriginal()),
  ttysHaveForegroundJobs: mocks.ttysHaveForegroundJobs,
}));

import { ITermBackend } from '../src/terminals/iterm/index.js';

function backend(): ITermBackend {
  return new ITermBackend({
    store: {} as Store,
    config: {
      windowName: 'test',
      fleetId: 'test',
      badge: false,
      focusNewPanes: false,
      bracketedPasteThreshold: 512,
      launchTimeoutSec: 1,
      pollIntervalSec: 0.01,
    },
  });
}

const header = 'CONDUCTOR_ITERM_LIVENESS_V1';
const A = '11111111-1111-4111-8111-111111111111';
const B = '22222222-2222-4222-8222-222222222222';
const C = '33333333-3333-4333-8333-333333333333';
const REPLACEMENT = '44444444-4444-4444-8444-444444444444';

describe('iTerm batch liveness', () => {
  beforeEach(() => {
    mocks.runOsa.mockReset();
    mocks.ttysHaveForegroundJobs.mockReset();
    mocks.ttysHaveForegroundJobs.mockResolvedValue(new Map());
  });

  it('does no terminal or process work for an empty pane set', async () => {
    await expect(backend().snapshotLiveness([], { includeSessionActivity: true })).resolves.toEqual(new Map());
    expect(mocks.runOsa).not.toHaveBeenCalled();
    expect(mocks.ttysHaveForegroundJobs).not.toHaveBeenCalled();
  });

  it('uses one traversal and no tty or ps work for an existence-only snapshot', async () => {
    mocks.runOsa.mockResolvedValue(`${header}\nPRESENT\t${A}\tNOT_REQUESTED\nEND\t1\n`);
    const result = await backend().snapshotLiveness([{ backend: 'iterm', id: A }], {
      includeSessionActivity: false,
    });
    expect(result.get(A)).toMatchObject({ pane: 'alive', activity: { state: 'not-requested' } });
    expect(mocks.runOsa).toHaveBeenCalledTimes(1);
    expect(mocks.runOsa.mock.calls[0]?.[0]).not.toContain('tty as string');
    expect(mocks.ttysHaveForegroundJobs).not.toHaveBeenCalled();
  });

  it('shares missing confirmation and one bounded process lookup across the pane set', async () => {
    mocks.runOsa
      .mockResolvedValueOnce(`${header}\nPRESENT\t${A}\tOBSERVED\t/dev/ttys001\nPRESENT\t${B}\tUNKNOWN\nEND\t2\n`)
      .mockResolvedValueOnce(`${header}\nEND\t0\n`);
    mocks.ttysHaveForegroundJobs.mockResolvedValue(new Map([['ttys001', true]]));
    const result = await backend().snapshotLiveness(
      [
        { backend: 'iterm', id: A },
        { backend: 'iterm', id: B },
        { backend: 'iterm', id: C },
      ],
      { includeSessionActivity: true },
    );
    expect(result.get(A)).toMatchObject({ pane: 'alive', activity: { state: 'observed', active: true } });
    expect(result.get(B)).toMatchObject({ pane: 'alive', activity: { state: 'unknown' } });
    expect(result.get(C)).toMatchObject({ pane: 'missing' });
    expect(mocks.runOsa).toHaveBeenCalledTimes(2);
    expect(mocks.runOsa.mock.calls[1]?.[1]).toEqual([C]);
    expect(mocks.ttysHaveForegroundJobs).toHaveBeenCalledOnce();
    expect(mocks.ttysHaveForegroundJobs).toHaveBeenCalledWith(['/dev/ttys001']);
  });

  it('keeps a candidate alive but activity unknown when the shared confirmation finds it', async () => {
    mocks.runOsa
      .mockResolvedValueOnce(`${header}\nEND\t0\n`)
      .mockResolvedValueOnce(`${header}\nPRESENT\t${A}\tNOT_REQUESTED\nEND\t1\n`);
    const result = await backend().snapshotLiveness([{ backend: 'iterm', id: A }], {
      includeSessionActivity: true,
    });
    expect(result.get(A)).toMatchObject({ pane: 'alive', activity: { state: 'unknown' } });
  });

  it('limits a confirmation failure to first-scan missing candidates', async () => {
    mocks.runOsa
      .mockResolvedValueOnce(`${header}\nPRESENT\t${A}\tOBSERVED\t/dev/ttys001\nEND\t1\n`)
      .mockRejectedValueOnce(new Error('timeout'));
    mocks.ttysHaveForegroundJobs.mockResolvedValue(new Map([['ttys001', false]]));
    const result = await backend().snapshotLiveness(
      [
        { backend: 'iterm', id: A },
        { backend: 'iterm', id: B },
      ],
      { includeSessionActivity: true },
    );
    expect(result.get(A)).toMatchObject({ pane: 'alive', activity: { state: 'observed', active: false } });
    expect(result.get(B)).toMatchObject({ pane: 'unknown' });
  });

  it('preserves pane existence and makes activity unknown when the process lookup fails', async () => {
    mocks.runOsa.mockResolvedValue(`${header}\nPRESENT\t${A}\tOBSERVED\t/dev/ttys001\nEND\t1\n`);
    mocks.ttysHaveForegroundJobs.mockRejectedValue(new Error('ps timeout'));
    const result = await backend().snapshotLiveness([{ backend: 'iterm', id: A }], {
      includeSessionActivity: true,
    });
    expect(result.get(A)).toMatchObject({ pane: 'alive', activity: { state: 'unknown' } });
  });

  it('rejects malformed first-scan output instead of reporting absence', async () => {
    mocks.runOsa.mockResolvedValue('');
    await expect(
      backend().snapshotLiveness([{ backend: 'iterm', id: A }], { includeSessionActivity: false }),
    ).rejects.toThrow(/invalid liveness snapshot header/);
  });

  it('does not let confirmed-missing cleanup erase a concurrent replacement mapping', async () => {
    const instance = backend();
    const internals = instance as unknown as { panes: Map<string, string> };
    internals.panes.set('alpha', A);
    mocks.runOsa.mockResolvedValue(`${header}\nEND\t0\n`);

    const observing = instance.snapshotLiveness([{ backend: 'iterm', id: A }], {
      includeSessionActivity: false,
    });
    internals.panes.set('alpha', REPLACEMENT);

    expect((await observing).get(A)).toMatchObject({ pane: 'missing' });
    expect(internals.panes.get('alpha')).toBe(REPLACEMENT);
  });
});
