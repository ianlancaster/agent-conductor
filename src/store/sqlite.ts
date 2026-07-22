import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const BUSY_TIMEOUT_MS = 5_000;

/** Open a SQLite database with the durability and integrity settings used by Conductor. */
export function openSqliteDatabase(dbPath: string): DatabaseSync {
  if (dbPath !== ':memory:') mkdirSync(dirname(dbPath), { recursive: true });

  const db = new DatabaseSync(dbPath);
  try {
    db.exec(`
      PRAGMA busy_timeout = ${String(BUSY_TIMEOUT_MS)};
      PRAGMA journal_mode = WAL;
      PRAGMA foreign_keys = ON;
    `);
    return db;
  } catch (error) {
    db.close();
    throw error;
  }
}

/** Execute a synchronous unit of work atomically, preserving the original failure on rollback. */
export function withTransaction<T>(db: DatabaseSync, operation: () => T): T {
  db.exec('BEGIN');
  try {
    const result = operation();
    db.exec('COMMIT');
    return result;
  } catch (error) {
    try {
      db.exec('ROLLBACK');
    } catch {
      // Preserve the operation error. A failed rollback cannot make it more actionable.
    }
    throw error;
  }
}

/** Apply append-only migrations and advance user_version in the same transaction. */
export function applyMigrations(db: DatabaseSync, migrations: readonly string[]): void {
  const row = db.prepare('PRAGMA user_version').get() as { user_version?: unknown } | undefined;
  const current = row?.user_version;
  if (typeof current !== 'number' || !Number.isInteger(current) || current < 0) {
    throw new Error('SQLite returned an invalid user_version.');
  }
  if (current > migrations.length) {
    throw new Error(
      `Database schema version ${String(current)} is newer than supported version ${String(migrations.length)}.`,
    );
  }

  for (let version = current; version < migrations.length; version += 1) {
    const migration = migrations[version];
    if (migration === undefined) continue;
    withTransaction(db, () => {
      db.exec(migration);
      db.exec(`PRAGMA user_version = ${String(version + 1)}`);
    });
  }
}
