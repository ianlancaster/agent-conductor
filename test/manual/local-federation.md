# Local federation manual shakedown

Use two disposable fleet directories owned by the same OS user. Do not reuse active work fleets for
failure testing.

1. Configure distinct `federation.name` values, enable `federation.local`, and expose one session in
   each fleet. Start both Conductors and confirm `/peers` shows only the explicitly exposed rosters
   with qualified `session@fleet` addresses.
2. Give both exposed sessions the same codename. Confirm each directory entry remains qualified and
   that a bare codename is rejected by `send_to_peer`.
3. Send in both directions. Confirm each pane receives `[Message from session@fleet]`, replies copy
   that exact address, and `/peer-message-status` advances from `received` to `delivered` only after
   protected pane submission.
4. Stop one exposed session without stopping its Conductor. Send to it and confirm the receipt remains
   `received`, the target remains stopped, and starting it later delivers exactly once.
5. Discover a peer, stop its Conductor, then send another message to the previously discovered address.
   Confirm the origin returns `queued`. Restart the destination fleet and confirm credential rotation
   converges, the same UUID is retried, and the pane receives one copy.
6. Retry the original `send_to_peer` call with the same `idempotencyKey`. Confirm it returns the original
   message UUID and creates no second local message or pane submission.
7. Start another fleet with a duplicate live `federation.name`. Confirm startup fails with the exact
   configuration remedy and does not affect the already-running fleet.
8. Remove both exposure entries without restarting either Conductor. Wait one supervisor heartbeat
   interval for the last-good config watcher, then confirm `/peers` is empty and new sends fail without
   revealing paths, branches, models, effort, tags, pane output, schedules, or health details.
9. Inspect fleet-wide `/status`. Confirm federation health contains counts, ages, contact state, and
   typed errors only—never message text or the registry credential.
