import { describe, expect, it, vi } from 'vitest';
import {
  broadcastEnvelope,
  contentSimilarity,
  forEachConcurrent,
  messageEnvelope,
  truncate,
} from '../src/core/utils.js';

describe('contentSimilarity', () => {
  it('returns 1 for identical content', () => {
    expect(contentSimilarity('a\nb\nc', 'a\nb\nc')).toBe(1);
  });

  it('returns 0 for disjoint content', () => {
    expect(contentSimilarity('a\nb', 'x\ny')).toBe(0);
  });

  it('ignores whitespace-only differences', () => {
    expect(contentSimilarity('  a  \nb', 'a\n  b  ')).toBe(1);
  });

  it('scores partial overlap proportionally', () => {
    expect(contentSimilarity('a\nb\nc\nd', 'a\nb\nx\ny')).toBe(0.5);
  });

  it('handles empty inputs', () => {
    expect(contentSimilarity('', '')).toBe(1);
    expect(contentSimilarity('a', '')).toBe(0);
  });
});

describe('envelopes', () => {
  it('formats message and broadcast envelopes', () => {
    expect(messageEnvelope('alpha', 'hi')).toBe('[Message from alpha] hi');
    expect(broadcastEnvelope('beta', 'yo')).toBe('[Broadcast from beta] yo');
  });
});

describe('truncate', () => {
  it('leaves short text alone and truncates long text with ellipsis', () => {
    expect(truncate('short', 10)).toBe('short');
    expect(truncate('abcdefghij', 5)).toBe('abcd…');
  });
});

describe('forEachConcurrent', () => {
  it('keeps no more than the requested number of tasks active', async () => {
    let active = 0;
    let maximum = 0;
    let releaseFirstWave: (() => void) | undefined;
    const firstWave = new Promise<void>((resolve) => {
      releaseFirstWave = resolve;
    });

    const running = forEachConcurrent([1, 2, 3, 4, 5, 6], 3, async (value) => {
      active += 1;
      maximum = Math.max(maximum, active);
      if (value <= 3) await firstWave;
      active -= 1;
    });

    await vi.waitFor(() => expect(active).toBe(3));
    expect(maximum).toBe(3);
    releaseFirstWave?.();
    await running;
    expect(maximum).toBe(3);
  });

  it('rejects invalid concurrency limits', async () => {
    await expect(forEachConcurrent([], 0, async () => undefined)).rejects.toThrow(
      'Concurrency must be a positive integer.',
    );
  });
});
