export const CONDUCTOR_START_TIMEOUT_MS = 30_000;
const CONDUCTOR_START_POLL_MS = 250;

export interface StartupWaitDeps {
  conductorUp(): Promise<boolean>;
  childExited(): boolean;
  sleep(ms: number): Promise<void>;
  now(): number;
}

/** Wait for the detached Conductor's health endpoint within the launcher deadline. */
export async function waitForConductorStart(
  deps: StartupWaitDeps,
  timeoutMs = CONDUCTOR_START_TIMEOUT_MS,
): Promise<boolean> {
  const deadline = deps.now() + timeoutMs;
  while (!(await deps.conductorUp())) {
    if (deps.childExited() || deps.now() >= deadline) return false;
    await deps.sleep(CONDUCTOR_START_POLL_MS);
  }
  return true;
}
