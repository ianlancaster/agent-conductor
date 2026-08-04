import { createHash } from 'node:crypto';
import { basename, resolve } from 'node:path';

/**
 * Per-fleet derived defaults. The unnamed instance preserves the historical
 * directory-only derivation byte-for-byte. Named instances add their selector
 * to the digest and human-readable labels so processes in one fleet directory
 * cannot share ports, terminal ownership markers, or daemon names.
 */

/** Base of the derived-port range. */
export const PORT_RANGE_START = 3456;
/** Size of the derived-port range (PORT_RANGE_START .. START+SIZE-1). */
export const PORT_RANGE_SIZE = 500;

export interface FleetDefaults {
  port: number;
  tmuxSessionName: string;
  windowName: string;
}

/** Stable 32-bit hash of the resolved fleet directory and optional instance. */
function fleetHash(baseDir: string, instance?: string): number {
  const identity = instance === undefined ? resolve(baseDir) : `${resolve(baseDir)}\0${instance}`;
  const digest = createHash('sha256').update(identity).digest();
  return digest.readUInt32BE(0);
}

/** Fleet identity reduced to a safe slug for pane markers and service labels. */
export function fleetSlug(baseDir: string, instance?: string): string {
  const baseName = basename(resolve(baseDir))
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  // The unnamed branch intentionally preserves the historical operation order:
  // sanitize and strip the basename, then truncate. A dash at the truncation
  // boundary therefore remains part of existing fleet identities.
  const name =
    instance === undefined ? baseName.slice(0, 24) : `${baseName}-${instance}`.slice(0, 24).replace(/-+$/g, '');
  const hash4 = fleetHash(baseDir, instance).toString(16).padStart(8, '0').slice(0, 4);
  return name.length > 0 ? `${name}-${hash4}` : hash4;
}

export function deriveFleetDefaults(baseDir: string, instance?: string): FleetDefaults {
  const dir = resolve(baseDir);
  const name = basename(dir);
  return {
    port: PORT_RANGE_START + (fleetHash(dir, instance) % PORT_RANGE_SIZE),
    tmuxSessionName: `conductor-${fleetSlug(dir, instance)}`,
    windowName: `Agent Conductor (${name}${instance === undefined ? '' : ` · ${instance}`})`,
  };
}
