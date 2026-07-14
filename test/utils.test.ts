import { describe, expect, it } from 'vitest';
import { broadcastEnvelope, contentSimilarity, messageEnvelope, truncate } from '../src/core/utils.js';

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
