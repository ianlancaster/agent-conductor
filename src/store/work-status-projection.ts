import type { DatabaseSync } from 'node:sqlite';
import type { WorkClaimState, WorkStatusEvent } from './work-status.js';

export interface WorkStatusCurrent {
  fleet_id: string;
  session: string;
  work_id: string;
  attempt_id: string;
  claim_event_id: number;
  state: WorkClaimState;
  payload_json: string;
  state_entered_at_ms: number;
  work_started_at_ms: number;
  blocker_started_at_ms: number | null;
  blocker_id: string | null;
  blocker_revision: number | null;
  resolved_at_ms: number | null;
  cumulative_json: string;
  acknowledgement_wait_ms: number;
}

export const EMPTY_DURATIONS: Record<WorkClaimState, number> = {
  working: 0,
  waiting: 0,
  blocked: 0,
  done: 0,
  failed: 0,
};

export function currentWork(
  db: DatabaseSync,
  fleetId: string,
  session: string,
  workId: string,
): WorkStatusCurrent | undefined {
  return db
    .prepare('SELECT * FROM work_status_current WHERE fleet_id = ? AND session = ? AND work_id = ?')
    .get(fleetId, session, workId) as WorkStatusCurrent | undefined;
}

export function projectClaim(db: DatabaseSync, event: WorkStatusEvent): void {
  if (event.state === null) throw new Error('Cannot project an event without a state.');
  const previous = currentWork(db, event.fleet_id, event.session, event.work_id);
  const newAttempt = previous?.attempt_id !== event.attempt_id;
  const cumulative: Record<WorkClaimState, number> =
    newAttempt || previous === undefined
      ? { ...EMPTY_DURATIONS }
      : (JSON.parse(previous.cumulative_json) as Record<WorkClaimState, number>);
  let acknowledgementWait = newAttempt ? 0 : (previous?.acknowledgement_wait_ms ?? 0);
  if (
    previous !== undefined &&
    !newAttempt &&
    previous.state === 'blocked' &&
    previous.resolved_at_ms !== null &&
    (event.state !== 'blocked' || previous.blocker_revision !== event.blocker_revision)
  ) {
    acknowledgementWait += Math.max(0, event.occurred_at_ms - previous.resolved_at_ms);
  } else if (previous !== undefined && !newAttempt && previous.state !== event.state && previous.state !== 'blocked') {
    cumulative[previous.state] += Math.max(0, event.occurred_at_ms - previous.state_entered_at_ms);
  }
  const stateEntered =
    previous === undefined || newAttempt || previous.state !== event.state
      ? event.occurred_at_ms
      : previous.state_entered_at_ms;
  const sameBlocker =
    previous?.blocker_id === event.blocker_id && previous?.blocker_revision === event.blocker_revision;
  const blockerStarted =
    event.state !== 'blocked'
      ? null
      : sameBlocker
        ? (previous?.blocker_started_at_ms ?? event.occurred_at_ms)
        : event.occurred_at_ms;
  const resolvedAt = event.state === 'blocked' && sameBlocker ? (previous?.resolved_at_ms ?? null) : null;
  db.prepare(
    `INSERT INTO work_status_current
    (fleet_id, session, work_id, attempt_id, claim_event_id, state, payload_json,
     state_entered_at_ms, work_started_at_ms, blocker_started_at_ms, blocker_id,
     blocker_revision, resolved_at_ms, cumulative_json, acknowledgement_wait_ms)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(fleet_id, session, work_id) DO UPDATE SET
      attempt_id=excluded.attempt_id, claim_event_id=excluded.claim_event_id,
      state=excluded.state, payload_json=excluded.payload_json,
      state_entered_at_ms=excluded.state_entered_at_ms,
      blocker_started_at_ms=excluded.blocker_started_at_ms,
      blocker_id=excluded.blocker_id, blocker_revision=excluded.blocker_revision,
      resolved_at_ms=excluded.resolved_at_ms, cumulative_json=excluded.cumulative_json,
      acknowledgement_wait_ms=excluded.acknowledgement_wait_ms`,
  ).run(
    event.fleet_id,
    event.session,
    event.work_id,
    event.attempt_id,
    event.id,
    event.state,
    event.payload_json,
    stateEntered,
    previous?.work_started_at_ms ?? event.occurred_at_ms,
    blockerStarted,
    event.blocker_id,
    event.blocker_revision,
    resolvedAt,
    JSON.stringify(cumulative),
    acknowledgementWait,
  );
}

export function projectResolution(db: DatabaseSync, event: WorkStatusEvent): void {
  const current = currentWork(db, event.fleet_id, event.session, event.work_id);
  if (
    current?.state !== 'blocked' ||
    current.resolved_at_ms !== null ||
    current.attempt_id !== event.attempt_id ||
    current.blocker_id !== event.blocker_id ||
    current.blocker_revision !== event.blocker_revision
  )
    return;
  const cumulative = JSON.parse(current.cumulative_json) as Record<WorkClaimState, number>;
  cumulative.blocked += Math.max(
    0,
    event.occurred_at_ms - (current.blocker_started_at_ms ?? current.state_entered_at_ms),
  );
  db.prepare(
    `UPDATE work_status_current SET resolved_at_ms = ?, cumulative_json = ?
    WHERE fleet_id = ? AND session = ? AND work_id = ? AND attempt_id = ?
      AND blocker_id = ? AND blocker_revision = ? AND state = 'blocked'`,
  ).run(
    event.occurred_at_ms,
    JSON.stringify(cumulative),
    event.fleet_id,
    event.session,
    event.work_id,
    event.attempt_id,
    event.blocker_id,
    event.blocker_revision,
  );
}

/** Upgrade existing PR 1 journals without discarding transition history. */
export function migrateWorkStatusProjection(db: DatabaseSync): void {
  const columns = db.prepare('PRAGMA table_info(work_status_events)').all() as { name: string }[];
  if (!columns.some((column) => column.name === 'duplicate_count')) {
    db.exec('ALTER TABLE work_status_events ADD COLUMN duplicate_count INTEGER NOT NULL DEFAULT 0');
  }
  db.exec(`
    CREATE TABLE IF NOT EXISTS work_status_idempotency (
      fleet_id TEXT NOT NULL, session TEXT NOT NULL, idempotency_key TEXT NOT NULL,
      payload_json TEXT NOT NULL, claim_event_id INTEGER NOT NULL,
      PRIMARY KEY(fleet_id, session, idempotency_key)
    );
    CREATE TABLE IF NOT EXISTS work_status_current (
      fleet_id TEXT NOT NULL, session TEXT NOT NULL, work_id TEXT NOT NULL,
      attempt_id TEXT NOT NULL, claim_event_id INTEGER NOT NULL,
      state TEXT NOT NULL, payload_json TEXT NOT NULL,
      state_entered_at_ms INTEGER NOT NULL, work_started_at_ms INTEGER NOT NULL,
      blocker_started_at_ms INTEGER, blocker_id TEXT, blocker_revision INTEGER,
      resolved_at_ms INTEGER, cumulative_json TEXT NOT NULL,
      acknowledgement_wait_ms INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY(fleet_id, session, work_id)
    );
    CREATE INDEX IF NOT EXISTS idx_work_status_current_session_state
      ON work_status_current(fleet_id, session, state);
    CREATE INDEX IF NOT EXISTS idx_work_status_current_work
      ON work_status_current(fleet_id, work_id, state);
    CREATE INDEX IF NOT EXISTS idx_work_status_current_attempt
      ON work_status_current(fleet_id, attempt_id);
  `);
  db.exec('DELETE FROM work_status_current');
  db.exec('DELETE FROM work_status_idempotency');
  db.exec('UPDATE work_status_events SET duplicate_count = 0');
  const events = db.prepare('SELECT * FROM work_status_events ORDER BY id').all() as unknown as WorkStatusEvent[];
  for (const event of events) {
    if (event.kind === 'claim') projectClaim(db, event);
    else if (event.kind === 'blocker_resolved') projectResolution(db, event);
    else if (event.kind === 'unchanged_report' && event.target_event_id !== null) {
      db.prepare('UPDATE work_status_events SET duplicate_count = duplicate_count + 1 WHERE id = ?').run(
        event.target_event_id,
      );
    }
    if (event.kind === 'claim' && event.idempotency_key !== null) {
      db.prepare(
        `INSERT INTO work_status_idempotency
        (fleet_id, session, idempotency_key, payload_json, claim_event_id) VALUES (?, ?, ?, ?, ?)`,
      ).run(event.fleet_id, event.session, event.idempotency_key, event.payload_json, event.id);
    }
  }
}
