function weekdayAt(date: Date, timezone: string): string {
  return new Intl.DateTimeFormat('en-US', { timeZone: timezone, weekday: 'short' }).format(date);
}

export function elapsedHours(since: string, until: Date, businessDaysOnly: boolean, timezone: string): number {
  const start = new Date(since);
  if (!Number.isFinite(start.getTime()) || until <= start) return 0;
  if (!businessDaysOnly) return (until.getTime() - start.getTime()) / 3_600_000;

  let totalMs = 0;
  let cursor = start.getTime();
  const end = until.getTime();
  while (cursor < end) {
    const next = Math.min(cursor + 3_600_000, end);
    const weekday = weekdayAt(new Date(cursor + (next - cursor) / 2), timezone);
    if (weekday !== 'Sat' && weekday !== 'Sun') totalMs += next - cursor;
    cursor = next;
  }
  return totalMs / 3_600_000;
}
