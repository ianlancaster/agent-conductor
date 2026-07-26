import type { DatabaseSync } from 'node:sqlite';
import type { RuntimeName } from '../config/schema.js';
import type { Activity } from '../core/types.js';
import type { ConductorEvent } from '../events/types.js';
import type { RunbookSource } from '../runbooks/types.js';
import { applyMigrations, openSqliteDatabase, openSqliteDatabaseReadOnly, withTransaction } from './sqlite.js';

/** One launch of a session's CLI (start → stop). A session has many runs over time. */
export interface RunRow {
  id: string;
  session: string;
  status: 'active' | 'completed' | 'failed';
  started_at: string;
  last_activity_at: string;
  completed_at: string | null;
  prompt_summary: string | null;
}

export interface MessageRow {
  id: number;
  sender: string;
  recipient: string;
  type: 'message' | 'broadcast';
  content: string;
  status: 'pending' | 'delivered' | 'cancelled';
  idempotency_key: string | null;
  created_at: string;
  delivered_at: string | null;
  last_flush_attempt_at: string | null;
  flush_skip_reason: string | null;
  cancelled_at: string | null;
}

export interface MessageInsertResult {
  row: MessageRow;
  deduplicated: boolean;
}

export interface HealthLogRow {
  id: number;
  session: string;
  event: string;
  detail: string | null;
  created_at: string;
}

export interface PersistedSessionState {
  session: string;
  auto: boolean;
  tag: string | null;
  paused: boolean;
  activeRuntime: RuntimeName | null;
  activeEffort: string | null;
  activity: Activity;
}

export interface OperatorRequestRow {
  id: number;
  session: string;
  message: string;
  options: string[];
  status: 'pending' | 'responding' | 'responded';
  selectedIndex: number | null;
  createdAt: string;
  resolvedAt: string | null;
}

export interface RunbookAdoptionSessionRole {
  codename: string;
  role: string;
}

export interface RunbookAdoptionRow {
  adoptionId: string;
  runbookId: string;
  version: string;
  source: RunbookSource;
  topic: string;
  sessionRoles: RunbookAdoptionSessionRole[];
  status: 'active' | 'superseded' | 'ended';
  supersededBy: string | null;
  createdAt: string;
  closedAt: string | null;
}

export interface NewRunbookAdoption {
  adoptionId: string;
  runbookId: string;
  version: string;
  source: RunbookSource;
  topic: string;
  sessionRoles: readonly RunbookAdoptionSessionRole[];
}

/** Versioned migrations. Append only — never edit an existing entry (post first release). */
const MIGRATIONS: string[] = [
  `
  CREATE TABLE runs (
    id TEXT PRIMARY KEY,
    session TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'active',
    started_at TEXT NOT NULL DEFAULT (datetime('now')),
    last_activity_at TEXT NOT NULL DEFAULT (datetime('now')),
    completed_at TEXT,
    prompt_summary TEXT
  );
  CREATE INDEX idx_runs_session ON runs(session);

  CREATE TABLE messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    sender TEXT NOT NULL,
    recipient TEXT NOT NULL,
    type TEXT NOT NULL DEFAULT 'message',
    content TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending',
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE INDEX idx_messages_recipient ON messages(recipient, status);

  CREATE TABLE health_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    session TEXT NOT NULL,
    event TEXT NOT NULL,
    detail TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE INDEX idx_health_session ON health_log(session);

  CREATE TABLE session_state (
    session TEXT PRIMARY KEY,
    autonomy TEXT NOT NULL DEFAULT 'facilitated',
    tag TEXT,
    pause_json TEXT,
    activity TEXT NOT NULL DEFAULT 'stopped',
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE workspace (
    key TEXT PRIMARY KEY,
    value_json TEXT NOT NULL
  );
  `,
  `
  CREATE TABLE session_state_v2 (
    session TEXT PRIMARY KEY,
    auto INTEGER NOT NULL DEFAULT 0,
    tag TEXT,
    is_paused INTEGER NOT NULL DEFAULT 0,
    activity TEXT NOT NULL DEFAULT 'stopped',
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  INSERT INTO session_state_v2 (session, auto, tag, is_paused, activity, updated_at)
  SELECT
    session,
    CASE
      WHEN autonomy = 'autonomous' OR pause_json LIKE '%"previousAutonomy":"autonomous"%' THEN 1
      ELSE 0
    END,
    tag,
    CASE WHEN pause_json IS NULL THEN 0 ELSE 1 END,
    activity,
    updated_at
  FROM session_state;
  DROP TABLE session_state;
  ALTER TABLE session_state_v2 RENAME TO session_state;
  `,
  `
  ALTER TABLE session_state ADD COLUMN active_runtime TEXT;
  `,
  `
  CREATE TABLE operator_requests (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    session TEXT NOT NULL,
    message TEXT NOT NULL,
    options_json TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending',
    selected_index INTEGER,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    resolved_at TEXT
  );
  CREATE INDEX idx_operator_requests_status ON operator_requests(status, id);
  `,
  `
  ALTER TABLE messages ADD COLUMN idempotency_key TEXT;
  CREATE UNIQUE INDEX idx_messages_sender_idempotency
    ON messages(sender, idempotency_key)
    WHERE idempotency_key IS NOT NULL;
  `,
  `
  ALTER TABLE session_state ADD COLUMN active_effort TEXT;
  `,
  `
  ALTER TABLE messages ADD COLUMN delivered_at TEXT;
  ALTER TABLE messages ADD COLUMN last_flush_attempt_at TEXT;
  ALTER TABLE messages ADD COLUMN flush_skip_reason TEXT;
  ALTER TABLE messages ADD COLUMN cancelled_at TEXT;
  `,
  `
  CREATE TABLE federation_outbox (
    message_id TEXT PRIMARY KEY,
    sender_session TEXT NOT NULL,
    destination_address TEXT NOT NULL,
    destination_instance_id TEXT NOT NULL,
    content TEXT NOT NULL,
    idempotency_key TEXT,
    state TEXT NOT NULL DEFAULT 'queued',
    attempt_count INTEGER NOT NULL DEFAULT 0,
    next_attempt_at INTEGER NOT NULL,
    last_error_code TEXT,
    expires_at INTEGER NOT NULL,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    received_at INTEGER,
    delivered_at INTEGER
  );
  CREATE UNIQUE INDEX idx_federation_outbox_sender_idempotency
    ON federation_outbox(sender_session, idempotency_key)
    WHERE idempotency_key IS NOT NULL;
  CREATE INDEX idx_federation_outbox_due
    ON federation_outbox(state, next_attempt_at);

  CREATE TABLE federation_inbox (
    message_id TEXT PRIMARY KEY,
    source_instance_id TEXT NOT NULL,
    source_address TEXT NOT NULL,
    recipient_session TEXT NOT NULL,
    local_message_id INTEGER NOT NULL UNIQUE REFERENCES messages(id),
    received_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL
  );
  CREATE INDEX idx_federation_inbox_recipient
    ON federation_inbox(recipient_session, received_at);
  `,
  `
  CREATE TABLE event_journal (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    instance_id TEXT NOT NULL,
    seq INTEGER NOT NULL,
    occurred_at TEXT NOT NULL,
    type TEXT NOT NULL,
    session TEXT,
    event_json TEXT NOT NULL,
    UNIQUE(instance_id, seq)
  );
  CREATE INDEX idx_event_journal_occurred ON event_journal(occurred_at, id);
  `,
  `
  CREATE TABLE runbook_adoptions (
    adoption_id TEXT PRIMARY KEY,
    runbook_id TEXT NOT NULL,
    version TEXT NOT NULL,
    source TEXT NOT NULL,
    topic TEXT NOT NULL,
    session_roles_json TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'superseded', 'ended')),
    superseded_by TEXT REFERENCES runbook_adoptions(adoption_id),
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    closed_at TEXT
  );
  CREATE INDEX idx_runbook_adoptions_status ON runbook_adoptions(status, created_at);
  `,
];

export class Store {
  private readonly db: DatabaseSync;

  constructor(dbPath: string) {
    this.db = openSqliteDatabase(dbPath);
    try {
      applyMigrations(this.db, MIGRATIONS);
    } catch (error) {
      this.db.close();
      throw error;
    }
  }

  close(): void {
    this.db.close();
  }

  // ── runs ──────────────────────────────────────────────────────────────────

  insertRun(id: string, session: string, promptSummary?: string): void {
    this.db
      .prepare('INSERT INTO runs (id, session, prompt_summary) VALUES (?, ?, ?)')
      .run(id, session, promptSummary ?? null);
  }

  touchRun(id: string): void {
    this.db.prepare("UPDATE runs SET last_activity_at = datetime('now') WHERE id = ?").run(id);
  }

  completeRun(id: string, status: 'completed' | 'failed' = 'completed'): void {
    this.db.prepare("UPDATE runs SET status = ?, completed_at = datetime('now') WHERE id = ?").run(status, id);
  }

  getRun(id: string): RunRow | undefined {
    return this.db.prepare('SELECT * FROM runs WHERE id = ?').get(id) as RunRow | undefined;
  }

  getActiveRuns(): RunRow[] {
    return this.db
      .prepare("SELECT * FROM runs WHERE status = 'active' ORDER BY started_at")
      .all() as unknown as RunRow[];
  }

  getRecentRuns(session: string, limit = 10): RunRow[] {
    return this.db
      .prepare('SELECT * FROM runs WHERE session = ? ORDER BY started_at DESC LIMIT ?')
      .all(session, limit) as unknown as RunRow[];
  }

  // ── messages ──────────────────────────────────────────────────────────────

  insertMessage(
    sender: string,
    recipient: string,
    type: MessageRow['type'],
    content: string,
    idempotencyKey?: string,
  ): number {
    const result = this.db
      .prepare('INSERT INTO messages (sender, recipient, type, content, idempotency_key) VALUES (?, ?, ?, ?, ?)')
      .run(sender, recipient, type, content, idempotencyKey ?? null);
    return Number(result.lastInsertRowid);
  }

  insertDirectMessage(
    sender: string,
    recipient: string,
    content: string,
    idempotencyKey?: string,
  ): MessageInsertResult {
    return withTransaction(this.db, () => {
      if (idempotencyKey === undefined) {
        const id = this.insertMessage(sender, recipient, 'message', content);
        const row = this.getMessage(id);
        if (row === undefined) throw new Error(`Message #${String(id)} was not persisted.`);
        return { row, deduplicated: false };
      }

      const existing = this.getDirectMessageByIdempotencyKey(sender, idempotencyKey);
      if (existing?.status === 'cancelled' && existing.flush_skip_reason === 'conductor-restarted') {
        this.db
          .prepare(
            "UPDATE messages SET content = ?, status = 'pending', created_at = datetime('now'), " +
              'delivered_at = NULL, last_flush_attempt_at = NULL, flush_skip_reason = NULL, cancelled_at = NULL ' +
              "WHERE id = ? AND status = 'cancelled'",
          )
          .run(content, existing.id);
        const revived = this.getMessage(existing.id);
        if (revived === undefined) throw new Error(`Message #${String(existing.id)} was not revived.`);
        return { row: revived, deduplicated: false };
      }

      const inserted = this.db
        .prepare(
          `INSERT OR IGNORE INTO messages (sender, recipient, type, content, idempotency_key)
           VALUES (?, ?, 'message', ?, ?)`,
        )
        .run(sender, recipient, content, idempotencyKey);
      const row = this.getDirectMessageByIdempotencyKey(sender, idempotencyKey);
      if (row === undefined) throw new Error('Idempotent message was not persisted.');
      return { row, deduplicated: inserted.changes === 0 };
    });
  }

  getDirectMessageByIdempotencyKey(sender: string, idempotencyKey: string): MessageRow | undefined {
    return this.db
      .prepare("SELECT * FROM messages WHERE sender = ? AND idempotency_key = ? AND type = 'message'")
      .get(sender, idempotencyKey) as MessageRow | undefined;
  }

  markMessageDelivered(id: number): boolean {
    return (
      this.db
        .prepare(
          "UPDATE messages SET status = 'delivered', delivered_at = datetime('now'), " +
            "last_flush_attempt_at = datetime('now'), flush_skip_reason = NULL WHERE id = ? AND status = 'pending'",
        )
        .run(id).changes === 1
    );
  }

  recordMessageFlushAttempt(id: number, skipReason: string | null): void {
    this.db
      .prepare(
        "UPDATE messages SET last_flush_attempt_at = datetime('now'), flush_skip_reason = ? " +
          "WHERE id = ? AND status = 'pending'",
      )
      .run(skipReason, id);
  }

  markMessageCancelled(id: number): boolean {
    return (
      this.db
        .prepare(
          "UPDATE messages SET status = 'cancelled', cancelled_at = datetime('now') " +
            "WHERE id = ? AND status = 'pending'",
        )
        .run(id).changes === 1
    );
  }

  /** Cancel direct messages left pending by an earlier conductor process. */
  cancelPendingLocalMessagesOnRestart(): MessageRow[] {
    return withTransaction(this.db, () => {
      const pending = this.getPendingMessages();
      this.db
        .prepare(
          "UPDATE messages SET status = 'cancelled', cancelled_at = datetime('now'), " +
            "flush_skip_reason = 'conductor-restarted' " +
            "WHERE type = 'message' AND status = 'pending'",
        )
        .run();
      return pending;
    });
  }

  // ── operator-approved runbook adoption provenance ──────────────────────

  insertRunbookAdoption(input: NewRunbookAdoption): RunbookAdoptionRow {
    this.db
      .prepare(
        `INSERT INTO runbook_adoptions
         (adoption_id, runbook_id, version, source, topic, session_roles_json)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(
        input.adoptionId,
        input.runbookId,
        input.version,
        input.source,
        input.topic,
        JSON.stringify(input.sessionRoles),
      );
    const row = this.getRunbookAdoption(input.adoptionId);
    if (row === undefined) throw new Error('Runbook adoption was not persisted.');
    return row;
  }

  getRunbookAdoption(adoptionId: string): RunbookAdoptionRow | undefined {
    const row = this.db.prepare('SELECT * FROM runbook_adoptions WHERE adoption_id = ?').get(adoptionId) as
      | {
          adoption_id: string;
          runbook_id: string;
          version: string;
          source: string;
          topic: string;
          session_roles_json: string;
          status: string;
          superseded_by: string | null;
          created_at: string;
          closed_at: string | null;
        }
      | undefined;
    if (row === undefined) return undefined;
    const sessionRoles = JSON.parse(row.session_roles_json) as unknown;
    if (
      !Array.isArray(sessionRoles) ||
      !sessionRoles.every(
        (item) =>
          typeof item === 'object' &&
          item !== null &&
          typeof (item as { codename?: unknown }).codename === 'string' &&
          typeof (item as { role?: unknown }).role === 'string',
      )
    ) {
      throw new Error(`Runbook adoption '${adoptionId}' has invalid stored session roles.`);
    }
    if (row.source !== 'built-in' && row.source !== 'fleet' && row.source !== 'external') {
      throw new Error(`Runbook adoption '${adoptionId}' has invalid stored source.`);
    }
    if (row.status !== 'active' && row.status !== 'superseded' && row.status !== 'ended') {
      throw new Error(`Runbook adoption '${adoptionId}' has invalid stored status.`);
    }
    return {
      adoptionId: row.adoption_id,
      runbookId: row.runbook_id,
      version: row.version,
      source: row.source,
      topic: row.topic,
      sessionRoles: sessionRoles as RunbookAdoptionSessionRole[],
      status: row.status,
      supersededBy: row.superseded_by,
      createdAt: row.created_at,
      closedAt: row.closed_at,
    };
  }

  supersedeRunbookAdoption(adoptionId: string, replacement: NewRunbookAdoption): RunbookAdoptionRow {
    return withTransaction(this.db, () => {
      const previous = this.getRunbookAdoption(adoptionId);
      if (previous === undefined) throw new Error(`Unknown runbook adoption: ${adoptionId}`);
      if (previous.status !== 'active') throw new Error(`Runbook adoption '${adoptionId}' is not active.`);
      const inserted = this.insertRunbookAdoption(replacement);
      const changed = this.db
        .prepare(
          "UPDATE runbook_adoptions SET status = 'superseded', superseded_by = ?, closed_at = datetime('now') " +
            "WHERE adoption_id = ? AND status = 'active'",
        )
        .run(replacement.adoptionId, adoptionId).changes;
      if (changed !== 1) throw new Error(`Runbook adoption '${adoptionId}' could not be superseded.`);
      return inserted;
    });
  }

  endRunbookAdoption(adoptionId: string): boolean {
    return (
      this.db
        .prepare(
          "UPDATE runbook_adoptions SET status = 'ended', closed_at = datetime('now') " +
            "WHERE adoption_id = ? AND status = 'active'",
        )
        .run(adoptionId).changes === 1
    );
  }

  // ── durable conductor events ─────────────────────────────────────────────

  appendEvent(event: ConductorEvent): void {
    const session = 'session' in event && typeof event.session === 'string' ? event.session : null;
    this.db
      .prepare(
        'INSERT INTO event_journal (instance_id, seq, occurred_at, type, session, event_json) VALUES (?, ?, ?, ?, ?, ?)',
      )
      .run(event.conductorInstanceId, event.seq, event.occurredAt, event.type, session, JSON.stringify(event));
  }

  getMessage(id: number): MessageRow | undefined {
    return this.db.prepare('SELECT * FROM messages WHERE id = ?').get(id) as MessageRow | undefined;
  }

  getPendingMessages(recipient?: string): MessageRow[] {
    if (recipient !== undefined) {
      return this.db
        .prepare("SELECT * FROM messages WHERE recipient = ? AND type = 'message' AND status = 'pending' ORDER BY id")
        .all(recipient) as unknown as MessageRow[];
    }
    return this.db
      .prepare("SELECT * FROM messages WHERE type = 'message' AND status = 'pending' ORDER BY id")
      .all() as unknown as MessageRow[];
  }

  // ── operator requests ────────────────────────────────────────────────────

  insertOperatorRequest(session: string, message: string, options: readonly string[]): number {
    const result = this.db
      .prepare('INSERT INTO operator_requests (session, message, options_json) VALUES (?, ?, ?)')
      .run(session, message, JSON.stringify(options));
    return Number(result.lastInsertRowid);
  }

  getOperatorRequest(id: number): OperatorRequestRow | undefined {
    const row = this.db.prepare('SELECT * FROM operator_requests WHERE id = ?').get(id) as
      | {
          id: number;
          session: string;
          message: string;
          options_json: string;
          status: string;
          selected_index: number | null;
          created_at: string;
          resolved_at: string | null;
        }
      | undefined;
    if (row === undefined) return undefined;

    let options: unknown;
    try {
      options = JSON.parse(row.options_json);
    } catch {
      throw new Error(`Operator request #${String(id)} has invalid stored options.`);
    }
    if (!Array.isArray(options) || !options.every((option) => typeof option === 'string')) {
      throw new Error(`Operator request #${String(id)} has invalid stored options.`);
    }
    if (row.status !== 'pending' && row.status !== 'responding' && row.status !== 'responded') {
      throw new Error(`Operator request #${String(id)} has invalid stored status.`);
    }
    return {
      id: row.id,
      session: row.session,
      message: row.message,
      options,
      status: row.status,
      selectedIndex: row.selected_index,
      createdAt: row.created_at,
      resolvedAt: row.resolved_at,
    };
  }

  claimOperatorRequest(id: number): boolean {
    const result = this.db
      .prepare("UPDATE operator_requests SET status = 'responding' WHERE id = ? AND status = 'pending'")
      .run(id);
    return result.changes === 1;
  }

  finalizeOperatorRequest(id: number, selectedIndex: number): boolean {
    const result = this.db
      .prepare(
        "UPDATE operator_requests SET status = 'responded', selected_index = ?, resolved_at = datetime('now') " +
          "WHERE id = ? AND status = 'responding'",
      )
      .run(selectedIndex, id);
    return result.changes === 1;
  }

  releaseOperatorRequest(id: number): boolean {
    const result = this.db
      .prepare("UPDATE operator_requests SET status = 'pending' WHERE id = ? AND status = 'responding'")
      .run(id);
    return result.changes === 1;
  }

  resetRespondingOperatorRequests(): number {
    return Number(
      this.db.prepare("UPDATE operator_requests SET status = 'pending' WHERE status = 'responding'").run().changes,
    );
  }

  // ── health log ────────────────────────────────────────────────────────────

  logHealthEvent(session: string, event: string, detail?: string): void {
    this.db
      .prepare('INSERT INTO health_log (session, event, detail) VALUES (?, ?, ?)')
      .run(session, event, detail ?? null);
  }

  getHealthLog(session?: string, limit = 20): HealthLogRow[] {
    if (session !== undefined) {
      return this.db
        .prepare('SELECT * FROM health_log WHERE session = ? ORDER BY id DESC LIMIT ?')
        .all(session, limit) as unknown as HealthLogRow[];
    }
    return this.db.prepare('SELECT * FROM health_log ORDER BY id DESC LIMIT ?').all(limit) as unknown as HealthLogRow[];
  }

  // ── session state ─────────────────────────────────────────────────────────

  getSessionState(session: string): PersistedSessionState | undefined {
    const row = this.db.prepare('SELECT * FROM session_state WHERE session = ?').get(session) as
      | {
          session: string;
          auto: number;
          tag: string | null;
          is_paused: number;
          active_runtime: RuntimeName | null;
          active_effort: string | null;
          activity: Activity;
        }
      | undefined;
    if (!row) return undefined;
    return {
      session: row.session,
      auto: row.auto === 1,
      tag: row.tag,
      paused: row.is_paused === 1,
      activeRuntime: row.active_runtime,
      activeEffort: row.active_effort,
      activity: row.activity,
    };
  }

  getAllSessionStates(): PersistedSessionState[] {
    const rows = this.db.prepare('SELECT session FROM session_state').all() as { session: string }[];
    return rows
      .map((row) => this.getSessionState(row.session))
      .filter((state): state is PersistedSessionState => state !== undefined);
  }

  upsertSessionState(state: PersistedSessionState): void {
    this.db
      .prepare(
        `INSERT INTO session_state (session, auto, tag, is_paused, active_runtime, active_effort, activity, updated_at)
         VALUES (@session, @auto, @tag, @paused, @activeRuntime, @activeEffort, @activity, datetime('now'))
         ON CONFLICT(session) DO UPDATE SET
           auto = @auto, tag = @tag, is_paused = @paused, active_runtime = @activeRuntime,
           active_effort = @activeEffort, activity = @activity,
           updated_at = datetime('now')`,
      )
      .run({
        '@session': state.session,
        '@auto': state.auto ? 1 : 0,
        '@tag': state.tag,
        '@paused': state.paused ? 1 : 0,
        '@activeRuntime': state.activeRuntime,
        '@activeEffort': state.activeEffort,
        '@activity': state.activity,
      });
  }

  deleteSessionState(session: string): void {
    this.db.prepare('DELETE FROM session_state WHERE session = ?').run(session);
  }

  // ── workspace KV ──────────────────────────────────────────────────────────

  getWorkspaceValue<T>(key: string): T | undefined {
    const row = this.db.prepare('SELECT value_json FROM workspace WHERE key = ?').get(key) as
      { value_json: string } | undefined;
    return row ? (JSON.parse(row.value_json) as T) : undefined;
  }

  setWorkspaceValue(key: string, value: unknown): void {
    this.db
      .prepare(
        'INSERT INTO workspace (key, value_json) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json',
      )
      .run(key, JSON.stringify(value));
  }

  deleteWorkspaceValue(key: string): void {
    this.db.prepare('DELETE FROM workspace WHERE key = ?').run(key);
  }
}

/** Stream stored envelopes verbatim so future event types survive older exporters. */
export function* exportEventJournalJsonl(dbPath: string, since?: string): Generator<string> {
  const normalizedSince = since === undefined ? undefined : new Date(since).toISOString();
  const db = openSqliteDatabaseReadOnly(dbPath);
  try {
    const statement =
      normalizedSince === undefined
        ? db.prepare('SELECT event_json FROM event_journal ORDER BY id')
        : db.prepare('SELECT event_json FROM event_journal WHERE occurred_at >= ? ORDER BY id');
    const rows = normalizedSince === undefined ? statement.iterate() : statement.iterate(normalizedSince);
    for (const row of rows) {
      const eventJson = (row as { event_json?: unknown }).event_json;
      if (typeof eventJson !== 'string') throw new Error('Event journal contains a non-text envelope.');
      yield eventJson;
    }
  } finally {
    db.close();
  }
}
