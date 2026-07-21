import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import Database from 'better-sqlite3';
import type { RuntimeName } from '../config/schema.js';
import type { Activity } from '../core/types.js';

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
  status: 'pending' | 'delivered';
  created_at: string;
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
];

export class Store {
  private readonly db: Database.Database;

  constructor(dbPath: string) {
    if (dbPath !== ':memory:') {
      mkdirSync(dirname(dbPath), { recursive: true });
    }
    this.db = new Database(dbPath);
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('foreign_keys = ON');
    this.migrate();
  }

  private migrate(): void {
    const current = this.db.pragma('user_version', { simple: true }) as number;
    for (let version = current; version < MIGRATIONS.length; version += 1) {
      const sql = MIGRATIONS[version];
      if (sql === undefined) continue;
      this.db.transaction(() => {
        this.db.exec(sql);
        this.db.pragma(`user_version = ${version + 1}`);
      })();
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
    return this.db.prepare("SELECT * FROM runs WHERE status = 'active' ORDER BY started_at").all() as RunRow[];
  }

  getRecentRuns(session: string, limit = 10): RunRow[] {
    return this.db
      .prepare('SELECT * FROM runs WHERE session = ? ORDER BY started_at DESC LIMIT ?')
      .all(session, limit) as RunRow[];
  }

  // ── messages ──────────────────────────────────────────────────────────────

  insertMessage(sender: string, recipient: string, type: MessageRow['type'], content: string): number {
    const result = this.db
      .prepare('INSERT INTO messages (sender, recipient, type, content) VALUES (?, ?, ?, ?)')
      .run(sender, recipient, type, content);
    return Number(result.lastInsertRowid);
  }

  markMessageDelivered(id: number): void {
    this.db.prepare("UPDATE messages SET status = 'delivered' WHERE id = ?").run(id);
  }

  getMessage(id: number): MessageRow | undefined {
    return this.db.prepare('SELECT * FROM messages WHERE id = ?').get(id) as MessageRow | undefined;
  }

  getPendingMessages(recipient?: string): MessageRow[] {
    if (recipient !== undefined) {
      return this.db
        .prepare("SELECT * FROM messages WHERE recipient = ? AND type = 'message' AND status = 'pending' ORDER BY id")
        .all(recipient) as MessageRow[];
    }
    return this.db
      .prepare("SELECT * FROM messages WHERE type = 'message' AND status = 'pending' ORDER BY id")
      .all() as MessageRow[];
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
    return this.db.prepare("UPDATE operator_requests SET status = 'pending' WHERE status = 'responding'").run().changes;
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
        .all(session, limit) as HealthLogRow[];
    }
    return this.db.prepare('SELECT * FROM health_log ORDER BY id DESC LIMIT ?').all(limit) as HealthLogRow[];
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
        `INSERT INTO session_state (session, auto, tag, is_paused, active_runtime, activity, updated_at)
         VALUES (@session, @auto, @tag, @paused, @activeRuntime, @activity, datetime('now'))
         ON CONFLICT(session) DO UPDATE SET
           auto = @auto, tag = @tag, is_paused = @paused, active_runtime = @activeRuntime, activity = @activity,
           updated_at = datetime('now')`,
      )
      .run({
        session: state.session,
        auto: state.auto ? 1 : 0,
        tag: state.tag,
        paused: state.paused ? 1 : 0,
        activeRuntime: state.activeRuntime,
        activity: state.activity,
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
