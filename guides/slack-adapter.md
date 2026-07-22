# Connect Agent Conductor to Slack

> Availability: this guide is the setup contract for the planned built-in Slack adapter. The adapter is
> not present in the current release yet; until its implementation lands, `channels.slack` is not a valid
> configuration key.

The Slack adapter gives one authorized operator a private App Home conversation with a Conductor fleet.
It supports the same operator commands as the local console and Telegram, ordinary conversation with the
active `/talk` session, Conductor notifications, and buttons for `send_to_operator` choices. It does not
register a Slack slash command or post in channels.

It uses [Slack Socket Mode](https://docs.slack.dev/apis/events-api/using-socket-mode/). The Conductor makes
an outbound WebSocket connection to Slack; you do not need a public server, tunnel, webhook URL, signing
secret, or firewall change.

## Before you begin

You need:

- Permission to create and install a custom app in the target Slack workspace. A work workspace may
  require a Workspace Owner or app manager to approve it. Slack's [app approval
  guide](https://slack.com/help/articles/222386767-Manage-app-approval-for-your-workspace-Manage-app-installation-settings-for-your-workspace)
  explains that process.
- The Slack member ID of the one operator who may control this fleet.
- A separate Slack app for each Conductor fleet that will run concurrently.
- A fleet-local `.conductor/.env` file or another secure environment-secret mechanism.

The app sends Conductor messages and agent output through Slack. Slack stores that content according to
your workspace's retention, export, security, and administrative policies. Do not enable this adapter for
work whose content is not permitted in that workspace.

## 1. Understand the private-app boundary

You interact with Conductor only through **Apps > Agent Conductor > Messages**. The app does not register
a workspace-wide slash command, listen in channels, or post outside its private App Home conversation.
Prefix Conductor commands with `!` inside that conversation—for example, `!status`, `!talk alpha`, and
`!help`. Ordinary text goes to the active talk session.

Other workspace members may still be able to find or open an installed app depending on workspace policy,
but Conductor silently ignores every inbound message whose authenticated Slack user, workspace, and DM do
not match the configured operator. It reveals no fleet information in response.

> **One app per fleet is required.** Do not share a Slack app or app-level token across running fleets.
> Socket Mode may deliver each envelope to any connection for an app, so sharing it would route operator
> actions nondeterministically and without an error.

For a multi-fleet workspace, make `display_information.name` and `bot_user.display_name` identify the
fleet. That makes each private App Home conversation, startup greeting, and notification visibly
attributable.

## 2. Create the Slack app from a manifest

1. Open [Your Apps](https://api.slack.com/apps) and choose **Create New App**.
2. Choose **From an app manifest** and select the work workspace.
3. Paste the YAML below.
4. For multiple fleets, replace the two `Agent Conductor` display names with a fleet-specific name.
5. Review the requested features and scopes, then create the app.

```yaml
_metadata:
  major_version: 1

display_information:
  name: Agent Conductor
  description: Private operator control for one local Agent Conductor fleet

features:
  app_home:
    home_tab_enabled: false
    messages_tab_enabled: true
    messages_tab_read_only_enabled: false
  bot_user:
    display_name: Agent Conductor
    always_online: false

oauth_config:
  scopes:
    bot:
      - chat:write
      - im:history
      - im:write

settings:
  event_subscriptions:
    bot_events:
      - message.im
  interactivity:
    is_enabled: true
  org_deploy_enabled: false
  socket_mode_enabled: true
  token_rotation_enabled: false
  is_hosted: false
```

The manifest deliberately requests only three bot scopes:

| Scope        | Why Conductor needs it                                      |
| ------------ | ----------------------------------------------------------- |
| `chat:write` | Send notifications and command replies in the private DM    |
| `im:history` | Receive `message.im` events from the App Home Messages tab  |
| `im:write`   | Open or resolve the authorized operator's exact App Home DM |

It does not request channel history, public-channel posting, files, profiles, user tokens, or workspace
search. The adapter ignores DMs from every Slack member except the configured operator.

**Keep the App Home Messages tab writable.** Slack may label this setting **Allow users to send Slash
commands and messages from the messages tab** even though this app registers no slash command. In the manifest it is
`messages_tab_read_only_enabled: false`. If this is disabled, the operator cannot type to Conductor.

## 3. Create the app-level Socket Mode token

1. In the app settings, open **Basic Information**.
2. Under **App-Level Tokens**, choose **Generate Token and Scopes**.
3. Name it for the fleet, such as `midgard-conductor`.
4. Add only the `connections:write` scope.
5. Generate and copy the token beginning with `xapp-`.

This is the app-level token used to open Socket Mode. It is different from the bot token created when the
app is installed.

## 4. Install the app and copy the bot token

1. Open **OAuth & Permissions**.
2. Choose **Install to Workspace** (or submit the app for approval if your workspace requires it).
3. Review and approve the three bot scopes.
4. Copy the **Bot User OAuth Token** beginning with `xoxb-`.

If you later change the manifest's scopes, reinstall/re-authorize the app so the installed bot token
receives the updated permissions.

## 5. Copy the authorized operator's member ID

In Slack, open the operator's profile, choose the overflow menu, and select **Copy member ID**. It normally
begins with `U` (for example, `U012ABCDEF`). Use the stable member ID, not a display name, handle, or email
address.

## 6. Configure the Conductor fleet

Enable Slack in the fleet-wide `.conductor/config/supervisor.yaml` (this is not an individual agent's
session file):

```yaml
channels:
  slack:
    enabled: true
```

Put the two tokens and the authorized member ID in the fleet's `.conductor/.env`:

```bash
cp .conductor/env.template .conductor/.env
chmod 600 .conductor/.env
```

```dotenv
CONDUCTOR_SLACK_APP_TOKEN=xapp-replace-me
CONDUCTOR_SLACK_BOT_TOKEN=xoxb-replace-me
CONDUCTOR_SLACK_OPERATOR_USER_ID=U012ABCDEF
```

Never commit `.conductor/.env`, paste either token into a Slack message, add tokens to YAML, or include them in logs,
screenshots, issue reports, or test fixtures. Inherited environment variables may be used instead; they
override fleet `.conductor/.env` values.

Use a dedicated secret manager when running Conductor as a shared production service. Slack's [security
guidance](https://docs.slack.dev/concepts/security/) recommends environment-based development secrets and
a managed secret store for production.

## 7. Start and verify

Restart the fleet:

```bash
conductor start
```

Initial Slack setup is bounded. If Slack or the network is temporarily unreachable, Conductor exits with
guidance to retry instead of hanging indefinitely. `conductor daemon install` already creates a launchd
service with `KeepAlive` on macOS or a systemd user service with `Restart=on-failure` on Linux, so daemon
fleets recover from ordinary boot-time network races. Apply equivalent restart policy if you maintain a
custom service definition.

The configured operator should receive one short startup greeting after the bot token is validated, the
operator DM is resolved, outbound posting is verified, and Socket Mode is connected. The greeting is sent
once per Conductor process start, not after ordinary Socket Mode reconnects.

If the greeting reaches the wrong person, disable Slack immediately and correct
`CONDUCTOR_SLACK_OPERATOR_USER_ID`. If the intended operator receives nothing, inspect startup logs before
trusting the integration with notifications.

In Slack, open **Apps > Agent Conductor > Messages**, then try:

```text
!status
!help
!talk alpha
```

After `!talk alpha`, ordinary text in the App Home conversation goes to `alpha` through Conductor's
protected message queue. The `!` prefix is local to the Slack adapter: it is translated to the existing
Conductor command vocabulary before routing.

Slack intercepts leading `/` input before an unregistered slash command can reach the app. To send a
session-level slash command to the current talk target, use the adapter's `!send` escape:

```text
!send /compact
```

The adapter sends `/compact` verbatim through Conductor's protected message queue; it does not execute it
as a Conductor operator command. To send ordinary text that begins with `!`, double the prefix:

```text
!!important
```

The session receives `!important`.

To test outbound notifications and buttons, ask a managed session to call `send_to_operator` first with
plain text, then with two or three `options`. Confirm that:

- The plain message appears in the App Home DM.
- Each option is a Slack button.
- Selecting a button delivers one signed response to the requesting session.
- A second response from Slack or the local console reports that the request was already answered.

If Telegram is enabled too, both adapters receive operator-bound notifications. Each adapter keeps its
own `/talk` conversation state.

## Security model

- The `xapp-` token authenticates the outbound Socket Mode connection.
- The `xoxb-` token authenticates Web API calls as this app's bot.
- On startup, Conductor uses `auth.test` to derive the workspace and bot IDs and
  `conversations.open` to resolve the configured operator's exact DM.
- Inbound messages and button actions are accepted only when Slack's authenticated payload matches that workspace,
  operator member ID, and DM ID.
- Message text, display names, handles, and emails never establish identity.
- There is no public Conductor endpoint and no Slack signing secret in this mode.

Anyone who obtains either token can use its Slack permissions. Revoke a leaked app-level token in
**Basic Information > App-Level Tokens**, rotate/reinstall the bot token under **OAuth & Permissions**,
update `.conductor/.env`, and restart Conductor. To shut the integration off immediately, set
`channels.slack.enabled: false` and restart; uninstall the Slack app if it is no longer needed.

## Troubleshooting

| Symptom                                               | Check                                                                                                                                                                                                             |
| ----------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Slack config is rejected                              | The Slack adapter has not landed in your installed Agent Conductor version, or `channels.slack` contains a key other than `enabled`.                                                                              |
| Slack package or `undici` cannot be found             | Slack's three runtime packages are optional dependencies installed by default. Reinstall without `--omit=optional`/`--no-optional`; the required set is `@slack/socket-mode`, `@slack/web-api`, and `undici`.     |
| `invalid_auth` or startup authentication failure      | Confirm the `xapp-` value is in `CONDUCTOR_SLACK_APP_TOKEN` and the `xoxb-` value is in `CONDUCTOR_SLACK_BOT_TOKEN`; check for whitespace and revoked tokens.                                                     |
| `missing_scope`                                       | Confirm the three bot scopes in the manifest, then reinstall/re-authorize the app and replace the bot token if Slack issued a new one.                                                                            |
| Socket Mode does not connect at startup               | Confirm Socket Mode and `connections:write`, then check Slack status and proxy/firewall access. Transient startup errors are bounded and should be retried; daemon installs retry through the OS service manager. |
| App Home messages do nothing                          | Confirm the Messages tab is writable, Events are enabled, `message.im` is subscribed, and the member ID matches the sender.                                                                                       |
| Commands reach the wrong fleet intermittently         | The same Slack app/app-level token is connected to multiple Conductors. Create a separate app and tokens for each fleet.                                                                                          |
| Notifications arrive but `!` commands do not          | Confirm the exact authorized member, the writable Messages tab, the `message.im` subscription, and that the command was sent in the app's private Messages tab.                                                   |
| Long replies arrive as several messages               | Expected. Slack messages are split and paced to stay within Block Kit and per-channel API limits.                                                                                                                 |
| A message sent while Conductor was offline is missing | Socket Mode is not a durable offline inbox. Wait until Conductor has connected, then resend the command or DM.                                                                                                    |
| A file or edited message is ignored                   | Expected in the first release. The adapter handles new text messages and its own option buttons only.                                                                                                             |

## Slack references

- [Using Socket Mode](https://docs.slack.dev/apis/events-api/using-socket-mode/)
- [Slack App Home](https://docs.slack.dev/surfaces/app-home/)
- [App manifest reference](https://docs.slack.dev/reference/app-manifest/)
- [`message.im`](https://docs.slack.dev/reference/events/message.im/)
- [`conversations.open`](https://docs.slack.dev/reference/methods/conversations.open/)
- [`chat.postMessage`](https://docs.slack.dev/reference/methods/chat.postmessage)
- [Slack app approval](https://slack.com/help/articles/222386767-Manage-app-approval-for-your-workspace-Manage-app-installation-settings-for-your-workspace)
