import { mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import yaml from 'js-yaml';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { initializeRunbook, validateRunbookPath } from '../src/runbooks/authoring.js';
import { RunbookRegistry } from '../src/runbooks/registry.js';
import { loadRunbookBundle, readRunbookFile } from '../src/runbooks/schema.js';

let scratch: string;

beforeEach(() => {
  scratch = mkdtempSync(join(tmpdir(), 'conductor-runbooks-'));
});

afterEach(() => {
  rmSync(scratch, { recursive: true, force: true });
});

function writeBundle(
  root: string,
  overrides: Record<string, unknown> = {},
  content = '# Example\n\nInert instructions.\n',
): void {
  mkdirSync(root, { recursive: true });
  writeFileSync(join(root, 'README.md'), content);
  writeFileSync(
    join(root, 'runbook.yaml'),
    yaml.dump({
      schemaVersion: 1,
      id: 'example/review',
      name: 'Review',
      version: '1.0.0',
      summary: 'A minimal review workflow.',
      requires: { conductor: '>=0.1.0' },
      topics: [{ id: 'overview', title: 'Overview', summary: 'Start here.', path: 'README.md' }],
      resources: [],
      ...overrides,
    }),
  );
}

describe('runbook bundle validation', () => {
  it('accepts a strict minimal manifest and a documentation-only variant', () => {
    const root = join(scratch, 'bundle');
    writeBundle(root, {
      variantOf: { id: 'agent-conductor/engineering-management', version: '1.0.0' },
      delta: 'Caps review at one independent pass.',
    });
    const runbook = loadRunbookBundle(root, 'external', '0.1.0');
    expect(runbook).toMatchObject({ id: 'example/review', version: '1.0.0', source: 'external' });
    expect(readRunbookFile(runbook, runbook.topics[0]?.path ?? '', 'overview')).toContain('Inert instructions');
  });

  it('rejects unknown fields, ranges as versions, invalid variants, and reserved topic ids', () => {
    const root = join(scratch, 'bundle');
    writeBundle(root, { surprise: true });
    expect(() => loadRunbookBundle(root, 'external', '0.1.0')).toThrow('Unrecognized key');
    writeBundle(root, { version: '^1.0.0' });
    expect(() => loadRunbookBundle(root, 'external', '0.1.0')).toThrow('exact semantic version');
    writeBundle(root, { variantOf: { id: 'bad', version: '1.0.0' } });
    expect(() => loadRunbookBundle(root, 'external', '0.1.0')).toThrow('variantOf');
    writeBundle(root, {
      topics: [{ id: 'resource', title: 'Reserved', summary: 'Not allowed.', path: 'README.md' }],
    });
    expect(() => loadRunbookBundle(root, 'external', '0.1.0')).toThrow("'resource' is reserved");
  });

  it('rejects incompatible versions, traversal, and real symlink escapes', () => {
    const root = join(scratch, 'bundle');
    writeBundle(root, { requires: { conductor: '>=9.0.0' } });
    expect(() => loadRunbookBundle(root, 'external', '0.1.0')).toThrow('requires Conductor');

    writeBundle(root, {
      topics: [{ id: 'overview', title: 'Overview', summary: 'Start here.', path: '../outside.md' }],
    });
    writeFileSync(join(scratch, 'outside.md'), '# Outside\n');
    expect(() => loadRunbookBundle(root, 'external', '0.1.0')).toThrow('escapes the runbook');

    writeBundle(root);
    rmSync(join(root, 'README.md'));
    symlinkSync(join(scratch, 'outside.md'), join(root, 'README.md'));
    expect(() => loadRunbookBundle(root, 'external', '0.1.0')).toThrow('symlink escapes');
  });
});

describe('RunbookRegistry', () => {
  it('discovers all three sources deterministically and re-reads local changes', () => {
    const builtIn = join(scratch, 'built-in');
    const fleet = join(scratch, 'fleet-runbooks');
    const external = join(scratch, 'external');
    writeBundle(join(builtIn, 'vendor', 'one'), { id: 'built-in/one', name: 'One' });
    writeBundle(join(fleet, 'two'), { id: 'fleet/two', name: 'Two' });
    writeBundle(external, { id: 'external/three', name: 'Three' });
    const registry = new RunbookRegistry({
      conductorVersion: '0.1.0',
      fleetDir: scratch,
      fleetRunbooksDir: fleet,
      builtInDir: builtIn,
      externalPaths: [external],
    });
    expect(registry.snapshot().runbooks.map((item) => item.id)).toEqual([
      'built-in/one',
      'external/three',
      'fleet/two',
    ]);
    writeBundle(external, { id: 'external/three', name: 'Changed' });
    expect(registry.snapshot().runbooks.find((item) => item.id === 'external/three')?.name).toBe('Changed');
  });

  it('excludes every duplicate and reports missing configured paths', () => {
    const fleet = join(scratch, 'fleet-runbooks');
    const external = join(scratch, 'external');
    writeBundle(join(fleet, 'one'));
    writeBundle(external);
    const snapshot = new RunbookRegistry({
      conductorVersion: '0.1.0',
      fleetDir: scratch,
      fleetRunbooksDir: fleet,
      externalPaths: [external, join(scratch, 'missing')],
    }).snapshot();
    expect(snapshot.runbooks).toEqual([]);
    expect(snapshot.diagnostics.filter((item) => item.message.includes('Duplicate runbook id'))).toHaveLength(2);
    expect(snapshot.diagnostics).toContainEqual(
      expect.objectContaining({ message: 'Configured runbook path does not exist' }),
    );
  });
});

describe('runbook authoring', () => {
  it('initializes a valid generic bundle without overwriting', () => {
    const target = join(scratch, 'my-workflow');
    initializeRunbook(target);
    validateRunbookPath(target, '0.1.0');
    expect(readFileSync(join(target, 'runbook.yaml'), 'utf8')).toContain('id: local/my-workflow');
    expect(() => initializeRunbook(target)).toThrow('Refusing to overwrite');
  });
});
