import { describe, expect, it } from 'vitest';

import { classifyUpdate } from '../src/channels/telegram/index.js';
import type { TelegramUpdate } from '../src/channels/telegram/index.js';
import { splitMessage, TELEGRAM_MAX_MESSAGE_LENGTH } from '../src/channels/telegram/split.js';

describe('splitMessage', () => {
  it('passes short messages through as a single chunk', () => {
    expect(splitMessage('hello')).toEqual(['hello']);
  });

  it('passes a message exactly at the limit through unchanged', () => {
    const text = 'a'.repeat(TELEGRAM_MAX_MESSAGE_LENGTH);
    expect(splitMessage(text)).toEqual([text]);
  });

  it('prefers splitting at a paragraph boundary', () => {
    const text = `${'a'.repeat(10)}\n\n${'b'.repeat(10)}\n\n${'c'.repeat(5)}`;
    expect(splitMessage(text, 20)).toEqual(['a'.repeat(10), `${'b'.repeat(10)}\n\n${'c'.repeat(5)}`]);
  });

  it('falls back to a line boundary when no paragraph break exists', () => {
    const text = `${'x'.repeat(15)}\n${'y'.repeat(15)}`;
    expect(splitMessage(text, 20)).toEqual(['x'.repeat(15), 'y'.repeat(15)]);
  });

  it('hard-splits a single huge line at maxLen', () => {
    const chunks = splitMessage('z'.repeat(50), 20);
    expect(chunks).toEqual(['z'.repeat(20), 'z'.repeat(20), 'z'.repeat(10)]);
  });

  it('ignores boundaries in the first half of the window (avoids tiny chunks)', () => {
    // The only newline is at index 2 (< maxLen/2), so it hard-splits instead.
    const text = `ab\n${'c'.repeat(30)}`;
    expect(splitMessage(text, 20)).toEqual([`ab\n${'c'.repeat(17)}`, 'c'.repeat(13)]);
  });

  it('respects the 4096 limit and preserves content at the default maxLen', () => {
    const line = 'w'.repeat(100);
    const text = Array.from({ length: 100 }, () => line).join('\n');
    const chunks = splitMessage(text);

    expect(chunks.length).toBeGreaterThan(1);
    for (const chunk of chunks) {
      expect(chunk.length).toBeLessThanOrEqual(TELEGRAM_MAX_MESSAGE_LENGTH);
    }
    // Only whitespace is dropped at the seams — every non-whitespace char survives.
    expect(chunks.map((c) => c.replace(/\s+/g, '')).join('')).toBe(text.replace(/\s+/g, ''));
  });
});

describe('classifyUpdate', () => {
  const message = (text?: string): TelegramUpdate => ({
    update_id: 1,
    message: { chat: { id: 123 }, text },
  });

  it('classifies a bare slash command with no args', () => {
    expect(classifyUpdate(message('/status'))).toEqual({ kind: 'command', command: 'status', args: [] });
  });

  it('classifies a slash command with whitespace-separated args', () => {
    expect(classifyUpdate(message('/status project-1   verbose'))).toEqual({
      kind: 'command',
      command: 'status',
      args: ['project-1', 'verbose'],
    });
  });

  it('treats a double-slash prefix as pass-through free text with ONE slash stripped', () => {
    expect(classifyUpdate(message('//sleep now'))).toEqual({ kind: 'freeText', text: '/sleep now' });
  });

  it('classifies plain text as free text', () => {
    expect(classifyUpdate(message('hello there'))).toEqual({ kind: 'freeText', text: 'hello there' });
  });

  it('returns undefined for updates with nothing routable', () => {
    expect(classifyUpdate(message(undefined))).toBeUndefined();
    expect(classifyUpdate({ update_id: 3 })).toBeUndefined();
  });

  it('classifies callback data only when it is a slash command', () => {
    expect(
      classifyUpdate({
        update_id: 4,
        callback_query: { id: 'cb', data: '/respond 42 2', message: { chat: { id: 123 } } },
      }),
    ).toEqual({ kind: 'command', command: 'respond', args: ['42', '2'] });
    expect(
      classifyUpdate({
        update_id: 5,
        callback_query: { id: 'cb', data: 'not a command', message: { chat: { id: 123 } } },
      }),
    ).toBeUndefined();
  });
});
