import { chmod, mkdir, readFile, stat, symlink, writeFile } from 'node:fs/promises';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  MAX_HOOK_CONTEXT_CHARACTERS,
  MAX_HOOK_CONTEXT_UTF8_BYTES,
  MAX_SESSION_INSTRUCTION_BYTES,
  assertHookContextFits,
  prepareInstructionLayers,
} from '../src/runtimes/instructions.js';

let root: string;
let configDir: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'conductor-instructions-'));
  configDir = join(root, 'config');
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe('prepareInstructionLayers', () => {
  it('preserves authored bytes, adds only a missing final newline, and writes private snapshots', async () => {
    const source = join(root, 'role.md');
    await writeFile(source, '  exact prose  ');
    const prepared = await prepareInstructionLayers({
      configDir,
      protocolText: 'protocol\n',
      sessionSourcePath: source,
    });

    expect(prepared.protocol?.content).toBe('protocol\n');
    expect(prepared.session?.content).toBe('  exact prose  \n');
    expect(await readFile(join(configDir, 'session-instructions.md'), 'utf8')).toBe('  exact prose  \n');
    expect((await stat(join(configDir, 'conductor-protocol.md'))).mode & 0o777).toBe(0o600);
    expect((await stat(join(configDir, 'session-instructions.md'))).mode & 0o777).toBe(0o600);
  });

  it('accepts a symlink that resolves to a regular file', async () => {
    const source = join(root, 'source.md');
    const link = join(root, 'linked.md');
    await writeFile(source, 'linked instructions');
    await symlink(source, link);
    await expect(prepareInstructionLayers({ configDir, sessionSourcePath: link })).resolves.toMatchObject({
      session: { content: 'linked instructions\n' },
    });
  });

  it('preserves an authored UTF-8 byte-order mark', async () => {
    const source = join(root, 'bom.md');
    await writeFile(source, Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('instructions')]));
    const prepared = await prepareInstructionLayers({ configDir, sessionSourcePath: source });
    expect(prepared.session?.content).toBe('\ufeffinstructions\n');
    expect(await readFile(join(configDir, 'session-instructions.md'), 'utf8')).toBe('\ufeffinstructions\n');
  });

  it('rejects missing, non-regular, malformed UTF-8, and oversized sources without leaking content', async () => {
    await expect(prepareInstructionLayers({ configDir, sessionSourcePath: join(root, 'missing.md') })).rejects.toThrow(
      /Could not read session instructions/u,
    );

    const directory = join(root, 'directory');
    await mkdir(directory);
    await expect(prepareInstructionLayers({ configDir, sessionSourcePath: directory })).rejects.toThrow(
      /not a regular file/u,
    );

    const malformed = join(root, 'malformed.md');
    await writeFile(malformed, Buffer.from([0xc3, 0x28]));
    await expect(prepareInstructionLayers({ configDir, sessionSourcePath: malformed })).rejects.toThrow(
      /not valid UTF-8/u,
    );

    const oversized = join(root, 'oversized.md');
    const secretMarker = 'DO-NOT-LEAK-CONTENT';
    await writeFile(oversized, `${secretMarker}${'x'.repeat(MAX_SESSION_INSTRUCTION_BYTES)}`);
    let message = '';
    try {
      await prepareInstructionLayers({ configDir, sessionSourcePath: oversized });
    } catch (err) {
      message = err instanceof Error ? err.message : String(err);
    }
    expect(message).toContain(String(MAX_SESSION_INSTRUCTION_BYTES));
    expect(message).not.toContain(secretMarker);
  });

  it('counts UTF-8 bytes and rejects normalization that would exceed the limit', async () => {
    const multibyte = join(root, 'multibyte.md');
    await writeFile(multibyte, '🙂'.repeat(Math.floor(MAX_SESSION_INSTRUCTION_BYTES / 4) + 1));
    await expect(prepareInstructionLayers({ configDir, sessionSourcePath: multibyte })).rejects.toThrow(/UTF-8 bytes/u);

    const boundary = join(root, 'boundary.md');
    await writeFile(boundary, 'x'.repeat(MAX_SESSION_INSTRUCTION_BYTES));
    await expect(prepareInstructionLayers({ configDir, sessionSourcePath: boundary })).rejects.toThrow(
      /final-newline normalization/u,
    );
  });

  it('preserves prior snapshots on validation failure and removes stale optional snapshots on success', async () => {
    const first = join(root, 'first.md');
    await writeFile(first, 'first');
    await prepareInstructionLayers({ configDir, protocolText: 'protocol-one', sessionSourcePath: first });
    await expect(
      prepareInstructionLayers({
        configDir,
        protocolText: 'protocol-two',
        sessionSourcePath: join(root, 'missing.md'),
      }),
    ).rejects.toThrow();
    expect(await readFile(join(configDir, 'conductor-protocol.md'), 'utf8')).toBe('protocol-one\n');
    expect(await readFile(join(configDir, 'session-instructions.md'), 'utf8')).toBe('first\n');

    await prepareInstructionLayers({ configDir, protocolText: 'protocol-two' });
    expect(await readFile(join(configDir, 'conductor-protocol.md'), 'utf8')).toBe('protocol-two\n');
    await expect(readFile(join(configDir, 'session-instructions.md'), 'utf8')).rejects.toThrow();
  });

  it('runs adapter aggregate validation before replacing prior snapshots', async () => {
    const first = join(root, 'first.md');
    const second = join(root, 'second.md');
    await writeFile(first, 'first');
    await writeFile(second, 'second');
    await prepareInstructionLayers({ configDir, protocolText: 'protocol-one', sessionSourcePath: first });

    await expect(
      prepareInstructionLayers({
        configDir,
        protocolText: 'protocol-two',
        sessionSourcePath: second,
        validate: () => {
          throw new Error('aggregate overflow');
        },
      }),
    ).rejects.toThrow(/aggregate overflow/u);
    expect(await readFile(join(configDir, 'conductor-protocol.md'), 'utf8')).toBe('protocol-one\n');
    expect(await readFile(join(configDir, 'session-instructions.md'), 'utf8')).toBe('first\n');
  });

  it('reports unreadable files without exposing their contents', async () => {
    const source = join(root, 'private.md');
    await writeFile(source, 'PRIVATE-CONTENT');
    await chmod(source, 0o000);
    try {
      await expect(prepareInstructionLayers({ configDir, sessionSourcePath: source })).rejects.toThrow(
        /Could not read session instructions/u,
      );
    } finally {
      await chmod(source, 0o600);
    }
  });
});

describe('assertHookContextFits', () => {
  it('enforces provider byte and character envelopes without echoing content', () => {
    expect(() => assertHookContextFits('x'.repeat(MAX_HOOK_CONTEXT_UTF8_BYTES))).not.toThrow();
    expect(() => assertHookContextFits('x'.repeat(MAX_HOOK_CONTEXT_CHARACTERS + 1))).toThrow(/too large/u);
    expect(() => assertHookContextFits('🙂'.repeat(2_501))).toThrow(/UTF-8 bytes/u);
  });
});
