import { describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import type { PaneRef, Placement } from '../src/core/types.js';
import { observeLiveness } from '../src/terminals/liveness.js';
import type { TerminalBackend, TerminalLivenessObservation } from '../src/terminals/types.js';

function legacyBackend(): TerminalBackend {
  return {
    name: 'legacy',
    capabilities: { headless: false },
    init: async () => undefined,
    createPane: async (_session: string, _placement: Placement) => ({ backend: 'legacy', id: 'created' }),
    launch: async () => undefined,
    run: async () => undefined,
    capture: async () => '',
    isAlive: vi.fn(async (pane: PaneRef) => pane.id !== 'missing'),
    isSessionActive: vi.fn(async (pane: PaneRef) => pane.id === 'active'),
    kill: async () => undefined,
    rename: async () => undefined,
    rediscover: async () => new Map(),
  };
}

describe('terminal liveness compatibility adapter', () => {
  it('keeps core liveness calls behind the compatibility adapter inventory', () => {
    for (const path of [
      'src/core/lifecycle.ts',
      'src/core/health.ts',
      'src/core/delivery.ts',
      'src/core/operations.ts',
    ]) {
      expect(readFileSync(path, 'utf8'), path).not.toMatch(/backend\.(?:isAlive|isSessionActive)\s*\(/);
    }
  });

  it('keeps the public interface source-compatible for a backend without the optional primitive', async () => {
    const backend = legacyBackend();
    const snapshot = await observeLiveness(
      backend,
      [
        { backend: 'legacy', id: 'active' },
        { backend: 'legacy', id: 'missing' },
      ],
      { includeSessionActivity: true },
      1,
    );
    expect(snapshot.get('active')).toMatchObject({ pane: 'alive', activity: { state: 'observed', active: true } });
    expect(snapshot.get('missing')).toMatchObject({ pane: 'missing' });
    expect(backend.isAlive).toHaveBeenCalledTimes(2);
    expect(backend.isSessionActive).toHaveBeenCalledTimes(1);
  });

  it('returns an empty map without calling a backend and de-duplicates pane ids', async () => {
    const snapshotLiveness = vi.fn(
      async (): Promise<ReadonlyMap<string, TerminalLivenessObservation>> =>
        new Map([['A', { pane: 'alive', activity: { state: 'not-requested' }, observedAt: new Date().toISOString() }]]),
    );
    const backend = { ...legacyBackend(), name: 'batch', snapshotLiveness };
    await expect(observeLiveness(backend, [], { includeSessionActivity: false })).resolves.toEqual(new Map());
    expect(snapshotLiveness).not.toHaveBeenCalled();
    await observeLiveness(
      backend,
      [
        { backend: 'batch', id: 'A' },
        { backend: 'batch', id: 'A' },
      ],
      { includeSessionActivity: false },
    );
    expect(snapshotLiveness).toHaveBeenCalledWith([{ backend: 'batch', id: 'A' }], {
      includeSessionActivity: false,
    });
  });

  it('rejects mixed backends before invoking either batch or scalar work', async () => {
    const backend = legacyBackend();
    backend.snapshotLiveness = vi.fn(async () => new Map());
    await expect(
      observeLiveness(backend, [{ backend: 'other', id: 'A' }], { includeSessionActivity: false }),
    ).rejects.toThrow(/another backend/);
    expect(backend.snapshotLiveness).not.toHaveBeenCalled();
    expect(backend.isAlive).not.toHaveBeenCalled();
  });

  it('normalizes batch throws, partial maps, and malformed entries to unknown without scalar retry', async () => {
    const backend = legacyBackend();
    const pane: PaneRef = { backend: 'legacy', id: 'A' };
    backend.snapshotLiveness = vi.fn(async () => {
      throw new Error('timeout');
    });
    expect((await observeLiveness(backend, [pane], { includeSessionActivity: true })).get('A')?.pane).toBe('unknown');
    backend.snapshotLiveness = vi.fn(async () => new Map());
    expect((await observeLiveness(backend, [pane], { includeSessionActivity: true })).get('A')?.pane).toBe('unknown');
    backend.snapshotLiveness = vi.fn(
      async () => new Map([['A', { pane: 'alive', activity: { state: 'observed' }, observedAt: 'bad' }]]) as never,
    );
    expect((await observeLiveness(backend, [pane], { includeSessionActivity: true })).get('A')?.pane).toBe('unknown');
    backend.snapshotLiveness = vi.fn(
      async () =>
        new Map([['A', { pane: 'alive', activity: { state: 'not-requested' }, observedAt: new Date().toISOString() }]]),
    );
    expect((await observeLiveness(backend, [pane], { includeSessionActivity: true })).get('A')?.pane).toBe('unknown');
    expect(backend.isAlive).not.toHaveBeenCalled();
    expect(backend.isSessionActive).not.toHaveBeenCalled();
  });
});
