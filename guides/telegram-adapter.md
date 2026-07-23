# Connect Agent Conductor to Telegram

The bundled Telegram adapter gives one authorized private chat the same command, talk, notification,
and selectable-response surface as the local operator console. It is optional, disabled by default,
and uses outbound Bot API long polling—no public server or webhook is required.

Use one dedicated bot token per concurrently running Conductor fleet. Telegram permits only one
long poller per bot token.

## Before you begin

You need:

- a Telegram account;
- a fleet created by `conductor start`;
- access to the fleet's `.conductor/config/supervisor.yaml` and owner-only `.conductor/.env`;
- the ability to restart that fleet deliberately.

The adapter authorizes one exact numeric chat ID. Use a private one-to-one chat with the bot rather
than a group.

## 1. Create a dedicated bot

1. Open the verified `@BotFather` account in Telegram.
2. Send `/newbot`.
3. Choose a display name and unique username.
4. Copy the bot token. Treat it as a password: anyone holding it controls the bot.
5. Open the new bot's private chat and send a message such as `hello`. Telegram bots cannot initiate
   a conversation with a user, so this first message is required.

Do not reuse this bot for another running fleet or unrelated automation.

## 2. Find the private chat ID

Before starting Conductor's long poller, place the token temporarily in a shell environment and ask
Telegram for pending updates:

```bash
read -rs 'CONDUCTOR_TELEGRAM_TOKEN?Bot token: '
export CONDUCTOR_TELEGRAM_TOKEN
echo
curl -fsS -X POST \
  "https://api.telegram.org/bot${CONDUCTOR_TELEGRAM_TOKEN}/getUpdates"
unset CONDUCTOR_TELEGRAM_TOKEN
```

Find the message you just sent and copy its numeric `message.chat.id`. That is
`CONDUCTOR_TELEGRAM_CHAT_ID`. Keep the private-chat ID even if other updates are present.

If the response is empty, send another message to the bot and retry. If it says that `getUpdates`
cannot be used while a webhook is active, remove the webhook or create a fresh dedicated bot;
Conductor deliberately uses long polling.

## 3. Configure the fleet

Enable Telegram in `.conductor/config/supervisor.yaml`:

```yaml
channels:
  telegram:
    enabled: true
```

Put the credentials in `.conductor/.env`, not YAML:

```dotenv
CONDUCTOR_TELEGRAM_TOKEN=123456:replace-with-real-token
CONDUCTOR_TELEGRAM_CHAT_ID=987654321
```

`conductor start` creates inert stubs when these files are missing. The live `.env` is owner-only
and gitignored. Inherited process variables override fleet-file values; launchd and systemd
normally do not load interactive shell startup files, so the fleet environment is the reliable
daemon fallback.

Validate before restarting:

```bash
conductor -C /path/to/fleet validate
```

Enabling the channel without both nonblank values fails clearly without printing either secret.

## 4. Start and use it

Restart the intended fleet. In the bot's private chat, try:

```text
/help
/status
/talk alpha
Please summarize your current progress.
```

After `/talk alpha`, ordinary text goes to `alpha` until the conversation target changes. To send a
literal slash-leading line to the target session without treating it as an operator command, double
the first slash:

```text
//compact
```

The session receives `/compact`.

Managed agents reach Telegram by calling `send_to_operator`; text printed in an agent's terminal is
not forwarded automatically. When a request contains `options`, Telegram renders inline buttons.
The first response from Telegram, Slack, or a local console wins and returns to the requester as an
ordinary signed operator message.

## Security and lifecycle

- Inbound updates must match the configured chat ID; other chats are ignored.
- The bot token and chat ID are never configuration-YAML values.
- All Bot API calls are outbound HTTPS requests with bounded timeouts.
- Adapter failures are isolated from the canonical command implementation.
- One bot token supports one active long poller. A second fleet using the same token receives a
  Telegram 409 error and logs the one-token-per-fleet remedy.
- Stopping Conductor aborts the active long poll promptly.
- Multiple operator adapters may be enabled together; outbound notifications fan out to each.

If a token is exposed, revoke it through `@BotFather`, write the replacement to the fleet
environment, and restart the fleet.

## Troubleshooting

| Symptom                                      | Check                                                                                                     |
| -------------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| Startup reports missing variables            | Fill both `CONDUCTOR_TELEGRAM_TOKEN` and `CONDUCTOR_TELEGRAM_CHAT_ID`, or disable the channel.            |
| Bot never responds                           | Confirm the user sent the bot a first message, the chat ID is from that private chat, and the fleet runs. |
| Log repeatedly reports Telegram 409          | Another process polls the token. Give every concurrently running fleet its own bot.                       |
| `getUpdates` reports an active webhook       | Remove the webhook or use a fresh dedicated bot; long polling and webhooks cannot run together.           |
| Commands work but ordinary text does not     | Select a target with `/talk <session>` first.                                                             |
| A slash command should go to the agent       | Prefix it with an extra slash, for example `//compact`.                                                   |
| Agent output appears only in its pane        | The agent must call `send_to_operator`; ordinary terminal output is not a channel message.                |
| Daemon works interactively but not at login  | Put credentials in the fleet `.conductor/.env`; service managers usually skip shell startup files.        |
| Buttons say the request was already answered | Another connected operator interface won the first-response race; no duplicate reply is delivered.        |

Run the real-service checklist in `test/manual/telegram.md` after initial setup or material adapter
changes.

## Telegram references

- [Introduction to Telegram bots](https://core.telegram.org/bots)
- [Bot API `getUpdates`](https://core.telegram.org/bots/api#getupdates)
- [BotFather tutorial](https://core.telegram.org/bots/tutorial)
