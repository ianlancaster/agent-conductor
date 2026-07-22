# Slack adapter manual shakedown

Use a dedicated test app/workspace or an approved internal work app. Complete the tracked
[Slack adapter guide](../../guides/slack-adapter.md) first. Never paste tokens into this file, source,
test output, screenshots, or issue reports.

1. Enable Slack and start Conductor. Confirm startup completes within 45 seconds, exactly one greeting
   appears in the configured operator's App Home DM, and reconnecting the network does not repeat it.
2. Send `!status`, `!help`, `!talk alpha`, ordinary text, `!send /compact`, and `!!literal`. Confirm only
   the intended operation/text reaches Conductor and that the `!talk` target is respected in order.
3. Ask a session to call `send_to_operator` with text and then with options. Confirm buttons work and a
   second answer from Slack or the console reports that the request was already answered.
4. From a different member and from any workspace channel, attempt the same messages. Confirm Conductor
   acknowledges transport envelopes but performs no action and reveals no fleet information.
5. Enable Telegram too. Trigger a notification with a deliberately long Slack response and confirm
   Telegram receives its copy without waiting for Slack's per-message pacing.
6. Sleep and wake the laptop, then send `!status`. Confirm the Socket Mode heartbeat reconnects. Also send
   a DM while Conductor is stopped and record whether the workspace replays it; the adapter does not
   promise an offline Slack inbox, so resend after connection if it is absent.
7. Stop Conductor during an active event, start it again, and confirm there is one listener, one startup
   greeting, and no duplicate handler invocation.
