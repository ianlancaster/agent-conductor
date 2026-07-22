import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';

const SQLITE_EXPERIMENTAL_WARNING = 'SQLite is an experimental feature and might change at any time';

type DatabaseSyncConstructor = typeof DatabaseSync;

let databaseSyncConstructor: DatabaseSyncConstructor | undefined;

function getDatabaseSync(): DatabaseSyncConstructor {
  if (databaseSyncConstructor !== undefined) return databaseSyncConstructor;

  // Node 22–24 prints an ExperimentalWarning when node:sqlite is first loaded.
  // getBuiltinModule is synchronous, so intercept only that exact load-time
  // warning and restore the process function before any other code can run.
  // eslint-disable-next-line @typescript-eslint/unbound-method -- restored by identity; calls use the process receiver.
  const originalEmitWarning = process.emitWarning;
  process.emitWarning = (warning: string | Error, ...args: unknown[]) => {
    const message = typeof warning === 'string' ? warning : warning.message;
    const typeOrOptions = args[0];
    const type =
      typeof warning === 'string'
        ? typeof typeOrOptions === 'string'
          ? typeOrOptions
          : typeof typeOrOptions === 'object' && typeOrOptions !== null && 'type' in typeOrOptions
            ? (typeOrOptions as { type?: unknown }).type
            : undefined
        : warning.name;

    if (type === 'ExperimentalWarning' && message === SQLITE_EXPERIMENTAL_WARNING) return;
    Reflect.apply(originalEmitWarning, process, [warning, ...args]);
  };

  try {
    const sqlite = process.getBuiltinModule('node:sqlite');
    databaseSyncConstructor = sqlite.DatabaseSync;
    return databaseSyncConstructor;
  } finally {
    process.emitWarning = originalEmitWarning;
  }
}

const BUSY_TIMEOUT_MS = 5_000;

/** Open a SQLite database with the durability and integrity settings used by Conductor. */
export function openSqliteDatabase(dbPath: string): DatabaseSync {
  if (dbPath !== ':memory:') mkdirSync(dirname(dbPath), { recursive: true });

  const DatabaseSync = getDatabaseSync();
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
