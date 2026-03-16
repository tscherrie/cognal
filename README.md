# Cognal

Cognal is a Ubuntu/Debian-only CLI + daemon that bridges Telegram chats to Claude Code or Codex.

Current release line: `v0.3.0`

`v0.3.0` highlights:
- API-key-only setup
- Telegram group mode: `all` or `mentions_only`
- Telegram typing indicator during agent processing
- Attachment size limits with user-facing rejection messages
- Classified retries for Telegram, STT, and transient provider failures
- User-facing diagnostic error IDs for failed agent runs
- `cognal status --json`
- `cognal doctor --verbose`
- `cognal config get/set`

## Key behavior

- Multi-project capable on one server (project-scoped `systemd` service per project).
- Telegram Bot API transport via long polling (no inbound port needed).
- `/claude` and `/codex` switch the active agent per user.
- All other slash commands are passed through unchanged.
- Single-active-agent policy per user (RAM saving).
- Session resume across agent restarts where supported by the installed provider CLI.
- Claude resume is implemented via `--resume`; Codex resume is capability-detected and falls back to fresh `exec` on CLIs without resume support.
- Audio transcription via OpenAI `whisper-1` (auto language).
- Attachments are temporary and cleaned up by TTL.
- Access control: user allow-list (`telegram_user_id`) + group allow-list (`chat_id`).

## Requirements

- Ubuntu/Debian with `systemd`
- Node.js 20+
- Telegram bot token from [@BotFather](https://t.me/BotFather)
- `claude` CLI and/or `codex` CLI (selected in setup)

## Install

```bash
npm install
npm run build
npm link
```

One-liner install (clone + build + link + setup):

```bash
curl -fsSL https://raw.githubusercontent.com/tscherrie/cognal/main/scripts/install.sh | sh
```

By default this installs Cognal source into `~/.local/share/cognal` and runs `setup` for your current directory as project root.

Optional flags via `sh -s -- ...`:

```bash
curl -fsSL https://raw.githubusercontent.com/tscherrie/cognal/main/scripts/install.sh | sh -s -- --project-dir /srv/myproj --providers codex --distro ubuntu
```

Skip onboarding prompts:

```bash
curl -fsSL https://raw.githubusercontent.com/tscherrie/cognal/main/scripts/install.sh | sh -s -- --skip-onboarding
```

## Setup

```bash
cognal setup --distro ubuntu
```

`cognal setup` does:

1. Select providers: `claude`, `codex`, `both`.
2. Ask for Telegram bot token and validate via `getMe`.
3. Ask whether group/supergroup chats are enabled and which group mode to use.
4. Optional onboarding: initial user IDs and group chat IDs.
5. Install missing provider CLIs automatically (`npm i -g ...`).
6. Configure API keys for Claude and Codex.
7. Create `./.cognal/config.toml`, SQLite state, and install/start project-scoped `systemd` service.
8. Create or update project-root `AGENTS.md` and `CLAUDE.md` with Cognal's default live-verification rule.

During interactive setup, if no Telegram token is configured yet, Cognal prints a BotFather step-by-step guide in the terminal before asking for the token.

BotFather quick path:

1. Open Telegram chat with [@BotFather](https://t.me/BotFather)
2. `/start`
3. `/newbot`
4. Set bot name + unique username ending in `bot`
5. Copy token (`123456789:AA...`) and paste into setup prompt

During onboarding, Cognal also prints how to find Telegram user IDs:

1. Open [@userinfobot](https://t.me/userinfobot)
2. Send `/start`
3. Copy numeric `Id` (example: `123456789`)
4. Paste IDs into setup prompt (comma-separated)
5. Or skip now: let users message the bot once, then run `cognal user requests` and `cognal user approve --telegram-user-id <id>`

Setup options:

```bash
cognal setup --providers claude
cognal setup --providers codex
cognal setup --providers both
cognal setup --skip-provider-install
```

## Core commands

```bash
cognal setup
cognal start
cognal stop
cognal restart
cognal status
cognal status --json
cognal logs --follow
cognal doctor
cognal doctor --verbose
cognal update
cognal uninstall

cognal config get telegram.groupMode
cognal config set telegram.groupMode mentions_only

cognal user add --telegram-user-id 123456789
cognal user list
cognal user revoke --telegram-user-id 123456789
cognal user requests
cognal user approve --telegram-user-id 123456789

cognal chat allow --chat-id -1001234567890 --type supergroup
cognal chat list
cognal chat revoke --chat-id -1001234567890
```

## How to chat with Cognal

1. Message the configured bot in Telegram.
2. If your user ID is not approved, Cognal replies with your Telegram user ID.
3. Host admin runs `cognal user approve --telegram-user-id <id>`.
4. For group use, admin also runs `cognal chat allow --chat-id <id>`.
5. In private chats all messages are processed. In groups, behavior depends on `telegram.groupMode`:
   - `all`: every message in an allowed group is processed
   - `mentions_only`: only commands, mentions, and replies to the bot are processed

## Multi-project usage

Each project gets its own service, e.g. `cognald-myproj-a1b2c3d4`.

```bash
cognal -p /srv/project-a setup
cognal -p /srv/project-b setup
cognal -p /srv/project-a status
cognal -p /srv/project-b logs --follow
```

## Uninstall

Interactive uninstall:

```bash
cognal uninstall
```

Non-interactive full wipe:

```bash
cognal uninstall --all
```

Remove only Telegram token + access allow-lists while keeping workspace files:

```bash
cognal uninstall --yes --remove-telegram-state
```

## Config

Main config path: `./.cognal/config.toml`

Important fields:

- `telegram.botTokenEnv` (default `TELEGRAM_BOT_TOKEN`)
- `telegram.botUsername`
- `telegram.receiveTimeoutSec`
- `telegram.allowGroups`
- `telegram.groupMode`
- `runtime.serviceName` (project-scoped unit)
- `agents.enabled` (`claude`, `codex` booleans)
- `agents.claude.command`, `agents.codex.command`
- `routing.failoverEnabled`
- `routing.responseChunkSize`
- `stt.apiKeyEnv` (default `OPENAI_API_KEY`)
- `retention.attachmentsHours`
- `retention.maxAudioBytes`
- `retention.maxImageBytes`
- `retention.maxDocumentBytes`

Daemon env path: `./.cognal/cognald.env`

## Testing

```bash
npm test
```

## Notes

- `cognal update` tracks latest versions by design.
- `cognal doctor` validates Telegram token health and also runs provider smoke checks for enabled Claude/Codex CLIs.
- `cognal doctor --verbose` prints full failure details.
- If provider resume fails after updates, Cognal retries with a fresh session.
- Failed user-visible agent runs return a short `Error ID` that can be correlated with daemon logs.
- Codex session continuation depends on the installed Codex CLI version. Cognal probes support and degrades safely when resume is unavailable.

## Troubleshooting

- `Telegram API getUpdates failed (409)` usually means a second poller is running with the same bot token. Stop the duplicate `cognald` instance and restart the intended project service.
- `TypeError: fetch failed` in daemon logs is typically a transient network failure. Cognal now backs off automatically up to 30 seconds instead of tight-looping.
- Telegram API rate limits and transient file-download failures are retried automatically with backoff.
- STT and clearly transient provider failures are retried conservatively before Cognal returns an error to the user.
- `provider:claude` or `provider:codex` failing in `cognal doctor` means the binary exists but cannot complete a real prompt. Re-run `cognal setup` or verify API credentials in `./.cognal/cognald.env`.
- If Codex works in a shell but not in Cognal, run `cognal setup` again so Cognal can refresh `codex login --with-api-key` state.
