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
  disposition: 'open' | 'accepted' | 'not_accepted' | 'closed';
  disposition_event_id: number | null;
  completion_revision: number;
  execution_id: string | null;
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
  const existingProjection = db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'work_status_current'")
    .get() as { name: string } | undefined;
  if (existingProjection !== undefined && columns.some((column) => column.name === 'duplicate_count')) return;
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

/** Add authority facts while preserving existing event IDs and attempt history. */
export function migrateWorkStatusAuthority(db: DatabaseSync): void {
  const currentColumns = db.prepare('PRAGMA table_info(work_status_current)').all() as { name: string }[];
  if (!currentColumns.some((column) => column.name === 'disposition'))
    db.exec(`
    CREATE TABLE work_status_events_next (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      fleet_id TEXT NOT NULL, session TEXT NOT NULL, work_id TEXT NOT NULL,
      attempt_id TEXT NOT NULL, mapping_version TEXT NOT NULL,
      kind TEXT NOT NULL CHECK (kind IN
        ('claim', 'unchanged_report', 'blocker_resolved', 'accepted', 'not_accepted', 'work_closed', 'attempt_rebound')),
      state TEXT CHECK (state IS NULL OR state IN ('working', 'waiting', 'blocked', 'done', 'failed')),
      payload_json TEXT NOT NULL, idempotency_key TEXT,
      blocker_id TEXT, blocker_revision INTEGER, target_event_id INTEGER,
      occurred_at_ms INTEGER NOT NULL, duplicate_count INTEGER NOT NULL DEFAULT 0,
      execution_id TEXT
    );
    INSERT INTO work_status_events_next
      (id, fleet_id, session, work_id, attempt_id, mapping_version, kind, state,
       payload_json, idempotency_key, blocker_id, blocker_revision, target_event_id,
       occurred_at_ms, duplicate_count)
    SELECT id, fleet_id, session, work_id, attempt_id, mapping_version, kind, state,
       payload_json, idempotency_key, blocker_id, blocker_revision, target_event_id,
       occurred_at_ms, duplicate_count FROM work_status_events;
    DROP TABLE work_status_events;
    ALTER TABLE work_status_events_next RENAME TO work_status_events;
    CREATE INDEX idx_work_status_scope ON work_status_events(fleet_id, session, work_id, id);
    CREATE INDEX idx_work_status_attempt ON work_status_events(fleet_id, attempt_id, id);
    CREATE UNIQUE INDEX idx_work_status_idempotency ON work_status_events(fleet_id, session, idempotency_key)
      WHERE idempotency_key IS NOT NULL;
    CREATE INDEX idx_work_status_sequence ON work_status_events(fleet_id, id);
    ALTER TABLE work_status_current ADD COLUMN disposition TEXT NOT NULL DEFAULT 'open'
      CHECK (disposition IN ('open', 'accepted', 'not_accepted', 'closed'));
    ALTER TABLE work_status_current ADD COLUMN disposition_event_id INTEGER;
    ALTER TABLE work_status_current ADD COLUMN completion_revision INTEGER NOT NULL DEFAULT 0;
    ALTER TABLE work_status_current ADD COLUMN execution_id TEXT;
  `);
  // Also repairs a beta store whose schema was already upgraded but whose
  // user_version was rolled back and whose PR 1 projection was replayed.
  const current = db.prepare('SELECT * FROM work_status_current').all() as unknown as WorkStatusCurrent[];
  for (const row of current) {
    const events = db
      .prepare(
        `SELECT * FROM work_status_events
      WHERE fleet_id = ? AND session = ? AND work_id = ? AND attempt_id = ? ORDER BY id`,
      )
      .all(row.fleet_id, row.session, row.work_id, row.attempt_id) as unknown as WorkStatusEvent[];
    let disposition: WorkStatusCurrent['disposition'] = 'open';
    let dispositionEventId: number | null = null;
    let completionRevision = 0;
    let executionId: string | null = null;
    for (const event of events) {
      if (event.kind === 'claim') {
        if (event.state === 'done') completionRevision += 1;
        executionId ??= event.execution_id;
      } else if (event.kind === 'attempt_rebound') {
        executionId = event.execution_id;
      } else if (event.kind === 'accepted' || event.kind === 'not_accepted' || event.kind === 'work_closed') {
        disposition =
          event.kind === 'accepted' ? 'accepted' : event.kind === 'not_accepted' ? 'not_accepted' : 'closed';
        dispositionEventId = event.id;
      }
    }
    db.prepare(
      `UPDATE work_status_current SET disposition = ?, disposition_event_id = ?,
      completion_revision = ?, execution_id = ? WHERE fleet_id = ? AND session = ? AND work_id = ?`,
    ).run(disposition, dispositionEventId, completionRevision, executionId, row.fleet_id, row.session, row.work_id);
  }
}
