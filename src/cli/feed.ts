import { setTimeout as sleep } from 'node:timers/promises';
import { formatFeedPayload } from './terminal-format.js';

/** Subscribe to the conductor's operator feed and reconnect silently after outages. */
export async function subscribeFeed(
  base: string,
  onMessage: (text: string) => void,
  signal: AbortSignal,
  retryDelayMs = 2_000,
): Promise<void> {
  while (!signal.aborted) {
    try {
      const response = await fetch(`${base}/feed`, { signal });
      if (!response.ok || response.body === null) throw new Error(`feed unavailable (${String(response.status)})`);
      const reader = response.body.getReader() as ReadableStreamDefaultReader<Uint8Array>;
      const decoder = new TextDecoder();
      let buffer = '';
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        let frameEnd = buffer.indexOf('\n\n');
        while (frameEnd !== -1) {
          for (const line of buffer.slice(0, frameEnd).split('\n')) {
            if (!line.startsWith('data: ')) continue;
            try {
              const payload = JSON.parse(line.slice('data: '.length)) as unknown;
              const formatted = formatFeedPayload(payload);
              if (formatted !== undefined) onMessage(formatted);
            } catch {
              // Malformed frame — skip it rather than kill the stream.
            }
          }
          buffer = buffer.slice(frameEnd + 2);
          frameEnd = buffer.indexOf('\n\n');
        }
      }
    } catch {
      // Retry quietly. Command requests report their own actionable failures.
    }
    if (signal.aborted) return;
    try {
      await sleep(retryDelayMs, undefined, { signal });
    } catch {
      return;
    }
  }
}
