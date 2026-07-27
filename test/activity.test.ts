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
