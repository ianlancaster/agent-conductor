import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { applyMigrations, openSqliteDatabase, withTransaction } from '../src/store/sqlite.js';

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function tempDatabase(): string {
  const dir = mkdtempSync(join(tmpdir(), 'conductor-sqlite-'));
  tempDirs.push(dir);
  return join(dir, 'nested', 'conductor.db');
}

describe('SQLite support', () => {
  it('creates parent directories and enables the required pragmas', () => {
    const db = openSqliteDatabase(tempDatabase());

    expect(db.prepare('PRAGMA journal_mode').get()).toMatchObject({ journal_mode: 'wal' });
    expect(db.prepare('PRAGMA foreign_keys').get()).toMatchObject({ foreign_keys: 1 });
    expect(db.prepare('PRAGMA busy_timeout').get()).toMatchObject({ timeout: 5_000 });

    db.exec(`
      CREATE TABLE parent (id INTEGER PRIMARY KEY);
      CREATE TABLE child (parent_id INTEGER REFERENCES parent(id));
    `);
    expect(() => db.prepare('INSERT INTO child (parent_id) VALUES (?)').run(99)).toThrow();
    db.close();
  });

  it('commits successful transactions and rolls back failed transactions', () => {
    const db = openSqliteDatabase(':memory:');
    db.exec('CREATE TABLE values_table (value TEXT NOT NULL)');

    expect(withTransaction(db, () => db.prepare('INSERT INTO values_table VALUES (?)').run('committed'))).toBeDefined();
    const failure = new Error('operation failed');
    expect(() =>
      withTransaction(db, () => {
        db.prepare('INSERT INTO values_table VALUES (?)').run('rolled back');
        throw failure;
      }),
    ).toThrow(failure);

    expect(db.prepare('SELECT value FROM values_table ORDER BY rowid').all()).toEqual([{ value: 'committed' }]);
    db.close();
  });

  it('applies migrations atomically and preserves the schema version on reopen', () => {
    const dbPath = tempDatabase();
    const migrations = [
      'CREATE TABLE migrated (id INTEGER PRIMARY KEY, value TEXT NOT NULL);',
      "INSERT INTO migrated (value) VALUES ('ready');",
    ];
    const db = openSqliteDatabase(dbPath);
    applyMigrations(db, migrations);
    expect(db.prepare('PRAGMA user_version').get()).toMatchObject({ user_version: 2 });
    db.close();

    const reopened = openSqliteDatabase(dbPath);
    applyMigrations(reopened, migrations);
    expect(reopened.prepare('SELECT value FROM migrated').get()).toMatchObject({ value: 'ready' });
    reopened.close();
  });

  it('does not advance user_version when a migration fails', () => {
    const db = openSqliteDatabase(':memory:');
    expect(() =>
      applyMigrations(db, ['CREATE TABLE durable (id INTEGER PRIMARY KEY);', 'THIS IS NOT VALID SQL;']),
    ).toThrow();

    expect(db.prepare('PRAGMA user_version').get()).toMatchObject({ user_version: 1 });
    expect(db.prepare("SELECT name FROM sqlite_master WHERE name = 'durable'").get()).toMatchObject({
      name: 'durable',
    });
    db.close();
  });
});
