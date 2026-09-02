// The supervisor does not expose /health until configured operator channels are
// ready. Slack alone has a 45-second startup deadline, so the launcher must
// wait longer than any individual channel instead of reporting a false failure
// while the supervisor is still starting successfully.
export const CONDUCTOR_START_TIMEOUT_MS = 60_000;
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
