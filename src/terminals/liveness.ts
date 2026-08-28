import type { PaneRef } from '../core/types.js';
import { forEachConcurrent } from '../core/utils.js';
import type { TerminalBackend, TerminalLivenessObservation, TerminalLivenessSnapshotOptions } from './types.js';

function unknown(observedAt = new Date().toISOString()): TerminalLivenessObservation {
  return { pane: 'unknown', observedAt };
}

function validObservation(
  value: unknown,
  options: TerminalLivenessSnapshotOptions,
): value is TerminalLivenessObservation {
  if (typeof value !== 'object' || value === null) return false;
  const candidate = value as Partial<TerminalLivenessObservation>;
  if (typeof candidate.observedAt !== 'string' || Number.isNaN(Date.parse(candidate.observedAt))) return false;
  if (candidate.pane === 'missing' || candidate.pane === 'unknown') return true;
  if (candidate.pane !== 'alive' || typeof candidate.activity !== 'object' || candidate.activity === null) return false;
  const activity = candidate.activity as { state?: unknown; active?: unknown };
  const validActivity =
    activity.state === 'not-requested' ||
    activity.state === 'unknown' ||
    (activity.state === 'observed' && typeof activity.active === 'boolean');
  if (!validActivity) return false;
  return options.includeSessionActivity ? activity.state !== 'not-requested' : activity.state === 'not-requested';
}

/**
 * Core-side compatibility adapter for the optional batch seam. Once a backend
 * advertises snapshotLiveness, any backend error or malformed/partial result is
 * normalized to unknown without scalar retrying in the same cycle.
 */
export async function observeLiveness(
  backend: TerminalBackend,
  panes: readonly PaneRef[],
  options: TerminalLivenessSnapshotOptions,
  fallbackConcurrency = 1,
): Promise<ReadonlyMap<string, TerminalLivenessObservation>> {
  const unique = [...new Map(panes.map((pane) => [pane.id, pane])).values()];
  if (unique.length === 0) return new Map();
  if (unique.some((pane) => pane.backend !== backend.name)) {
    throw new Error(`Cannot inspect ${backend.name} liveness for panes from another backend`);
  }

  if (backend.snapshotLiveness !== undefined) {
    let snapshot: ReadonlyMap<string, TerminalLivenessObservation> | undefined;
    try {
      snapshot = await backend.snapshotLiveness(unique, options);
    } catch {
      snapshot = undefined;
    }
    const completedAt = new Date().toISOString();
    return new Map(
      unique.map((pane) => {
        const observation = snapshot?.get(pane.id);
        return [pane.id, validObservation(observation, options) ? observation : unknown(completedAt)] as const;
      }),
    );
  }

  const result = new Map<string, TerminalLivenessObservation>();
  await forEachConcurrent(unique, fallbackConcurrency, async (pane) => {
    try {
      const alive = await backend.isAlive(pane);
      const observedAt = new Date().toISOString();
      if (!alive) {
        result.set(pane.id, { pane: 'missing', observedAt });
        return;
      }
      if (!options.includeSessionActivity) {
        result.set(pane.id, { pane: 'alive', activity: { state: 'not-requested' }, observedAt });
        return;
      }
      try {
        const active = await backend.isSessionActive(pane);
        result.set(pane.id, {
          pane: 'alive',
          activity: { state: 'observed', active },
          observedAt: new Date().toISOString(),
        });
      } catch {
        result.set(pane.id, { pane: 'alive', activity: { state: 'unknown' }, observedAt: new Date().toISOString() });
      }
    } catch {
      result.set(pane.id, unknown());
    }
  });
  return result;
}
