import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import Database from 'better-sqlite3';
import type { Activity, Autonomy, PauseState } from '../core/types.js';

export interface SessionRow {
  id: string;
  agent: string;
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
  agent: string;
  event: string;
  detail: string | null;
  created_at: string;
}

export interface PersistedAgentState {
  agent: string;
  autonomy: Autonomy;
  tag: string | null;
  pause: PauseState | null;
  activity: Activity;
}

/** Versioned migrations. Append only — never edit an existing entry. */
const MIGRATIONS: string[] = [
  `
  CREATE TABLE sessions (
    id TEXT PRIMARY KEY,
    agent TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'active',
    started_at TEXT NOT NULL DEFAULT (datetime('now')),
    last_activity_at TEXT NOT NULL DEFAULT (datetime('now')),
    completed_at TEXT,
    prompt_summary TEXT
  );
  CREATE INDEX idx_sessions_agent ON sessions(agent);

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
    agent TEXT NOT NULL,
    event TEXT NOT NULL,
    detail TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE INDEX idx_health_agent ON health_log(agent);

  CREATE TABLE agent_state (
    agent TEXT PRIMARY KEY,
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

  // ── sessions ──────────────────────────────────────────────────────────────

  insertSession(id: string, agent: string, promptSummary?: string): void {
    this.db
      .prepare('INSERT INTO sessions (id, agent, prompt_summary) VALUES (?, ?, ?)')
      .run(id, agent, promptSummary ?? null);
  }

  touchSession(id: string): void {
    this.db.prepare("UPDATE sessions SET last_activity_at = datetime('now') WHERE id = ?").run(id);
  }

  completeSession(id: string, status: 'completed' | 'failed' = 'completed'): void {
    this.db.prepare("UPDATE sessions SET status = ?, completed_at = datetime('now') WHERE id = ?").run(status, id);
  }

  getSession(id: string): SessionRow | undefined {
    return this.db.prepare('SELECT * FROM sessions WHERE id = ?').get(id) as SessionRow | undefined;
  }

  getActiveSessions(): SessionRow[] {
    return this.db.prepare("SELECT * FROM sessions WHERE status = 'active' ORDER BY started_at").all() as SessionRow[];
  }

  getRecentSessions(agent: string, limit = 10): SessionRow[] {
    return this.db
      .prepare('SELECT * FROM sessions WHERE agent = ? ORDER BY started_at DESC LIMIT ?')
      .all(agent, limit) as SessionRow[];
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

  logHealthEvent(agent: string, event: string, detail?: string): void {
    this.db.prepare('INSERT INTO health_log (agent, event, detail) VALUES (?, ?, ?)').run(agent, event, detail ?? null);
  }

  getHealthLog(agent?: string, limit = 20): HealthLogRow[] {
    if (agent !== undefined) {
      return this.db
        .prepare('SELECT * FROM health_log WHERE agent = ? ORDER BY id DESC LIMIT ?')
        .all(agent, limit) as HealthLogRow[];
    }
    return this.db.prepare('SELECT * FROM health_log ORDER BY id DESC LIMIT ?').all(limit) as HealthLogRow[];
  }

  // ── agent state (was mode-state.json) ─────────────────────────────────────

  getAgentState(agent: string): PersistedAgentState | undefined {
    const row = this.db.prepare('SELECT * FROM agent_state WHERE agent = ?').get(agent) as
      | { agent: string; autonomy: Autonomy; tag: string | null; pause_json: string | null; activity: Activity }
      | undefined;
    if (!row) return undefined;
    return {
      agent: row.agent,
      autonomy: row.autonomy,
      tag: row.tag,
      pause: row.pause_json !== null ? (JSON.parse(row.pause_json) as PauseState) : null,
      activity: row.activity,
    };
  }

  getAllAgentStates(): PersistedAgentState[] {
    const rows = this.db.prepare('SELECT agent FROM agent_state').all() as { agent: string }[];
    return rows
      .map((row) => this.getAgentState(row.agent))
      .filter((state): state is PersistedAgentState => state !== undefined);
  }

  upsertAgentState(state: PersistedAgentState): void {
    this.db
      .prepare(
        `INSERT INTO agent_state (agent, autonomy, tag, pause_json, activity, updated_at)
         VALUES (@agent, @autonomy, @tag, @pause, @activity, datetime('now'))
         ON CONFLICT(agent) DO UPDATE SET
           autonomy = @autonomy, tag = @tag, pause_json = @pause, activity = @activity,
           updated_at = datetime('now')`,
      )
      .run({
        agent: state.agent,
        autonomy: state.autonomy,
        tag: state.tag,
        pause: state.pause !== null ? JSON.stringify(state.pause) : null,
        activity: state.activity,
      });
  }

  deleteAgentState(agent: string): void {
    this.db.prepare('DELETE FROM agent_state WHERE agent = ?').run(agent);
  }

  // ── workspace KV (was workspace.json) ─────────────────────────────────────

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
