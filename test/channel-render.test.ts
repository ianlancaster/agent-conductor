import { describe, expect, it } from 'vitest';

import { renderChannelMessage } from '../src/channels/render.js';

describe('renderChannelMessage', () => {
  it('leaves plain notifications unchanged', () => {
    expect(renderChannelMessage({ text: '[Message from alpha] hello' })).toBe('[Message from alpha] hello');
  });

  it('renders semantic actions as explicit numbered commands', () => {
    expect(
      renderChannelMessage({
        text: '[Message from alpha] Deploy where?',
        actions: [
          { label: 'Staging', command: '/respond 42 1' },
          { label: 'Production', command: '/respond 42 2' },
        ],
      }),
    ).toBe(
      '[Message from alpha] Deploy where?\n\nOptions:\n' +
        '  1. Staging — /respond 42 1\n' +
        '  2. Production — /respond 42 2',
    );
  });
});
