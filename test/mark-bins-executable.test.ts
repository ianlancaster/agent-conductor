import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

const script = path.resolve(import.meta.dirname, '../scripts/mark-bins-executable.mjs');
const roots: string[] = [];

function fixture(bin: unknown, files: string[]): string {
  const root = mkdtempSync(path.join(tmpdir(), 'conductor-bins-'));
  roots.push(root);
  writeFileSync(path.join(root, 'package.json'), JSON.stringify({ name: 'fixture', bin }));
  for (const file of files) {
    mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
    writeFileSync(path.join(root, file), '#!/usr/bin/env node\n', { mode: 0o644 });
  }
  return root;
}

function run(root: string): void {
  execFileSync(process.execPath, [script, root], { stdio: 'pipe' });
}

const executable = (file: string): number => statSync(file).mode & 0o111;

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('mark-bins-executable build step', () => {
  it('adds the execute bit to every bin target after a clean build', () => {
    const root = fixture({ conductor: 'dist/cli/index.js', shepherd: 'dist/shepherd/cli.js' }, [
      'dist/cli/index.js',
      'dist/shepherd/cli.js',
    ]);
    run(root);
    expect(executable(path.join(root, 'dist/cli/index.js'))).toBe(0o111);
    expect(executable(path.join(root, 'dist/shepherd/cli.js'))).toBe(0o111);
  });

  it('accepts a single string bin', () => {
    const root = fixture('dist/cli.js', ['dist/cli.js']);
    run(root);
    expect(executable(path.join(root, 'dist/cli.js'))).toBe(0o111);
  });

  it('fails loudly when a declared bin was not built', () => {
    const root = fixture({ conductor: 'dist/cli/index.js' }, []);
    expect(() => run(root)).toThrow(/bin target is missing after build: dist\/cli\/index.js/u);
  });
});
