# iTerm automation and macOS app-launch failures

Conductor runs iTerm AppleScripts through one persistent interpreter per Conductor
process. Each request receives a fresh script object. This avoids starting and
registering a new `osascript` process for every capture or health check.
The interpreter is recycled between requests after 1,000 completions to bound
native cache growth, reducing routine interpreter launches by a factor of 1,000.

The queue holds at most 64 requests. Each request has a 20-second deadline,
including queue time. A failed interpreter is killed, pending work is rejected,
and new interpreter launches are suppressed for 20 seconds. Conductor never
automatically replays an interpreter request whose result was lost: a terminal
write may already have happened. Script errors leave a healthy interpreter reusable.
An idle interpreter does not keep a one-shot CLI alive and exits with its owner.

## Apps say they are no longer open

A macOS Launch Services identity failure can leave newly launched applications in
the `T` (stopped) state while older applications continue working. A long-lived
system with very frequent short-lived automation processes can advance application
serial numbers through a 32-bit rollover. On an affected system, a bundle lookup
can return a different identity from a PID lookup, and app launches or Apple Events
then fail with `-600` (`procNotFound`). Reducing process churn is a mitigation; it
does not repair a Launch Services registry that is already in this state.

Inspect before restarting anything:

```bash
ps -axo pid,ppid,state,comm | awk 'NR == 1 || $3 ~ /T/'
lsappinfo find bundleid=com.apple.systemevents
# Substitute the actual System Events PID from ps:
lsappinfo find pid=12345
```

The bundle and PID lookups should identify the same application. Collect the
identities and relevant `CoreServicesUIAgent`/`launchservicesd` logs for diagnosis.
Do not conclude that every stopped process has this cause: debuggers and deliberate
process suspension also produce `T`.

Sending `SIGCONT` to a verified, unintentionally stopped app can recover that
individual process without discarding its memory, but may not repair app discovery,
dialogs, or future launches. Never resume an arbitrary list of stopped processes.
Save work before a logout or reboot to reset an affected GUI session. Restarting
Launch Services can disrupt running applications and is not an automatic recovery
action. Do not disable system protections or clear permissions/database files for
this symptom.

After updating Conductor, deliberately restart each affected Conductor process to
load the new interpreter runner. Existing processes retain the old implementation;
a build or global link alone does not change them. Preserve active session panes
when restarting their supervisor. The tmux backend does not use AppleScript.

## Developer verification

Run `node test/manual/iterm-interpreter.mjs` after building on macOS with iTerm2.
It verifies repeated requests, argument fidelity, interpreter reuse, a read-only
iTerm version query, and recovery from a script compilation error. It never reads
or writes session contents. The automated `osa-worker.test.ts` suite separately
exercises real pipe framing, timeout, exit, output limits, queue bounds, and recovery
using an isolated subprocess that does not require AppleScript permissions.
