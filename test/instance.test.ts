import { describe, expect, it } from 'vitest';
import { deriveFleetDefaults, fleetSlug, PORT_RANGE_SIZE, PORT_RANGE_START } from '../src/config/derived-defaults.js';

describe('deriveFleetDefaults', () => {
  it('pins the historical unnamed identity byte-for-byte', () => {
    expect(deriveFleetDefaults('/tmp/fleet-a')).toEqual({
      port: 3886,
      tmuxSessionName: 'conductor-fleet-a-b0e0',
      windowName: 'Agent Conductor (fleet-a)',
    });
    expect(fleetSlug('/tmp/fleet-a')).toBe('fleet-a-b0e0');
    expect(fleetSlug('/tmp/abc-def-ghi-jkl-mno-pqr-stu')).toBe('abc-def-ghi-jkl-mno-pqr--c999');
    expect(deriveFleetDefaults('/tmp/abc-def-ghi-jkl-mno-pqr-stu').tmuxSessionName).toBe(
      'conductor-abc-def-ghi-jkl-mno-pqr--c999',
    );
  });

  it('is deterministic for the same fleet directory', () => {
    expect(deriveFleetDefaults('/tmp/fleet-a')).toEqual(deriveFleetDefaults('/tmp/fleet-a'));
  });

  it('normalizes relative and absolute forms of the same path to one identity', () => {
    const abs = deriveFleetDefaults(`${process.cwd()}/some-fleet`);
    const rel = deriveFleetDefaults('./some-fleet');
    expect(rel).toEqual(abs);
  });

  it('keeps the derived port inside the documented range', () => {
    for (const dir of ['/tmp/a', '/tmp/b', '/home/user/fleets/prod', '/x']) {
      const { port } = deriveFleetDefaults(dir);
      expect(port).toBeGreaterThanOrEqual(PORT_RANGE_START);
      expect(port).toBeLessThan(PORT_RANGE_START + PORT_RANGE_SIZE);
    }
  });

  it('gives fleets with the same basename but different parents distinct tmux sessions', () => {
    const a = deriveFleetDefaults('/tmp/team-a/fleet');
    const b = deriveFleetDefaults('/tmp/team-b/fleet');
    expect(a.tmuxSessionName).not.toBe(b.tmuxSessionName);
  });

  it('derives human-readable names from the fleet dir basename', () => {
    const { tmuxSessionName, windowName } = deriveFleetDefaults('/tmp/My Fleet!');
    expect(windowName).toBe('Agent Conductor (My Fleet!)');
    expect(tmuxSessionName).toMatch(/^conductor-my-fleet-[0-9a-f]{4}$/);
  });

  it('gives named instances distinct ports, pane identities, and terminal names', () => {
    const unnamed = deriveFleetDefaults('/tmp/fleet-a');
    const frontend = deriveFleetDefaults('/tmp/fleet-a', 'frontend');
    const backend = deriveFleetDefaults('/tmp/fleet-a', 'backend');

    expect(new Set([unnamed.port, frontend.port, backend.port])).toHaveLength(3);
    expect(new Set([unnamed.tmuxSessionName, frontend.tmuxSessionName, backend.tmuxSessionName])).toHaveLength(3);
    expect(frontend.windowName).toBe('Agent Conductor (fleet-a · frontend)');
    expect(fleetSlug('/tmp/fleet-a', 'frontend')).not.toBe(fleetSlug('/tmp/fleet-a', 'backend'));
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
