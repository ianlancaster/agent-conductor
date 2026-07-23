import type { DatabaseSync } from 'node:sqlite';
import type { RuntimeName } from '../config/schema.js';
import type { Activity } from '../core/types.js';
import { applyMigrations, openSqliteDatabase, withTransaction } from './sqlite.js';

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

export type FederationMessageState = 'queued' | 'received' | 'delivered' | 'expired' | 'failed';

export interface FederationOutboxRow {
  message_id: string;
  sender_session: string;
  destination_address: string;
  destination_instance_id: string;
  content: string;
  idempotency_key: string | null;
  state: FederationMessageState;
  attempt_count: number;
  next_attempt_at: number;
  last_error_code: string | null;
  expires_at: number;
  created_at: number;
  updated_at: number;
  received_at: number | null;
  delivered_at: number | null;
}

export interface FederationInboxRow {
  message_id: string;
  source_instance_id: string;
  source_address: string;
  recipient_session: string;
  local_message_id: number;
  received_at: number;
  expires_at: number;
}

export interface FederationOutboxInsertResult {
  row: FederationOutboxRow;
  deduplicated: boolean;
}

export interface FederationInboxInsertResult {
  row: FederationInboxRow;
  localMessage: MessageRow;
  deduplicated: boolean;
}

export interface FederationOutboxHealth {
  queued: number;
  received: number;
  oldestPendingAt: number | null;
}

export interface FederationCleanupResult {
  outbox: number;
  inbox: number;
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

  markMessageDelivered(id: number): void {
    this.db
      .prepare(
        "UPDATE messages SET status = 'delivered', delivered_at = datetime('now'), " +
          "last_flush_attempt_at = datetime('now'), flush_skip_reason = NULL WHERE id = ? AND status = 'pending'",
      )
      .run(id);
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

  // ── federation ───────────────────────────────────────────────────────────

  insertFederationOutbox(input: {
    messageId: string;
    senderSession: string;
    destinationAddress: string;
    destinationInstanceId: string;
    content: string;
    idempotencyKey?: string;
    now: number;
    expiresAt: number;
  }): FederationOutboxInsertResult {
    return withTransaction(this.db, () => {
      if (input.idempotencyKey !== undefined) {
        const existing = this.getFederationOutboxByIdempotencyKey(input.senderSession, input.idempotencyKey);
        if (existing !== undefined) return { row: existing, deduplicated: true };
      }
      this.db
        .prepare(
          `INSERT INTO federation_outbox (
             message_id, sender_session, destination_address, destination_instance_id, content,
             idempotency_key, next_attempt_at, expires_at, created_at, updated_at
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          input.messageId,
          input.senderSession,
          input.destinationAddress,
          input.destinationInstanceId,
          input.content,
          input.idempotencyKey ?? null,
          input.now,
          input.expiresAt,
          input.now,
          input.now,
        );
      const row = this.getFederationOutbox(input.messageId);
      if (row === undefined) throw new Error(`Federated message ${input.messageId} was not persisted.`);
      return { row, deduplicated: false };
    });
  }

  getFederationOutbox(messageId: string): FederationOutboxRow | undefined {
    return this.db.prepare('SELECT * FROM federation_outbox WHERE message_id = ?').get(messageId) as
      FederationOutboxRow | undefined;
  }

  getFederationOutboxByIdempotencyKey(senderSession: string, idempotencyKey: string): FederationOutboxRow | undefined {
    return this.db
      .prepare('SELECT * FROM federation_outbox WHERE sender_session = ? AND idempotency_key = ?')
      .get(senderSession, idempotencyKey) as FederationOutboxRow | undefined;
  }

  getDueFederationOutbox(now: number, limit: number): FederationOutboxRow[] {
    return this.db
      .prepare(
        `SELECT * FROM federation_outbox
         WHERE state IN ('queued', 'received') AND next_attempt_at <= ?
         ORDER BY next_attempt_at, created_at
         LIMIT ?`,
      )
      .all(now, limit) as unknown as FederationOutboxRow[];
  }

  getFederationOutboxHealth(): FederationOutboxHealth {
    const row = this.db
      .prepare(
        `SELECT
           SUM(CASE WHEN state = 'queued' THEN 1 ELSE 0 END) AS queued,
           SUM(CASE WHEN state = 'received' THEN 1 ELSE 0 END) AS received,
           MIN(CASE WHEN state IN ('queued', 'received') THEN created_at END) AS oldest_pending_at
         FROM federation_outbox`,
      )
      .get() as { queued: number | null; received: number | null; oldest_pending_at: number | null };
    return {
      queued: row.queued ?? 0,
      received: row.received ?? 0,
      oldestPendingAt: row.oldest_pending_at,
    };
  }

  recordFederationOutboxAttempt(messageId: string, nextAttemptAt: number, updatedAt: number, errorCode?: string): void {
    this.db
      .prepare(
        `UPDATE federation_outbox
         SET attempt_count = attempt_count + 1, next_attempt_at = ?, last_error_code = ?, updated_at = ?
         WHERE message_id = ? AND state IN ('queued', 'received')`,
      )
      .run(nextAttemptAt, errorCode ?? null, updatedAt, messageId);
  }

  scheduleFederationStatusCheck(messageId: string, nextAttemptAt: number, updatedAt: number): void {
    this.db
      .prepare(
        `UPDATE federation_outbox
         SET next_attempt_at = ?, last_error_code = NULL, updated_at = ?
         WHERE message_id = ? AND state = 'received'`,
      )
      .run(nextAttemptAt, updatedAt, messageId);
  }

  markFederationOutboxReceived(messageId: string, now: number, nextStatusAt: number): void {
    this.db
      .prepare(
        `UPDATE federation_outbox
         SET state = 'received', received_at = COALESCE(received_at, ?), next_attempt_at = ?,
             last_error_code = NULL, updated_at = ?
         WHERE message_id = ? AND state = 'queued'`,
      )
      .run(now, nextStatusAt, now, messageId);
  }

  markFederationOutboxTerminal(
    messageId: string,
    state: Extract<FederationMessageState, 'delivered' | 'expired' | 'failed'>,
    now: number,
    errorCode?: string,
  ): void {
    this.db
      .prepare(
        `UPDATE federation_outbox
         SET state = ?, delivered_at = CASE WHEN ? = 'delivered' THEN ? ELSE delivered_at END,
             last_error_code = ?, updated_at = ?
         WHERE message_id = ? AND state NOT IN ('delivered', 'expired', 'failed')`,
      )
      .run(state, state, now, errorCode ?? null, now, messageId);
  }

  acceptFederatedInbound(input: {
    messageId: string;
    sourceInstanceId: string;
    sourceAddress: string;
    recipientSession: string;
    content: string;
    receivedAt: number;
    expiresAt: number;
  }): FederationInboxInsertResult {
    return withTransaction(this.db, () => {
      const existing = this.getFederationInbox(input.messageId);
      if (existing !== undefined) {
        const localMessage = this.getMessage(existing.local_message_id);
        if (localMessage === undefined) throw new Error(`Federation inbox ${input.messageId} has no local message.`);
        return { row: existing, localMessage, deduplicated: true };
      }
      const localMessageId = this.insertMessage(
        input.sourceAddress,
        input.recipientSession,
        'message',
        input.content,
        `fed:${input.messageId}`,
      );
      const localMessage = this.getMessage(localMessageId);
      if (localMessage === undefined) throw new Error(`Federation inbox ${input.messageId} has no local message.`);
      this.db
        .prepare(
          `INSERT INTO federation_inbox
             (message_id, source_instance_id, source_address, recipient_session, local_message_id, received_at, expires_at)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          input.messageId,
          input.sourceInstanceId,
          input.sourceAddress,
          input.recipientSession,
          localMessage.id,
          input.receivedAt,
          input.expiresAt,
        );
      const row = this.getFederationInbox(input.messageId);
      if (row === undefined) throw new Error(`Federation inbox ${input.messageId} was not persisted.`);
      return { row, localMessage, deduplicated: false };
    });
  }

  getFederationInbox(messageId: string): FederationInboxRow | undefined {
    return this.db.prepare('SELECT * FROM federation_inbox WHERE message_id = ?').get(messageId) as
      FederationInboxRow | undefined;
  }

  getFederationInboxByLocalMessage(localMessageId: number): FederationInboxRow | undefined {
    return this.db.prepare('SELECT * FROM federation_inbox WHERE local_message_id = ?').get(localMessageId) as
      FederationInboxRow | undefined;
  }

  getFederationInboxMessage(messageId: string): MessageRow | undefined {
    return this.db
      .prepare(
        `SELECT messages.* FROM federation_inbox
         JOIN messages ON messages.id = federation_inbox.local_message_id
         WHERE federation_inbox.message_id = ?`,
      )
      .get(messageId) as MessageRow | undefined;
  }

  cleanupFederationHistory(cutoff: number): FederationCleanupResult {
    return withTransaction(this.db, () => {
      const outbox = this.db
        .prepare(
          `DELETE FROM federation_outbox
           WHERE state IN ('delivered', 'expired', 'failed') AND updated_at < ?`,
        )
        .run(cutoff);
      // Local messages remain under the core message-retention policy. This
      // removes only expired federation correlation/dedup metadata.
      const inbox = this.db.prepare('DELETE FROM federation_inbox WHERE expires_at < ?').run(cutoff);
      return { outbox: Number(outbox.changes), inbox: Number(inbox.changes) };
    });
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
