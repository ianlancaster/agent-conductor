import { describe, expect, it, vi } from 'vitest';
import { observePaneActivity } from '../src/core/activity.js';
import { FakeRuntime } from './fakes/fake-runtime.js';
import { FakeTerminalBackend } from './fakes/fake-terminal.js';

describe('observePaneActivity', () => {
  it('uses the runtime execution parser independently from composer input state', async () => {
    const backend = new FakeTerminalBackend();
    const pane = await backend.createPane('alpha', 'pane');
    const runtime = new FakeRuntime();
    runtime.inputState = 'clear';
    runtime.activityState = 'working';

    await expect(observePaneActivity(backend, runtime, 'alpha', pane, 40)).resolves.toBe('working');
  });

  it('uses styled capture when the runtime requires it', async () => {
    const backend = new FakeTerminalBackend();
    const pane = await backend.createPane('alpha', 'pane');
    const runtime = new FakeRuntime();
    runtime.capabilities.styledCapture = true;
    runtime.activityState = 'idle';
    const styled = vi.fn(async () => 'styled pane');
    Object.assign(backend, { captureStyled: styled });

    await expect(observePaneActivity(backend, runtime, 'alpha', pane, 40)).resolves.toBe('idle');
    expect(styled).toHaveBeenCalledWith(pane, 40);
  });

  it('looks deeper once when the default window cannot classify the frame', async () => {
    // A peer's long message expands the composer and pushes the runtime's status
    // row out of an ordinary capture. Freezing activity at its previous value
    // there is what takes fleet watch down, so one bounded deeper look is made.
    const backend = new FakeTerminalBackend();
    const pane = await backend.createPane('alpha', 'pane');
    const runtime = new FakeRuntime();
    const requested: number[] = [];
    backend.capture = async (_pane, lines) => {
      requested.push(lines);
      return lines > 40 ? 'deep capture' : 'shallow capture';
    };
    runtime.parseActivityState = (capture) => (capture === 'deep capture' ? 'working' : 'unknown');

    await expect(observePaneActivity(backend, runtime, 'alpha', pane, 40)).resolves.toBe('working');
    expect(requested).toEqual([40, 200]);
  });

  it('does not pay for a deeper capture when the first observation is decisive', async () => {
    const backend = new FakeTerminalBackend();
    const pane = await backend.createPane('alpha', 'pane');
    const runtime = new FakeRuntime();
    const requested: number[] = [];
    backend.capture = async (_pane, lines) => {
      requested.push(lines);
      return 'pane';
    };
    runtime.activityState = 'idle';

    await expect(observePaneActivity(backend, runtime, 'alpha', pane, 40)).resolves.toBe('idle');
    expect(requested).toEqual([40]);
  });

  it('returns unknown when pane capture fails', async () => {
    const backend = new FakeTerminalBackend();
    const pane = await backend.createPane('alpha', 'pane');
    const runtime = new FakeRuntime();
    backend.capture = async () => {
      throw new Error('capture unavailable');
    };

    await expect(observePaneActivity(backend, runtime, 'alpha', pane, 40)).resolves.toBe('unknown');
  });
});
