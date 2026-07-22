import type { DatabaseSync } from 'node:sqlite';
import { applyMigrations, openSqliteDatabase, withTransaction } from '../store/sqlite.js';
import type {
  CoordinatorReceipt,
  DiscoveryKind,
  EntityUpdate,
  OutboxItem,
  ShepherdEvent,
  ShepherdEventType,
  ShepherdStore,
  StoredEntity,
} from './types.js';

interface EntityRow {
  key: string;
  kind: string;
  value_json: string;
  updated_at: string;
}

interface EventRow {
  id: string;
  type: ShepherdEventType;
  repo: string;
  pr_number: number;
  occurred_at: string;
  source_json: string;
  message: string;
}

interface OutboxRow {
  id: number;
  event_id: string;
  recipient: string;
  idempotency_key: string;
  message: string;
  attempts: number;
  next_attempt_at: string;
}

const MIGRATIONS = [
  `
  CREATE TABLE shepherd_entities (
    key TEXT PRIMARY KEY,
    kind TEXT NOT NULL,
    value_json TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  CREATE INDEX idx_shepherd_entities_kind ON shepherd_entities(kind, key);

  CREATE TABLE shepherd_events (
    id TEXT PRIMARY KEY,
    type TEXT NOT NULL,
    repo TEXT NOT NULL,
    pr_number INTEGER NOT NULL,
    occurred_at TEXT NOT NULL,
    source_json TEXT NOT NULL,
    message TEXT NOT NULL
  );
  CREATE INDEX idx_shepherd_events_time ON shepherd_events(occurred_at, id);

  CREATE TABLE shepherd_outbox (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    event_id TEXT NOT NULL UNIQUE REFERENCES shepherd_events(id),
    recipient TEXT NOT NULL,
    idempotency_key TEXT NOT NULL UNIQUE,
    message TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending',
    attempts INTEGER NOT NULL DEFAULT 0,
    next_attempt_at TEXT NOT NULL,
    claimed_at TEXT,
    completed_at TEXT,
    receipt_json TEXT,
    last_error TEXT
  );
  CREATE INDEX idx_shepherd_outbox_ready ON shepherd_outbox(status, next_attempt_at, id);

  CREATE TABLE shepherd_workspace (
    key TEXT PRIMARY KEY,
    value_json TEXT NOT NULL
  );

  CREATE TABLE shepherd_health_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    event TEXT NOT NULL,
    detail TEXT,
    created_at TEXT NOT NULL
  );
  `,
] as const;

function parseJson<T>(raw: string, label: string): T {
  try {
    return JSON.parse(raw) as T;
  } catch {
    throw new Error(`Corrupt Shepherd ${label} JSON.`);
  }
}

function eventFromRow(row: EventRow): ShepherdEvent {
  return {
    id: row.id,
    type: row.type,
    repo: row.repo,
    prNumber: row.pr_number,
    occurredAt: row.occurred_at,
    source: parseJson<Record<string, unknown>>(row.source_json, `event ${row.id}`),
    message: row.message,
  };
}

function outboxFromRow(row: OutboxRow): OutboxItem {
  return {
    id: row.id,
    eventId: row.event_id,
    recipient: row.recipient,
    idempotencyKey: row.idempotency_key,
    message: row.message,
    attempts: row.attempts,
    nextAttemptAt: row.next_attempt_at,
  };
}

export class SqliteShepherdStore implements ShepherdStore {
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

  getEntity<T>(key: string): StoredEntity<T> | undefined {
    const row = this.db.prepare('SELECT * FROM shepherd_entities WHERE key = ?').get(key) as EntityRow | undefined;
    if (row === undefined) return undefined;
    return {
      key: row.key,
      kind: row.kind,
      value: parseJson<T>(row.value_json, `entity ${key}`),
      updatedAt: row.updated_at,
    };
  }

  listEntities<T>(kind?: string): StoredEntity<T>[] {
    const rows = (kind === undefined
      ? this.db.prepare('SELECT * FROM shepherd_entities ORDER BY key').all()
      : this.db
          .prepare('SELECT * FROM shepherd_entities WHERE kind = ? ORDER BY key')
          .all(kind)) as unknown as EntityRow[];
    return rows.map((row) => ({
      key: row.key,
      kind: row.kind,
      value: parseJson<T>(row.value_json, `entity ${row.key}`),
      updatedAt: row.updated_at,
    }));
  }

  commit(
    updates: EntityUpdate[],
    events: ShepherdEvent[],
    recipient?: string,
    deleteKeys: string[] = [],
  ): ShepherdEvent[] {
    return withTransaction(this.db, () => {
      const inserted: ShepherdEvent[] = [];
      const committedAt = new Date().toISOString();
      for (const update of updates) {
        this.db
          .prepare(
            `INSERT INTO shepherd_entities (key, kind, value_json, updated_at) VALUES (?, ?, ?, ?)
             ON CONFLICT(key) DO UPDATE SET kind = excluded.kind, value_json = excluded.value_json,
               updated_at = excluded.updated_at`,
          )
          .run(update.key, update.kind, JSON.stringify(update.value), committedAt);
      }
      for (const event of events) {
        const result = this.db
          .prepare(
            `INSERT OR IGNORE INTO shepherd_events
              (id, type, repo, pr_number, occurred_at, source_json, message)
             VALUES (?, ?, ?, ?, ?, ?, ?)`,
          )
          .run(
            event.id,
            event.type,
            event.repo,
            event.prNumber,
            event.occurredAt,
            JSON.stringify(event.source),
            event.message,
          );
        if (result.changes !== 1) continue;
        inserted.push(event);
        if (recipient !== undefined) {
          this.db
            .prepare(
              `INSERT INTO shepherd_outbox
                (event_id, recipient, idempotency_key, message, next_attempt_at)
               VALUES (?, ?, ?, ?, ?)`,
            )
            .run(event.id, recipient, `shepherd:${event.id}:${recipient}`, event.message, committedAt);
        }
      }
      const remove = this.db.prepare('DELETE FROM shepherd_entities WHERE key = ?');
      for (const key of deleteKeys) remove.run(key);
      return inserted;
    });
  }

  deleteEntities(keys: string[]): void {
    const remove = this.db.prepare('DELETE FROM shepherd_entities WHERE key = ?');
    withTransaction(this.db, () => {
      for (const key of keys) remove.run(key);
    });
  }

  hasCompletedBootstrap(kind: DiscoveryKind): boolean {
    return this.db.prepare('SELECT 1 FROM shepherd_workspace WHERE key = ?').get(`bootstrap:${kind}`) !== undefined;
  }

  markBootstrapComplete(kind: DiscoveryKind): void {
    this.db
      .prepare('INSERT OR REPLACE INTO shepherd_workspace (key, value_json) VALUES (?, ?)')
      .run(`bootstrap:${kind}`, JSON.stringify({ completedAt: new Date().toISOString() }));
  }

  claimOutbox(now: Date, limit = 20): OutboxItem[] {
    return withTransaction(this.db, () => {
      const rows = this.db
        .prepare(
          `SELECT id, event_id, recipient, idempotency_key, message, attempts, next_attempt_at
           FROM shepherd_outbox
           WHERE status = 'pending' AND next_attempt_at <= ?
           ORDER BY id LIMIT ?`,
        )
        .all(now.toISOString(), limit) as unknown as OutboxRow[];
      const claim = this.db.prepare(
        "UPDATE shepherd_outbox SET status = 'sending', claimed_at = ? WHERE id = ? AND status = 'pending'",
      );
      return rows.filter((row) => claim.run(now.toISOString(), row.id).changes === 1).map(outboxFromRow);
    });
  }

  completeOutbox(id: number, receipt?: CoordinatorReceipt): void {
    this.db
      .prepare(
        "UPDATE shepherd_outbox SET status = 'completed', completed_at = ?, receipt_json = ?, last_error = NULL WHERE id = ? AND status = 'sending'",
      )
      .run(new Date().toISOString(), receipt === undefined ? null : JSON.stringify(receipt), id);
  }

  retryOutbox(id: number, nextAttemptAt: Date, error: string): void {
    this.db
      .prepare(
        "UPDATE shepherd_outbox SET status = 'pending', attempts = attempts + 1, next_attempt_at = ?, claimed_at = NULL, last_error = ? WHERE id = ? AND status = 'sending'",
      )
      .run(nextAttemptAt.toISOString(), error, id);
  }

  parkOutbox(id: number, error: string): void {
    this.db
      .prepare(
        "UPDATE shepherd_outbox SET status = 'parked', attempts = attempts + 1, claimed_at = NULL, last_error = ? WHERE id = ? AND status = 'sending'",
      )
      .run(error, id);
    this.logHealth('outbox-parked', `outbox=${String(id)} ${error}`);
  }

  recoverInFlight(): void {
    this.db.prepare("UPDATE shepherd_outbox SET status = 'pending', claimed_at = NULL WHERE status = 'sending'").run();
  }

  listEvents(limit = 100): ShepherdEvent[] {
    const rows = this.db
      .prepare('SELECT * FROM shepherd_events ORDER BY occurred_at DESC, id DESC LIMIT ?')
      .all(limit) as unknown as EventRow[];
    return rows.map(eventFromRow);
  }

  listOutbox(includeCompleted = false): OutboxItem[] {
    const rows = this.db
      .prepare(
        `SELECT id, event_id, recipient, idempotency_key, message, attempts, next_attempt_at
         FROM shepherd_outbox ${includeCompleted ? '' : "WHERE status NOT IN ('completed')"} ORDER BY id`,
      )
      .all() as unknown as OutboxRow[];
    return rows.map(outboxFromRow);
  }

  logHealth(event: string, detail?: string): void {
    this.db
      .prepare('INSERT INTO shepherd_health_log (event, detail, created_at) VALUES (?, ?, ?)')
      .run(event, detail ?? null, new Date().toISOString());
  }

  close(): void {
    this.db.close();
  }
}
