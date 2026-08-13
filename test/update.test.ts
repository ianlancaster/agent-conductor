import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { updateSourceInstallation, type UpdateDependencies } from '../src/cli/update.js';

const root = resolve(import.meta.dirname, '..');

function dependencies(overrides: Record<string, { status: number; stdout?: string; stderr?: string }> = {}): {
  deps: UpdateDependencies;
  calls: string[];
} {
  const calls: string[] = [];
  const responses: Record<string, { status: number; stdout?: string; stderr?: string }> = {
    'git rev-parse --show-toplevel': { status: 0, stdout: root },
    'git branch --show-current': { status: 0, stdout: 'feat/local' },
    'git status --porcelain=v1 --untracked-files=normal': { status: 0, stdout: '' },
    'git fetch --prune origin': { status: 0 },
    'git symbolic-ref --short refs/remotes/origin/HEAD': { status: 0, stdout: 'origin/main' },
    'git rev-parse --verify origin/main': { status: 0, stdout: 'abc123' },
    'git rev-parse --abbrev-ref --symbolic-full-name @{upstream}': { status: 1 },
    'git merge-base --is-ancestor origin/main HEAD': { status: 0 },
    'git show HEAD:src/store/schema-version.ts': {
      status: 0,
      stdout: 'export const STORE_SCHEMA_VERSION = 13;',
    },
    'git rev-parse --short HEAD': { status: 0, stdout: 'def456' },
    'pnpm install --frozen-lockfile': { status: 0 },
    'pnpm build': { status: 0 },
    'pnpm verify:package': { status: 0 },
    'pnpm link --global': { status: 0 },
    ...overrides,
  };
  return {
    calls,
    deps: {
      exists: () => true,
      run: async (command, args) => {
        const normalizedArgs = command === 'git' ? args.slice(2) : args;
        const key = `${command} ${normalizedArgs.join(' ')}`;
        calls.push(key);
        const response = responses[key];
        if (response === undefined) throw new Error(`Unexpected command: ${key}`);
        return { status: response.status, stdout: response.stdout ?? '', stderr: response.stderr ?? '' };
      },
    },
  };
}

describe('source updater', () => {
  it('rebuilds a clean feature branch that already contains the remote default branch', async () => {
    const { deps, calls } = dependencies();
    const result = await updateSourceInstallation({ packageRoot: root, requiredSchemaVersion: 13 }, deps);

    expect(result).toMatchObject({
      branch: 'feat/local',
      commit: 'def456',
      schemaVersion: 13,
      fastForwarded: false,
      migratedFleet: false,
    });
    expect(calls).toContain('pnpm link --global');
    expect(calls.some((call) => call.startsWith('git merge --ff-only'))).toBe(false);
  });

  it('fast-forwards an unambiguously behind branch before rebuilding', async () => {
    const { deps, calls } = dependencies({
      'git merge-base --is-ancestor origin/main HEAD': { status: 1 },
      'git rev-parse --abbrev-ref --symbolic-full-name @{upstream}': { status: 0, stdout: 'origin/main' },
      'git merge-base --is-ancestor HEAD origin/main': { status: 0 },
      'git show origin/main:src/store/schema-version.ts': {
        status: 0,
        stdout: 'export const STORE_SCHEMA_VERSION = 14;',
      },
      'git merge --ff-only origin/main': { status: 0 },
    });

    const result = await updateSourceInstallation({ packageRoot: root }, deps);
    expect(result.fastForwarded).toBe(true);
    expect(result.schemaVersion).toBe(14);
    expect(calls).toContain('git merge --ff-only origin/main');
  });

  it('refuses dirty source before fetching or building', async () => {
    const { deps, calls } = dependencies({
      'git status --porcelain=v1 --untracked-files=normal': { status: 0, stdout: ' M src/cli/index.ts' },
    });
    await expect(updateSourceInstallation({ packageRoot: root }, deps)).rejects.toThrow('uncommitted changes');
    expect(calls.some((call) => call.startsWith('git fetch'))).toBe(false);
    expect(calls.some((call) => call.startsWith('pnpm'))).toBe(false);
  });

  it('refuses to update while the selected fleet is running', async () => {
    const { deps, calls } = dependencies();
    await expect(updateSourceInstallation({ packageRoot: root, fleetRunning: async () => true }, deps)).rejects.toThrow(
      'running Conductor',
    );
    expect(calls.some((call) => call.startsWith('git fetch'))).toBe(false);
  });

  it('refuses a candidate that cannot read the selected fleet schema', async () => {
    const { deps, calls } = dependencies();
    await expect(
      updateSourceInstallation({ packageRoot: root, requiredSchemaVersion: 14, automatic: true }, deps),
    ).rejects.toThrow('supports database schema 13, but this fleet requires 14');
    expect(calls.some((call) => call.startsWith('pnpm'))).toBe(false);
  });

  it('refuses source history that diverged from the remote default', async () => {
    const { deps } = dependencies({
      'git merge-base --is-ancestor origin/main HEAD': { status: 1 },
      'git rev-parse --abbrev-ref --symbolic-full-name @{upstream}': { status: 0, stdout: 'origin/feat/local' },
      'git merge-base --is-ancestor HEAD origin/feat/local': { status: 1 },
      'git merge-base --is-ancestor HEAD origin/main': { status: 1 },
    });
    await expect(updateSourceInstallation({ packageRoot: root }, deps)).rejects.toThrow(
      'has diverged from origin/main',
    );
  });
});
