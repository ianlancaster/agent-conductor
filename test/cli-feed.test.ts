import { afterEach, describe, expect, it, vi } from 'vitest';
import { subscribeFeed } from '../src/cli/feed.js';

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('operator feed reconnection', () => {
  it('silently retries an initial outage', async () => {
    const abort = new AbortController();
    let requests = 0;
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        requests += 1;
        if (requests === 2) abort.abort();
        throw new Error('connection refused');
      }),
    );

    await subscribeFeed('http://127.0.0.1:1', () => undefined, abort.signal, 1);

    expect(requests).toBe(2);
  });

  it('preserves messages and silently reconnects when the stream closes', async () => {
    const abort = new AbortController();
    let requests = 0;
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        requests += 1;
        if (requests === 1) return new Response('data: "hello from feed"\n\n', { status: 200 });
        abort.abort();
        throw new Error('test complete');
      }),
    );
    const messages: string[] = [];

    await subscribeFeed('http://127.0.0.1:1', (message) => messages.push(message), abort.signal, 1);

    expect(requests).toBe(2);
    expect(messages).toEqual(['hello from feed']);
  });
});
