import { describe, expect, it } from 'vitest';
import { deriveInstanceDefaults, fleetSlug, PORT_RANGE_SIZE, PORT_RANGE_START } from '../src/config/instance.js';

describe('deriveInstanceDefaults', () => {
  it('is deterministic for the same fleet directory', () => {
    expect(deriveInstanceDefaults('/tmp/fleet-a')).toEqual(deriveInstanceDefaults('/tmp/fleet-a'));
  });

  it('normalizes relative and absolute forms of the same path to one identity', () => {
    const abs = deriveInstanceDefaults(`${process.cwd()}/some-fleet`);
    const rel = deriveInstanceDefaults('./some-fleet');
    expect(rel).toEqual(abs);
  });

  it('keeps the derived port inside the documented range', () => {
    for (const dir of ['/tmp/a', '/tmp/b', '/home/user/fleets/prod', '/x']) {
      const { port } = deriveInstanceDefaults(dir);
      expect(port).toBeGreaterThanOrEqual(PORT_RANGE_START);
      expect(port).toBeLessThan(PORT_RANGE_START + PORT_RANGE_SIZE);
    }
  });

  it('gives fleets with the same basename but different parents distinct tmux sessions', () => {
    const a = deriveInstanceDefaults('/tmp/team-a/fleet');
    const b = deriveInstanceDefaults('/tmp/team-b/fleet');
    expect(a.tmuxSessionName).not.toBe(b.tmuxSessionName);
  });

  it('derives human-readable names from the fleet dir basename', () => {
    const { tmuxSessionName, windowName } = deriveInstanceDefaults('/tmp/My Fleet!');
    expect(windowName).toBe('Agent Conductor (My Fleet!)');
    expect(tmuxSessionName).toMatch(/^conductor-my-fleet-[0-9a-f]{4}$/);
  });
});

describe('fleetSlug', () => {
  it('reduces the basename to a safe slug with a stable hash suffix', () => {
    expect(fleetSlug('/tmp/Prod Fleet #1')).toMatch(/^prod-fleet-1-[0-9a-f]{4}$/);
  });

  it('never exceeds a tmux-friendly length', () => {
    const slug = fleetSlug(`/tmp/${'x'.repeat(200)}`);
    expect(slug.length).toBeLessThanOrEqual(24 + 5);
  });

  it('survives a basename with no safe characters', () => {
    expect(fleetSlug('/tmp/###')).toMatch(/^[0-9a-f]{4}$/);
  });
});
