import { join } from 'node:path';

export const EVENT_JOURNAL_DEGRADED_FILENAME = 'event-journal.degraded';

export function eventJournalDegradedPath(dataDir: string): string {
  return join(dataDir, EVENT_JOURNAL_DEGRADED_FILENAME);
}
