# Cognal

Cognal is a Ubuntu/Debian-only CLI + daemon that bridges Signal messages to Claude Code or Codex.

## Key behavior

- Multi-user whitelist (phone).
- Multi-project capable on one server (project-scoped service name).
- Signal onboarding via device-linking QR.
- `/claude` and `/codex` switch active agent per user.
- All other slash commands are passed through unchanged.
- Single-active-agent policy per user (RAM saving).
- Audio transcription via OpenAI `whisper-1` (auto language).
- Attachments are temporary and cleaned up by TTL.
- Default QR delivery is `public_encrypted` (public upload + separate password).

## Requirements

- Ubuntu/Debian with `systemd`
- Node.js 20+
- `signal-cli`
- `claude` CLI and/or `codex` CLI (selected in setup)
- Optional: Override public dump endpoint via `COGNAL_PUBLIC_DUMP_ENDPOINT`

## Install

```bash
npm install
npm run build
npm link
```

One-liner install (clone + build + link + setup):

```bash
curl -fsSL https://raw.githubusercontent.com/tscherrie/cognal/refs/heads/main/scripts/install.sh | sh
```

On Ubuntu/Debian, the installer also auto-installs missing `java` and `signal-cli` from the latest GitHub release (requires `sudo`).

By default this installs Cognal source into `~/.local/share/cognal` and runs `setup` for your **current directory** as project root.

You can pass options via `sh -s -- ...`:

```bash
curl -fsSL https://raw.githubusercontent.com/tscherrie/cognal/refs/heads/main/scripts/install.sh | sh -s -- --project-dir /srv/myproj --providers codex --distro ubuntu
```

Skip auto-install of Java/signal-cli prerequisites:

```bash
curl -fsSL https://raw.githubusercontent.com/tscherrie/cognal/refs/heads/main/scripts/install.sh | sh -s -- --skip-prereqs
```

Skip onboarding prompts:

```bash
curl -fsSL https://raw.githubusercontent.com/tscherrie/cognal/refs/heads/main/scripts/install.sh | sh -s -- --skip-onboarding
```

## Setup

```bash
cognal setup --run-provider-setup --distro ubuntu
```

`cognal setup` interactively asks which providers should be enabled: `claude`, `codex`, or `both`.
You can also force this non-interactively:

```bash
cognal setup --providers claude
cognal setup --providers codex
cognal setup --providers both
```

This creates `./.cognal/config.toml`, SQLite state, and installs/starts a project-scoped systemd service.

During setup, Cognal can also interactively add initial allowed Signal users (phone only).
When generating a link QR, keep the command running until Signal confirms device-link completion.

Each project gets its own systemd unit name, e.g. `cognald-myproj-a1b2c3d4`.
Use `-p` to target another project root:

```bash
cognal -p /srv/project-a setup
cognal -p /srv/project-b setup
cognal -p /srv/project-a status
cognal -p /srv/project-b logs --follow
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

cognal user add --phone +15551234567
cognal user list
cognal user revoke --phone +15551234567
cognal user relink --phone +15551234567
```

## Uninstall

Interactive uninstall:

```bash
cognal uninstall
```

It asks whether to:

- remove the project service (`systemd`)
- remove project workspace state (`./.cognal`)
- remove global CLI link (`npm unlink -g cognal`)

Non-interactive:

```bash
cognal uninstall --yes --remove-workspace --remove-global
```

## Public encrypted QR mode

`public_encrypted` creates an encrypted HTML bundle that contains the QR image ciphertext. The file is uploaded to a public dump host (default `https://litterbox.catbox.moe/resources/internals/api.php`), and Cognal prints:

- public URL
- one-time password

Share URL and password separately.

## Daemon run (manual)

```bash
COGNAL_PROJECT_ROOT=/path/to/project node dist/daemon.js
```

## Config

Main config path: `./.cognal/config.toml`

Important fields:

- `signal.command`, `signal.dataDir`
- `runtime.serviceName` (project-scoped unit)
- `agents.enabled` (`claude`, `codex` booleans)
- `agents.claude.command`, `agents.codex.command`
- `routing.failoverEnabled`
- `stt.apiKeyEnv` (default `OPENAI_API_KEY`)
- `delivery.modeDefault` (`public_encrypted`)
- `delivery.publicDump.endpoint` (default `https://litterbox.catbox.moe/resources/internals/api.php`)
- `delivery.publicDump.fileField` (default `fileToUpload`)
- `delivery.publicDump.extraFields.reqtype` (default `fileupload`)
- `delivery.publicDump.extraFields.time` (default `24h`)
- `retention.attachmentsHours`

## Testing

```bash
npm test
```

## Notes

- `cognal update` tracks latest versions by design.
- If provider resume fails after updates, Cognal retries with a fresh session and sends a failover marker.
