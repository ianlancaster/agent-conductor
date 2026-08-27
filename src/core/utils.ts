/**
 * Line-set overlap similarity between two text blocks, 0..1.
 * Used to suppress duplicate stall events.
 */
export function contentSimilarity(a: string, b: string): number {
  const toLines = (s: string): Set<string> =>
    new Set(
      s
        .split('\n')
        .map((line) => line.trim())
        .filter((line) => line.length > 0),
    );
  const linesA = toLines(a);
  const linesB = toLines(b);
  if (linesA.size === 0 && linesB.size === 0) return 1;
  if (linesA.size === 0 || linesB.size === 0) return 0;
  let overlap = 0;
  for (const line of linesA) {
    if (linesB.has(line)) overlap += 1;
  }
  return overlap / Math.max(linesA.size, linesB.size);
}

export function messageEnvelope(from: string, message: string): string {
  return `[Message from ${from}] ${message}`;
}

export function integrationEnvelope(name: string, message: string): string {
  return `[Integration: ${name}] ${message}`;
}

export function broadcastEnvelope(from: string, message: string): string {
  return `[Broadcast from ${from}] ${message}`;
}

export function conductorEnvelope(message: string): string {
  return `[Message from conductor] ${message}`;
}

export function stallEnvelope(session: string, kind: string, detectedAt: string, detail: string): string {
  return `[Stall] session=${session} kind=${kind} detected-at=${detectedAt} ${detail}`;
}

export function fleetStallEnvelope(sessions: readonly string[], seconds: number, detectedAt: string): string {
  return `[Fleet Stall] sessions=${sessions.join(',')} all-nonworking-for=${seconds}s detected-at=${detectedAt} Investigate immediately.`;
}

export function truncate(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, Math.max(0, max - 1))}…` : text;
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Run independent async work with a fixed upper bound and no orphaned workers after failure. */
export async function forEachConcurrent<T>(
  items: Iterable<T>,
  concurrency: number,
  action: (item: T) => Promise<void>,
): Promise<void> {
  if (!Number.isInteger(concurrency) || concurrency < 1) {
    throw new RangeError('Concurrency must be a positive integer.');
  }
  const pending = [...items];
  let nextIndex = 0;
  let failed = false;
  let firstError: unknown;
  const worker = async (): Promise<void> => {
    while (!failed) {
      const index = nextIndex;
      nextIndex += 1;
      if (index >= pending.length) return;
      const item = pending[index] as T;
      try {
        await action(item);
      } catch (error) {
        if (!failed) firstError = error;
        failed = true;
      }
    }
  };
  const workerCount = Math.min(concurrency, pending.length);
  await Promise.all(Array.from({ length: workerCount }, () => worker()));
  if (failed) throw firstError;
}
