import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const ENTRYPOINT = join(import.meta.dirname, '..', 'src', 'shepherd', 'cli.ts');

function run(args: string[]): string {
  return execFileSync(process.execPath, ['--import', 'tsx', ENTRYPOINT, ...args], {
    encoding: 'utf8',
    env: process.env,
  });
}

describe('PR Shepherd CLI profile discovery', () => {
  it('initializes the fleet-default profile copy-once and validates it structurally', () => {
    const dir = mkdtempSync(join(tmpdir(), 'shepherd-cli-'));
    try {
      expect(run(['-C', dir, 'init'])).toContain(join(dir, '.conductor', 'config', 'pr-shepherd.yaml'));
      const path = join(dir, '.conductor', 'config', 'pr-shepherd.yaml');
      const scaffold = readFileSync(path, 'utf8');
      expect(scaffold).toContain('agent-conductor-pr-shepherd-scaffold: identity-required');
      expect(run(['-C', dir, 'init'])).toContain('already exists');
      expect(readFileSync(path, 'utf8')).toBe(scaffold);
      expect(run(['-C', dir, 'validate'])).toContain('Valid V2 profile for @CHANGE_ME');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('lets an explicit config override fleet-default discovery', () => {
    const dir = mkdtempSync(join(tmpdir(), 'shepherd-cli-'));
    const path = join(dir, 'custom.yaml');
    writeFileSync(path, 'version: 2\nprofile:\n  githubUser: custom-user\n');
    try {
      expect(run(['-C', join(dir, 'unused-fleet'), 'validate', '--config', path])).toContain(
        'Valid V2 profile for @custom-user',
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
