import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AgentConfig } from '../src/config/schema.js';
import { Scheduler } from '../src/core/scheduler.js';

function agentWith(schedules: AgentConfig['schedules']): AgentConfig {
  return { codename: 'alpha', repo: '/tmp/alpha', runtime: 'claude-code', additionalDirs: [], schedules };
}

let scheduler: Scheduler;
let agents: Map<string, AgentConfig>;
let active: boolean;
let paused: boolean;
let started: { agent: string; prompt?: string }[];
let stopped: string[];
let delivered: { agent: string; text: string }[];

beforeEach(() => {
  vi.useFakeTimers();
  agents = new Map();
  active = false;
  paused = false;
  started = [];
  stopped = [];
  delivered = [];
  scheduler = new Scheduler({
    agents: () => agents,
    isActive: () => active,
    isPaused: () => paused,
    startAgent: async (agent, opts) => {
      started.push({ agent, prompt: opts.prompt });
      return 'started';
    },
    stopAgent: async (agent) => {
      stopped.push(agent);
      return 'stopped';
    },
    deliver: async (agent, text) => {
      delivered.push({ agent, text });
      return 'delivered';
    },
  });
});

afterEach(() => {
  scheduler.stop();
  vi.useRealTimers();
});

// croner supports 6-field (seconds) patterns — every-second schedules keep the
// fake-timer advances small.
const EVERY_SECOND = '* * * * * *';

describe('Scheduler', () => {
  it('delivers the prompt into an active agent', async () => {
    agents.set('alpha', agentWith([{ cron: EVERY_SECOND, prompt: 'tick', paused: false, freshSession: false }]));
    active = true;
    scheduler.rebuild();
    await vi.advanceTimersByTimeAsync(1100);
    expect(delivered[0]).toEqual({ agent: 'alpha', text: 'tick' });
    expect(started).toEqual([]);
  });

  it('starts an inactive agent with the prompt', async () => {
    agents.set('alpha', agentWith([{ cron: EVERY_SECOND, prompt: 'wake up', paused: false, freshSession: false }]));
    scheduler.rebuild();
    await vi.advanceTimersByTimeAsync(1100);
    expect(started[0]).toEqual({ agent: 'alpha', prompt: 'wake up' });
    expect(delivered).toEqual([]);
  });

  it('stops then restarts for freshSession schedules', async () => {
    agents.set('alpha', agentWith([{ cron: EVERY_SECOND, prompt: 'nightly', paused: false, freshSession: true }]));
    active = true;
    scheduler.rebuild();
    await vi.advanceTimersByTimeAsync(1100); // fire -> stop + settle sleep begins
    expect(stopped).toEqual(['alpha']);
    expect(started).toEqual([]);
    await vi.advanceTimersByTimeAsync(3100); // settle period elapses
    expect(started[0]).toEqual({ agent: 'alpha', prompt: 'nightly' });
  });

  it('defers when the agent is paused', async () => {
    agents.set('alpha', agentWith([{ cron: EVERY_SECOND, prompt: 'tick', paused: false, freshSession: false }]));
    paused = true;
    scheduler.rebuild();
    await vi.advanceTimersByTimeAsync(1100);
    expect(started).toEqual([]);
    expect(delivered).toEqual([]);
  });

  it('skips schedule entries marked paused', async () => {
    agents.set('alpha', agentWith([{ cron: EVERY_SECOND, prompt: 'tick', paused: true, freshSession: false }]));
    scheduler.rebuild();
    await vi.advanceTimersByTimeAsync(2100);
    expect(started).toEqual([]);
    expect(delivered).toEqual([]);
  });

  it('tolerates invalid cron patterns without dropping valid ones', async () => {
    agents.set(
      'alpha',
      agentWith([
        { cron: 'not a cron', prompt: 'never', paused: false, freshSession: false },
        { cron: EVERY_SECOND, prompt: 'still works', paused: false, freshSession: false },
      ]),
    );
    expect(() => {
      scheduler.rebuild();
    }).not.toThrow();
    await vi.advanceTimersByTimeAsync(1100);
    expect(started[0]?.prompt).toBe('still works');
  });

  it('rebuild replaces jobs and stop() cancels them', async () => {
    agents.set('alpha', agentWith([{ cron: EVERY_SECOND, prompt: 'tick', paused: false, freshSession: false }]));
    scheduler.rebuild();
    scheduler.rebuild(); // must not double-arm
    await vi.advanceTimersByTimeAsync(1100);
    expect(started.length).toBe(1);

    scheduler.stop();
    await vi.advanceTimersByTimeAsync(3000);
    expect(started.length).toBe(1);
  });
});
