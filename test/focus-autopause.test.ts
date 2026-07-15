import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FocusAutoPause } from '../src/core/focus-autopause.js';
import { AgentStateManager } from '../src/core/state.js';
import { Store } from '../src/store/index.js';
import { FakeTerminalBackend } from './fakes/fake-terminal.js';

const CHECK_MS = 5000;
const RESUME_DELAY_MS = 60_000;

let store: Store;
let backend: FakeTerminalBackend;
let states: AgentStateManager;
let autoPause: FocusAutoPause;
let healthResets: string[];

beforeEach(() => {
  vi.useFakeTimers();
  store = new Store(':memory:');
  backend = new FakeTerminalBackend();
  states = new AgentStateManager(store, 'facilitated');
  states.register('alpha', false);
  states.setAutonomy('alpha', 'autonomous');
  healthResets = [];
  autoPause = new FocusAutoPause({
    backend,
    states,
    healthReset: (agent) => healthResets.push(agent),
    config: { checkMs: CHECK_MS, resumeDelayMs: RESUME_DELAY_MS, startEnabled: true },
  });
  autoPause.start();
});

afterEach(() => {
  autoPause.stop();
  store.close();
  vi.useRealTimers();
});

async function tick(): Promise<void> {
  await vi.advanceTimersByTimeAsync(CHECK_MS + 1);
}

describe('FocusAutoPause', () => {
  it('pauses an autonomous agent when its pane gains focus', async () => {
    backend.focusedAgent = 'alpha';
    await tick();
    expect(states.getAutonomy('alpha')).toBe('facilitated');
    expect(states.get('alpha')?.pause?.pausedBy).toBe('auto-focus');
  });

  it('resumes after the cooldown once focus leaves', async () => {
    backend.focusedAgent = 'alpha';
    await tick();
    backend.focusedAgent = null;
    await tick();
    expect(states.isPaused('alpha')).toBe(true); // cooldown running
    await vi.advanceTimersByTimeAsync(RESUME_DELAY_MS + 1);
    expect(states.getAutonomy('alpha')).toBe('autonomous');
    expect(states.isPaused('alpha')).toBe(false);
    expect(healthResets).toEqual(['alpha']);
  });

  it('cancels the pending resume when refocused during the cooldown', async () => {
    backend.focusedAgent = 'alpha';
    await tick();
    backend.focusedAgent = null;
    await tick();
    backend.focusedAgent = 'alpha';
    await tick();
    await vi.advanceTimersByTimeAsync(RESUME_DELAY_MS * 2);
    expect(states.isPaused('alpha')).toBe(true);
  });

  it('never pauses facilitated agents', async () => {
    states.setAutonomy('alpha', 'facilitated');
    backend.focusedAgent = 'alpha';
    await tick();
    expect(states.isPaused('alpha')).toBe(false);
  });

  it('does not auto-resume a manual pause', async () => {
    states.setAutonomy('alpha', 'autonomous');
    states.pause('alpha', 'manual');
    backend.focusedAgent = 'alpha';
    await tick();
    backend.focusedAgent = null;
    await tick();
    await vi.advanceTimersByTimeAsync(RESUME_DELAY_MS * 2);
    expect(states.isPaused('alpha')).toBe(true);
    expect(states.get('alpha')?.pause?.pausedBy).toBe('manual');
  });

  it('does nothing while disabled', async () => {
    autoPause.setEnabled(false);
    backend.focusedAgent = 'alpha';
    await tick();
    expect(states.isPaused('alpha')).toBe(false);
    autoPause.setEnabled(true);
    await tick();
    expect(states.isPaused('alpha')).toBe(true);
  });
});
