import { randomUUID } from 'node:crypto';
import { mkdir, open, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

export const MAX_SESSION_INSTRUCTION_BYTES = 5 * 1024;
export const MAX_HOOK_CONTEXT_UTF8_BYTES = 10_000;
export const MAX_HOOK_CONTEXT_CHARACTERS = 10_000;

export const PROTOCOL_SNAPSHOT_NAME = 'conductor-protocol.md';
export const SESSION_INSTRUCTIONS_SNAPSHOT_NAME = 'session-instructions.md';

export interface PreparedInstructionLayer {
  content: string;
  path: string;
}

export interface PreparedInstructionLayers {
  protocol?: PreparedInstructionLayer;
  session?: PreparedInstructionLayer;
}

export interface PrepareInstructionLayersOptions {
  configDir: string;
  protocolText?: string;
  sessionSourcePath?: string;
  /** Adapter-owned aggregate validation that must pass before snapshots change. */
  validate?: (layers: PreparedInstructionLayers) => void;
}

export class InstructionPreparationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InstructionPreparationError';
  }
}

function normalizeFinalNewline(text: string): string {
  return text.endsWith('\n') ? text : `${text}\n`;
}

function preparedLayer(content: string, path: string): PreparedInstructionLayer {
  const normalized = normalizeFinalNewline(content);
  return {
    content: normalized,
    path,
  };
}

async function readBoundedUtf8(filePath: string): Promise<string> {
  let handle;
  try {
    handle = await open(filePath, 'r');
  } catch (err) {
    throw new InstructionPreparationError(
      `Could not read session instructions at ${filePath}: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  try {
    const metadata = await handle.stat();
    if (!metadata.isFile()) {
      throw new InstructionPreparationError(`Session instructions path is not a regular file: ${filePath}`);
    }
    if (metadata.size > MAX_SESSION_INSTRUCTION_BYTES) {
      throw new InstructionPreparationError(
        `Session instructions at ${filePath} are ${metadata.size} UTF-8 bytes; the limit is ${MAX_SESSION_INSTRUCTION_BYTES}.`,
      );
    }

    const buffer = Buffer.alloc(MAX_SESSION_INSTRUCTION_BYTES + 1);
    let offset = 0;
    while (offset < buffer.length) {
      const { bytesRead } = await handle.read(buffer, offset, buffer.length - offset, offset);
      if (bytesRead === 0) break;
      offset += bytesRead;
    }
    if (offset > MAX_SESSION_INSTRUCTION_BYTES) {
      throw new InstructionPreparationError(
        `Session instructions at ${filePath} exceed the ${MAX_SESSION_INSTRUCTION_BYTES} UTF-8 byte limit.`,
      );
    }

    let decoded: string;
    try {
      decoded = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(buffer.subarray(0, offset));
    } catch {
      throw new InstructionPreparationError(`Session instructions at ${filePath} are not valid UTF-8.`);
    }
    const normalized = normalizeFinalNewline(decoded);
    const normalizedBytes = Buffer.byteLength(normalized, 'utf8');
    if (normalizedBytes > MAX_SESSION_INSTRUCTION_BYTES) {
      throw new InstructionPreparationError(
        `Session instructions at ${filePath} are ${normalizedBytes} UTF-8 bytes after final-newline normalization; the limit is ${MAX_SESSION_INSTRUCTION_BYTES}.`,
      );
    }
    return normalized;
  } finally {
    await handle.close();
  }
}

export async function writeAtomicFile(filePath: string, content: string, mode: number): Promise<void> {
  const temporary = `${filePath}.${process.pid}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, content, { encoding: 'utf8', mode, flag: 'wx' });
    await rename(temporary, filePath);
  } finally {
    await rm(temporary, { force: true });
  }
}

/** Prepare immutable, per-launch instruction snapshots for a runtime adapter. */
export async function prepareInstructionLayers(
  options: PrepareInstructionLayersOptions,
): Promise<PreparedInstructionLayers> {
  const protocolPath = join(options.configDir, PROTOCOL_SNAPSHOT_NAME);
  const sessionPath = join(options.configDir, SESSION_INSTRUCTIONS_SNAPSHOT_NAME);
  const protocol = options.protocolText === undefined ? undefined : preparedLayer(options.protocolText, protocolPath);
  const sessionText =
    options.sessionSourcePath === undefined ? undefined : await readBoundedUtf8(options.sessionSourcePath);
  const session = sessionText === undefined ? undefined : preparedLayer(sessionText, sessionPath);
  const layers = { protocol, session };

  // Validate every input before replacing a prior prepared snapshot.
  options.validate?.(layers);
  await mkdir(options.configDir, { recursive: true });
  if (protocol === undefined) await rm(protocolPath, { force: true });
  else await writeAtomicFile(protocol.path, protocol.content, 0o600);
  if (session === undefined) await rm(sessionPath, { force: true });
  else await writeAtomicFile(session.path, session.content, 0o600);
  return layers;
}

/** Guard against provider fallback to truncated or spilled hook context. */
export function assertHookContextFits(context: string): void {
  const bytes = Buffer.byteLength(context, 'utf8');
  if (bytes > MAX_HOOK_CONTEXT_UTF8_BYTES || context.length > MAX_HOOK_CONTEXT_CHARACTERS) {
    throw new InstructionPreparationError(
      `Prepared compact-restoration context is too large (${bytes} UTF-8 bytes, ${context.length} characters); ` +
        `limits are ${MAX_HOOK_CONTEXT_UTF8_BYTES} bytes and ${MAX_HOOK_CONTEXT_CHARACTERS} characters.`,
    );
  }
}
