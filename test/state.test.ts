import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { InvalidRequestError } from '../src/core/errors.js';
import { SessionStateManager } from '../src/core/state.js';
import { Store } from '../src/store/index.js';

let store: Store;

beforeEach(() => {
  store = new Store(':memory:');
});

afterEach(() => {
  store.close();
});

describe('SessionStateManager tags', () => {
  it('rejects over-limit tags without changing the current value', () => {
    const states = new SessionStateManager(store, false, undefined, 10);
    states.register('alpha', false);
    states.setTag('alpha', 'reviewing');

    expect(() => states.setTag('alpha', 'this is too long')).toThrow(InvalidRequestError);
    expect(() => states.setTag('alpha', 'this is too long')).toThrow(
      'Tag for alpha is 16 characters; this fleet allows at most 10. Shorten the tag and try again.',
    );
    expect(states.getTag('alpha')).toBe('reviewing');
    expect(store.getSessionState('alpha')?.tag).toBe('reviewing');
  });

  it('counts Unicode code points rather than UTF-16 code units', () => {
    const states = new SessionStateManager(store, false, undefined, 3);
    states.register('alpha', false);

    expect(() => states.setTag('alpha', '🔄🔄🔄')).not.toThrow();
    expect(() => states.setTag('alpha', '🔄🔄🔄🔄')).toThrow(/at most 3/);
  });

  it('clears persisted tags that exceed a newly configured limit', () => {
    const original = new SessionStateManager(store, false, undefined, 100);
    original.register('alpha', false);
    original.setTag('alpha', 'a previously valid long tag');

    const constrained = new SessionStateManager(store, false, undefined, 5);
    constrained.register('alpha', false);

    expect(constrained.getTag('alpha')).toBeUndefined();
    expect(store.getSessionState('alpha')?.tag).toBeNull();
  });
});
