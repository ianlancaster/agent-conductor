import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { ensureFleetScaffold } from '../src/cli/scaffold.js';
import { STORE_SCHEMA_VERSION } from '../src/store/schema-version.js';
import { openSqliteDatabase, readDatabaseSchemaVersion } from '../src/store/sqlite.js';

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('start database preflight', () => {
  it('migrates a behind schema in the parent before ordinary startup checks', () => {
    const fleetDir = mkdtempSync(join(tmpdir(), 'conductor-start-schema-'));
    tempDirs.push(fleetDir);
    ensureFleetScaffold(fleetDir);
    writeFileSync(
      join(fleetDir, '.conductor', 'config', 'supervisor.yaml'),
      'terminal:\n  backend: tmux\nruntimes:\n  claudeCode:\n    binary: deliberately-missing-conductor-runtime\n',
    );
    const databasePath = join(fleetDir, '.conductor', 'data', 'conductor.db');
    const database = openSqliteDatabase(databasePath);
    database.exec(`PRAGMA user_version = ${String(STORE_SCHEMA_VERSION - 1)}`);
    database.close();

    const repository = resolve(import.meta.dirname, '..');
    const result = spawnSync(
      process.execPath,
      ['--import', 'tsx', join(repository, 'src', 'cli', 'index.ts'), '-C', fleetDir, 'start', '--foreground'],
      { cwd: repository, encoding: 'utf8', timeout: 10_000 },
    );

    expect(result.status).toBe(1);
    expect(result.stdout).toContain(
      `Migrated database schema ${String(STORE_SCHEMA_VERSION - 1)} → ${String(STORE_SCHEMA_VERSION)}.`,
    );
    expect(result.stderr).toContain('deliberately-missing-conductor-runtime is not on PATH');
    expect(readDatabaseSchemaVersion(databasePath)).toBe(STORE_SCHEMA_VERSION);
  });
});
