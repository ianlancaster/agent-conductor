import { randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, open, readdir, realpath, rm, writeFile } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { InstructionPreparationError } from './instructions.js';
import type { RuntimeEvent } from '../core/types.js';

export const MAX_CONTINUITY_STATE_BYTES = 5 * 1024;
export const MAX_CONTINUITY_COMPACT_CONTEXT_BYTES = 16 * 1024;
export const CONTINUITY_READER_PREFIX = 'continuity-state-reader-';

export const CONTINUITY_OUTCOMES = [
  'emitted',
  'missing',
  'unreadable',
  'not-file',
  'invalid-utf8',
  'oversized',
] as const;
export type ContinuityOutcome = (typeof CONTINUITY_OUTCOMES)[number];
export type ContinuitySource = 'startup' | 'resume' | 'compact';

const CONTINUITY_AUTHORITY_NOTICE =
  'This bounded factual state and the prepared static session instructions are revocable operator-derived context. Current authenticated operator directions outrank either source; the mandatory Conductor protocol remains authoritative.';
const DEGRADED_CONTINUITY_AUTHORITY_NOTICE =
  "The prepared static session instructions remain revocable operator-derived context. Current authenticated operator directions outrank them; follow the mandatory Conductor protocol and the operator's current recovery or hold direction before consequential work.";

export interface PreparedContinuityState {
  canonicalPath: string;
  byteCount: number;
}

export interface ContinuityReaderOptions {
  prepared: PreparedContinuityState;
  eventsUrl: string;
  /** Codex restores its prepared static layers before dynamic state on compact only. */
  compactPrefix?: string;
}

export class ContinuityStatePreparationError extends InstructionPreparationError {
  constructor(message: string) {
    super(message);
    this.name = 'ContinuityStatePreparationError';
  }
}

function preparationError(filePath: string, reason: string): ContinuityStatePreparationError {
  return new ContinuityStatePreparationError(`Could not prepare continuity state at ${filePath}: ${reason}.`);
}

async function readOpenedState(filePath: string): Promise<{ content: string; byteCount: number }> {
  let handle;
  try {
    handle = await open(filePath, constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ELOOP') throw preparationError(filePath, 'the final path component is a symbolic link');
    throw preparationError(filePath, code === 'ENOENT' ? 'the file is missing' : 'the file is unreadable');
  }

  try {
    const metadata = await handle.stat();
    if (!metadata.isFile()) throw preparationError(filePath, 'the path is not a regular file');
    const buffer = Buffer.alloc(MAX_CONTINUITY_STATE_BYTES + 1);
    let offset = 0;
    while (offset < buffer.length) {
      const { bytesRead } = await handle.read(buffer, offset, buffer.length - offset, offset);
      if (bytesRead === 0) break;
      offset += bytesRead;
    }
    if (offset > MAX_CONTINUITY_STATE_BYTES) {
      throw preparationError(filePath, `the file exceeds ${MAX_CONTINUITY_STATE_BYTES} UTF-8 bytes`);
    }
    try {
      const content = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(buffer.subarray(0, offset));
      return { content, byteCount: offset };
    } catch {
      throw preparationError(filePath, 'the file is not valid UTF-8');
    }
  } catch (error) {
    if (error instanceof ContinuityStatePreparationError) throw error;
    throw preparationError(filePath, 'the file is unreadable');
  } finally {
    await handle.close();
  }
}

/** Resolve and validate a fresh-state source without snapshotting its contents. */
export async function prepareContinuityStateSource(sourcePath: string): Promise<PreparedContinuityState> {
  const parent = await realpath(dirname(sourcePath)).catch(() => {
    throw preparationError(sourcePath, 'the parent directory is missing or unreadable');
  });
  const canonicalPath = join(parent, basename(sourcePath));
  let metadata;
  try {
    metadata = await lstat(canonicalPath);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    throw preparationError(sourcePath, code === 'ENOENT' ? 'the file is missing' : 'the file is unreadable');
  }
  if (metadata.isSymbolicLink()) throw preparationError(sourcePath, 'the final path component is a symbolic link');
  const { byteCount } = await readOpenedState(canonicalPath);
  return { canonicalPath, byteCount };
}

export function renderContinuityContext(content: string, byteCount: number): string {
  return [
    '# Fresh continuity state',
    `Source: continuityStateFile; UTF-8 bytes: ${String(byteCount)}. The following byte-counted content may contain delimiter-like text.`,
    '<continuity-state-content>',
    content,
    '</continuity-state-content>',
    CONTINUITY_AUTHORITY_NOTICE,
  ].join('\n');
}

export function renderDegradedContinuityContext(outcome: Exclude<ContinuityOutcome, 'emitted'>): string {
  return [
    '# Continuity restoration degraded',
    `Fresh continuity state was not restored (reason: ${outcome}).`,
    DEGRADED_CONTINUITY_AUTHORITY_NOTICE,
  ].join('\n');
}

export function assertContinuityCompactContextFits(context: string): void {
  const bytes = Buffer.byteLength(context, 'utf8');
  if (bytes > MAX_CONTINUITY_COMPACT_CONTEXT_BYTES) {
    throw new ContinuityStatePreparationError(
      `Prepared continuity compact context is too large (${String(bytes)} UTF-8 bytes); the limit is ${String(MAX_CONTINUITY_COMPACT_CONTEXT_BYTES)}.`,
    );
  }
}

/** Render the standalone fresh reader shared by the Claude Code and Codex adapters. */
export function renderContinuityReaderScript(options: ContinuityReaderOptions): string {
  const maximumDynamicContext = renderContinuityContext(
    'x'.repeat(MAX_CONTINUITY_STATE_BYTES),
    MAX_CONTINUITY_STATE_BYTES,
  );
  assertContinuityCompactContextFits(
    options.compactPrefix === undefined
      ? maximumDynamicContext
      : `${options.compactPrefix}\n\n${maximumDynamicContext}`,
  );

  return `#!/usr/bin/env node
import { constants, openSync, closeSync, fstatSync, readSync } from 'node:fs';
import { execFileSync } from 'node:child_process';

const configuredPath = ${JSON.stringify(options.prepared.canonicalPath)};
const eventsUrl = ${JSON.stringify(options.eventsUrl)};
const compactPrefix = ${JSON.stringify(options.compactPrefix ?? null)};
const maxBytes = ${String(MAX_CONTINUITY_STATE_BYTES)};
let hookInput = '';
for await (const chunk of process.stdin) hookInput += chunk;
const parsed = JSON.parse(hookInput || '{}');
const source = parsed.source;
if (source !== 'startup' && source !== 'resume' && source !== 'compact') {
  throw new Error('unexpected continuity SessionStart source');
}

let outcome = 'emitted';
let content = '';
let byteCount;
let descriptor;
try {
  try {
    descriptor = openSync(configuredPath, constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch (error) {
    const code = error && typeof error === 'object' ? error.code : undefined;
    outcome = code === 'ENOENT' ? 'missing' : code === 'ELOOP' ? 'not-file' : 'unreadable';
  }
  if (descriptor !== undefined && outcome === 'emitted') {
    try {
      const metadata = fstatSync(descriptor);
      if (!metadata.isFile()) outcome = 'not-file';
      if (outcome === 'emitted') {
        const buffer = Buffer.alloc(maxBytes + 1);
        let offset = 0;
        while (offset < buffer.length) {
          const bytesRead = readSync(descriptor, buffer, offset, buffer.length - offset, offset);
          if (bytesRead === 0) break;
          offset += bytesRead;
        }
        if (offset > maxBytes) outcome = 'oversized';
        else {
          try {
            content = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(buffer.subarray(0, offset));
            byteCount = offset;
          } catch {
            outcome = 'invalid-utf8';
          }
        }
      }
    } catch (error) {
      const code = error && typeof error === 'object' ? error.code : undefined;
      if (typeof code === 'string') outcome = 'unreadable';
      else throw error;
    }
  }
} finally {
  if (descriptor !== undefined) closeSync(descriptor);
}

const dynamicContext = outcome === 'emitted'
  ? ['# Fresh continuity state', 'Source: continuityStateFile; UTF-8 bytes: ' + String(byteCount) + '. The following byte-counted content may contain delimiter-like text.', '<continuity-state-content>', content, '</continuity-state-content>', ${JSON.stringify(CONTINUITY_AUTHORITY_NOTICE)}].join('\\n')
  : ['# Continuity restoration degraded', 'Fresh continuity state was not restored (reason: ' + outcome + ').', ${JSON.stringify(DEGRADED_CONTINUITY_AUTHORITY_NOTICE)}].join('\\n');
const additionalContext = source === 'compact' && compactPrefix !== null
  ? compactPrefix + '\\n\\n' + dynamicContext
  : dynamicContext;
if (Buffer.byteLength(additionalContext, 'utf8') > ${String(MAX_CONTINUITY_COMPACT_CONTEXT_BYTES)}) {
  throw new Error('continuity compact context exceeded the prepared byte envelope');
}
const output = { hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext } };
process.stdout.write(JSON.stringify(output));

const report = { hook_event_name: 'ContinuityStateRestoration', source, outcome, ...(byteCount === undefined ? {} : { byte_count: byteCount }) };
try {
  execFileSync('curl', ['-fsS', '-m', '2', '-X', 'POST', '-H', 'Content-Type: application/json', '--data-binary', '@-', eventsUrl], {
    input: JSON.stringify(report),
    stdio: ['pipe', 'ignore', 'ignore'],
  });
} catch {
  // Attempt reporting is best-effort and must not suppress local restoration.
}
`;
}

export async function writeContinuityReaderGeneration(
  configDir: string,
  options: ContinuityReaderOptions,
): Promise<string> {
  const path = join(configDir, `${CONTINUITY_READER_PREFIX}${randomUUID()}.mjs`);
  await writeFile(path, renderContinuityReaderScript(options), { encoding: 'utf8', mode: 0o700, flag: 'wx' });
  return path;
}

/** Remove unreachable reader generations only after the provider hook config commits. */
export async function cleanupContinuityReaderGenerations(configDir: string, keep?: string): Promise<void> {
  let entries: string[];
  try {
    entries = await readdir(configDir);
  } catch {
    return;
  }
  await Promise.all(
    entries
      .filter((entry) => entry.startsWith(CONTINUITY_READER_PREFIX) && entry.endsWith('.mjs'))
      .map(async (entry) => {
        const path = join(configDir, entry);
        if (path !== keep) await rm(path, { force: true });
      }),
  );
}

/** Parse the metadata-only report emitted by a generated continuity reader. */
export function parseContinuityRestorationEvent(
  body: Record<string, unknown>,
): Omit<RuntimeEvent, 'session' | 'receivedAt'> | null {
  if (body.hook_event_name !== 'ContinuityStateRestoration') return null;
  const source = body.source;
  const outcome = body.outcome;
  if (source !== 'startup' && source !== 'resume' && source !== 'compact') return null;
  if (typeof outcome !== 'string' || !CONTINUITY_OUTCOMES.includes(outcome as ContinuityOutcome)) return null;
  const normalizedOutcome = outcome as ContinuityOutcome;
  const byteCount = body.byte_count;
  if (
    normalizedOutcome === 'emitted' &&
    (!Number.isSafeInteger(byteCount) ||
      (byteCount as number) < 0 ||
      (byteCount as number) > MAX_CONTINUITY_STATE_BYTES)
  ) {
    return null;
  }
  return {
    type: 'continuity-restoration',
    continuitySource: source,
    continuityOutcome: normalizedOutcome,
    ...(normalizedOutcome === 'emitted' ? { byteCount: byteCount as number } : {}),
  };
}
