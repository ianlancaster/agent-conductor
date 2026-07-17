import { createHash } from 'node:crypto';
import { basename, resolve } from 'node:path';

/**
 * Per-fleet instance defaults, derived deterministically from the fleet
 * directory path. Multiple conductors (one per fleet dir) get non-colliding
 * ports, tmux session names, and window titles without any manual config —
 * and the values are stable across restarts, which matters because agent MCP
 * configs bake the port into their URLs.
 *
 * Explicit values in supervisor.yaml always win; these only fill the gaps.
 */

/** Base of the derived-port range. */
export const PORT_RANGE_START = 3456;
/** Size of the derived-port range (PORT_RANGE_START .. START+SIZE-1). */
export const PORT_RANGE_SIZE = 500;

export interface InstanceDefaults {
  port: number;
  tmuxSessionName: string;
  windowName: string;
}

/** Stable 32-bit hash of the resolved fleet directory path. */
function fleetHash(baseDir: string): number {
  const digest = createHash('sha256').update(resolve(baseDir)).digest();
  return digest.readUInt32BE(0);
}

/** Fleet dir basename reduced to a safe slug for tmux targets and labels. */
export function fleetSlug(baseDir: string): string {
  const name = basename(resolve(baseDir))
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 24);
  const hash4 = fleetHash(baseDir).toString(16).padStart(8, '0').slice(0, 4);
  return name.length > 0 ? `${name}-${hash4}` : hash4;
}

export function deriveInstanceDefaults(baseDir: string): InstanceDefaults {
  const dir = resolve(baseDir);
  const name = basename(dir);
  return {
    port: PORT_RANGE_START + (fleetHash(dir) % PORT_RANGE_SIZE),
    tmuxSessionName: `conductor-${fleetSlug(dir)}`,
    windowName: `Agent Conductor (${name})`,
  };
}
