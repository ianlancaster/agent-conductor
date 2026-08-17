import { describe, expect, it } from 'vitest';
import type { ShepherdStore } from '../src/shepherd/types.js';

// Public-consumer compile fixture: an existing injected store that implements
// only the pre-tracked ShepherdStore contract remains valid.
const legacyInjectedStore: ShepherdStore = {
  getEntity: () => undefined,
  listEntities: () => [],
  commit: () => [],
  deleteEntities: () => undefined,
  hasCompletedBootstrap: () => false,
  markBootstrapComplete: () => undefined,
  claimOutbox: () => [],
  completeOutbox: () => undefined,
  retryOutbox: () => undefined,
  parkOutbox: () => undefined,
  recoverInFlight: () => undefined,
  listEvents: () => [],
  listOutbox: () => [],
  logHealth: () => undefined,
  close: () => undefined,
};

describe('public Shepherd store compatibility', () => {
  it('does not require tracked-control methods from existing injected stores', () => {
    expect('getTrackedPullRequest' in legacyInjectedStore).toBe(false);
  });
});
