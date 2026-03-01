# Cognal

Cognal is a Ubuntu/Debian-only CLI + daemon that bridges Telegram chats to Claude Code or Codex.

## Key behavior

- Multi-project capable on one server (project-scoped `systemd` service per project).
- Telegram Bot API transport via long polling (no inbound port needed).
- `/claude` and `/codex` switch the active agent per user.
- All other slash commands are passed through unchanged.
- Single-active-agent policy per user (RAM saving).
- Session resume across agent restarts (`claude --resume/--continue`, `codex resume`).
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
3. Ask whether group/supergroup chats are enabled.
4. Optional onboarding: initial user IDs and group chat IDs.
5. Install missing provider CLIs automatically (`npm i -g ...`).
6. Optional provider auth flow (`api_key` or native `auth_login`).
7. Create `./.cognal/config.toml`, SQLite state, and install/start project-scoped `systemd` service.

Setup options:

```bash
cognal setup --providers claude
cognal setup --providers codex
cognal setup --providers both
cognal setup --run-provider-setup
cognal setup --skip-provider-install
cognal setup --skip-provider-setup
```

## Core commands

```bash
cognal setup
cognal start
cognal stop
cognal restart
cognal status
cognal logs --follow
cognal doctor
cognal update
cognal uninstall

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
5. In private chats all messages are processed. In groups, Cognal processes only:
   - commands,
   - mentions,
   - replies to the bot.

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
- `runtime.serviceName` (project-scoped unit)
- `agents.enabled` (`claude`, `codex` booleans)
- `agents.claude.command`, `agents.codex.command`
- `routing.failoverEnabled`
- `routing.responseChunkSize`
- `stt.apiKeyEnv` (default `OPENAI_API_KEY`)
- `retention.attachmentsHours`

Daemon env path: `./.cognal/cognald.env`

## Testing

```bash
npm test
```

## Notes

- `cognal update` tracks latest versions by design.
- If provider resume fails after updates, Cognal retries with a fresh session and sends a failover marker.
