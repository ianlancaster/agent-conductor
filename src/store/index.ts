import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import Database from 'better-sqlite3';
import type { Activity, Autonomy, PauseState } from '../core/types.js';

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
  type: 'message' | 'notification' | 'broadcast';
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
  autonomy: Autonomy;
  tag: string | null;
  pause: PauseState | null;
  activity: Activity;
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

  getPendingMessages(recipient: string): MessageRow[] {
    // `id` tiebreaks within a one-second created_at bucket so dependent
    // messages ("apply patch" then "run tests") keep insertion order.
    return this.db
      .prepare("SELECT * FROM messages WHERE recipient = ? AND status = 'pending' ORDER BY created_at, id")
      .all(recipient) as MessageRow[];
  }

  markMessageDelivered(id: number): void {
    this.db.prepare("UPDATE messages SET status = 'delivered' WHERE id = ?").run(id);
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
      | { session: string; autonomy: Autonomy; tag: string | null; pause_json: string | null; activity: Activity }
      | undefined;
    if (!row) return undefined;
    return {
      session: row.session,
      autonomy: row.autonomy,
      tag: row.tag,
      pause: row.pause_json !== null ? (JSON.parse(row.pause_json) as PauseState) : null,
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
        `INSERT INTO session_state (session, autonomy, tag, pause_json, activity, updated_at)
         VALUES (@session, @autonomy, @tag, @pause, @activity, datetime('now'))
         ON CONFLICT(session) DO UPDATE SET
           autonomy = @autonomy, tag = @tag, pause_json = @pause, activity = @activity,
           updated_at = datetime('now')`,
      )
      .run({
        session: state.session,
        autonomy: state.autonomy,
        tag: state.tag,
        pause: state.pause !== null ? JSON.stringify(state.pause) : null,
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
