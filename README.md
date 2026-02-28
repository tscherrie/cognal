# Cognal

Cognal is a Ubuntu/Debian-only CLI + daemon that bridges Signal messages to Claude Code or Codex.

## Key behavior

- Multi-user whitelist (phone + email).
- Signal onboarding via device-linking QR.
- `/claude` and `/codex` switch active agent per user.
- All other slash commands are passed through unchanged.
- Single-active-agent policy per user (RAM saving).
- Audio transcription via OpenAI `whisper-1` (auto language).
- Attachments are temporary and cleaned up by TTL.

## Requirements

- Ubuntu/Debian with `systemd`
- Node.js 20+
- `signal-cli`
- `claude` CLI
- `codex` CLI
- Optional: Resend API key for QR via email
- Optional: S3-compatible bucket for presigned QR links

## Install

```bash
npm install
npm run build
npm link
```

## Setup

```bash
cognal setup --run-provider-setup --distro ubuntu
```

This creates `./.cognal/config.toml`, SQLite state, and attempts to install/start `cognald.service`.

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

cognal user add --phone +15551234567 --email user@example.com --deliver email
cognal user list
cognal user revoke --phone +15551234567
cognal user relink --phone +15551234567 --deliver link
```

## Daemon run (manual)

```bash
COGNAL_PROJECT_ROOT=/path/to/project node dist/daemon.js
```

## Config

Main config path: `./.cognal/config.toml`

Important fields:

- `signal.command`, `signal.dataDir`
- `agents.claude.command`, `agents.codex.command`
- `routing.failoverEnabled`
- `stt.apiKeyEnv` (default `OPENAI_API_KEY`)
- `delivery.modeDefault` (`email` or `link`)
- `retention.attachmentsHours`

## Testing

```bash
npm test
```

## Notes

- `cognal update` tracks latest versions by design.
- If provider resume fails after updates, Cognal retries with a fresh session and sends a failover marker.
