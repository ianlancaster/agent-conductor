# Telegram manual shakedown

Use a dedicated test bot and private test chat. Never paste credentials into test output,
shell history, committed files, or screenshots.

1. In a temporary fleet, set `channels.telegram.enabled: true`.
2. Run `conductor start` once so the fleet scaffold exists, then fill in the test bot token and operator
   chat ID in the generated owner-only `.conductor/.env`. Do not commit this file.
3. Start the conductor and confirm its startup log validates the bot token before reporting the
   channel connected. With an invalid test token, confirm the startup log explains the Telegram failure while
   the core health endpoint and agent messaging remain online. Restore the valid token, restart, then
   send bare `/start` and confirm it returns fleet status plus command help;
   confirm `/start <session>` retains the lifecycle behavior.
4. Confirm `/status`, free text after `/talk`, and `//compact` route through the same operator
   command behavior as the console.
5. From a managed session, call `send_to_operator` once without options and once with
   `options: ["Staging", "Production", "Cancel"]`.
6. Confirm Telegram shows readable fallback text plus three inline buttons. Select one and
   verify the requesting pane receives a signed `[Message from operator] Response to request`
   message.
7. Try the corresponding `/respond <id> <option>` from the console first, then press a
   Telegram button for the same request. Confirm the later response reports that the request
   was already answered and no second session message is delivered.
8. Stop the conductor during a long poll and confirm shutdown is prompt. Start a second
   poller briefly and confirm the 409 guidance identifies the one-token-per-fleet constraint.
