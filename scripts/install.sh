#!/usr/bin/env sh
set -eu

REPO="${COGNAL_REPO:-tscherrie/cognal}"
REF="${COGNAL_REF:-main}"
INSTALL_DIR="${COGNAL_INSTALL_DIR:-$HOME/.local/share/cognal}"
PROJECT_DIR="${COGNAL_PROJECT_DIR:-$PWD}"
RUN_SETUP=1
SETUP_PROVIDERS="${COGNAL_SETUP_PROVIDERS:-}"
SETUP_DISTRO="${COGNAL_SETUP_DISTRO:-}"
SKIP_ONBOARDING="${COGNAL_SETUP_SKIP_ONBOARDING:-0}"
SKIP_PROVIDER_INSTALL="${COGNAL_SETUP_SKIP_PROVIDER_INSTALL:-0}"

while [ "$#" -gt 0 ]; do
  case "$1" in
    --repo)
      REPO="$2"
      shift 2
      ;;
    --ref)
      REF="$2"
      shift 2
      ;;
    --dir)
      INSTALL_DIR="$2"
      shift 2
      ;;
    --project-dir)
      PROJECT_DIR="$2"
      shift 2
      ;;
    --providers)
      SETUP_PROVIDERS="$2"
      shift 2
      ;;
    --distro)
      SETUP_DISTRO="$2"
      shift 2
      ;;
    --skip-onboarding)
      SKIP_ONBOARDING=1
      shift
      ;;
    --skip-provider-install)
      SKIP_PROVIDER_INSTALL=1
      shift
      ;;
    --skip-prereqs)
      echo "--skip-prereqs is deprecated (no system prereq auto-install in Telegram v2). Ignoring."
      shift
      ;;
    --no-setup)
      RUN_SETUP=0
      shift
      ;;
    *)
      echo "Unknown argument: $1" >&2
      exit 1
      ;;
  esac
done

require_cmd() {
  if ! command -v "$1" >/dev/null 2>&1; then
    echo "Missing required command: $1" >&2
    exit 1
  fi
}

require_cmd git
require_cmd node
require_cmd npm

if [ ! -d "$PROJECT_DIR" ]; then
  echo "Project directory does not exist: $PROJECT_DIR" >&2
  exit 1
fi

PROJECT_DIR=$(cd "$PROJECT_DIR" && pwd)
mkdir -p "$(dirname "$INSTALL_DIR")"

REPO_URL="https://github.com/${REPO}.git"

echo "Installing Cognal from ${REPO_URL} (ref: ${REF}) into ${INSTALL_DIR}"
echo "Target project: ${PROJECT_DIR}"

if [ -d "${INSTALL_DIR}/.git" ]; then
  git -C "${INSTALL_DIR}" fetch --all --tags
  git -C "${INSTALL_DIR}" checkout "${REF}"
  if git -C "${INSTALL_DIR}" rev-parse --verify --quiet "refs/remotes/origin/${REF}" >/dev/null; then
    git -C "${INSTALL_DIR}" pull --ff-only origin "${REF}"
  fi
else
  rm -rf "${INSTALL_DIR}"
  git clone "${REPO_URL}" "${INSTALL_DIR}"
  git -C "${INSTALL_DIR}" fetch --all --tags
  git -C "${INSTALL_DIR}" checkout "${REF}"
fi

cd "${INSTALL_DIR}"

if [ -f package-lock.json ]; then
  npm ci
else
  npm install
fi
npm run build
npm link

echo "Cognal installed."

if [ "$RUN_SETUP" -eq 1 ]; then
  echo "Running initial setup..."
  echo "Command: node dist/cli.js -p ${PROJECT_DIR} setup"
  if [ -r /dev/tty ]; then
    if [ -n "$SETUP_PROVIDERS" ] && [ -n "$SETUP_DISTRO" ] && [ "$SKIP_ONBOARDING" -eq 1 ] && [ "$SKIP_PROVIDER_INSTALL" -eq 1 ]; then
      node dist/cli.js -p "$PROJECT_DIR" setup --providers "$SETUP_PROVIDERS" --distro "$SETUP_DISTRO" --skip-onboarding --skip-provider-install </dev/tty >/dev/tty 2>/dev/tty
    elif [ -n "$SETUP_PROVIDERS" ] && [ -n "$SETUP_DISTRO" ] && [ "$SKIP_ONBOARDING" -eq 1 ]; then
      node dist/cli.js -p "$PROJECT_DIR" setup --providers "$SETUP_PROVIDERS" --distro "$SETUP_DISTRO" --skip-onboarding </dev/tty >/dev/tty 2>/dev/tty
    elif [ -n "$SETUP_PROVIDERS" ] && [ -n "$SETUP_DISTRO" ] && [ "$SKIP_PROVIDER_INSTALL" -eq 1 ]; then
      node dist/cli.js -p "$PROJECT_DIR" setup --providers "$SETUP_PROVIDERS" --distro "$SETUP_DISTRO" --skip-provider-install </dev/tty >/dev/tty 2>/dev/tty
    elif [ -n "$SETUP_PROVIDERS" ] && [ "$SKIP_ONBOARDING" -eq 1 ] && [ "$SKIP_PROVIDER_INSTALL" -eq 1 ]; then
      node dist/cli.js -p "$PROJECT_DIR" setup --providers "$SETUP_PROVIDERS" --skip-onboarding --skip-provider-install </dev/tty >/dev/tty 2>/dev/tty
    elif [ -n "$SETUP_DISTRO" ] && [ "$SKIP_ONBOARDING" -eq 1 ] && [ "$SKIP_PROVIDER_INSTALL" -eq 1 ]; then
      node dist/cli.js -p "$PROJECT_DIR" setup --distro "$SETUP_DISTRO" --skip-onboarding --skip-provider-install </dev/tty >/dev/tty 2>/dev/tty
    elif [ -n "$SETUP_PROVIDERS" ] && [ -n "$SETUP_DISTRO" ]; then
      node dist/cli.js -p "$PROJECT_DIR" setup --providers "$SETUP_PROVIDERS" --distro "$SETUP_DISTRO" </dev/tty >/dev/tty 2>/dev/tty
    elif [ -n "$SETUP_PROVIDERS" ] && [ "$SKIP_ONBOARDING" -eq 1 ]; then
      node dist/cli.js -p "$PROJECT_DIR" setup --providers "$SETUP_PROVIDERS" --skip-onboarding </dev/tty >/dev/tty 2>/dev/tty
    elif [ -n "$SETUP_PROVIDERS" ] && [ "$SKIP_PROVIDER_INSTALL" -eq 1 ]; then
      node dist/cli.js -p "$PROJECT_DIR" setup --providers "$SETUP_PROVIDERS" --skip-provider-install </dev/tty >/dev/tty 2>/dev/tty
    elif [ -n "$SETUP_DISTRO" ] && [ "$SKIP_ONBOARDING" -eq 1 ]; then
      node dist/cli.js -p "$PROJECT_DIR" setup --distro "$SETUP_DISTRO" --skip-onboarding </dev/tty >/dev/tty 2>/dev/tty
    elif [ -n "$SETUP_DISTRO" ] && [ "$SKIP_PROVIDER_INSTALL" -eq 1 ]; then
      node dist/cli.js -p "$PROJECT_DIR" setup --distro "$SETUP_DISTRO" --skip-provider-install </dev/tty >/dev/tty 2>/dev/tty
    elif [ "$SKIP_ONBOARDING" -eq 1 ] && [ "$SKIP_PROVIDER_INSTALL" -eq 1 ]; then
      node dist/cli.js -p "$PROJECT_DIR" setup --skip-onboarding --skip-provider-install </dev/tty >/dev/tty 2>/dev/tty
    elif [ -n "$SETUP_PROVIDERS" ]; then
      node dist/cli.js -p "$PROJECT_DIR" setup --providers "$SETUP_PROVIDERS" </dev/tty >/dev/tty 2>/dev/tty
    elif [ -n "$SETUP_DISTRO" ]; then
      node dist/cli.js -p "$PROJECT_DIR" setup --distro "$SETUP_DISTRO" </dev/tty >/dev/tty 2>/dev/tty
    elif [ "$SKIP_ONBOARDING" -eq 1 ]; then
      node dist/cli.js -p "$PROJECT_DIR" setup --skip-onboarding </dev/tty >/dev/tty 2>/dev/tty
    elif [ "$SKIP_PROVIDER_INSTALL" -eq 1 ]; then
      node dist/cli.js -p "$PROJECT_DIR" setup --skip-provider-install </dev/tty >/dev/tty 2>/dev/tty
    else
      node dist/cli.js -p "$PROJECT_DIR" setup </dev/tty >/dev/tty 2>/dev/tty
    fi
  else
    if [ -n "$SETUP_PROVIDERS" ] && [ -n "$SETUP_DISTRO" ] && [ "$SKIP_ONBOARDING" -eq 1 ] && [ "$SKIP_PROVIDER_INSTALL" -eq 1 ]; then
      node dist/cli.js -p "$PROJECT_DIR" setup --providers "$SETUP_PROVIDERS" --distro "$SETUP_DISTRO" --skip-onboarding --skip-provider-install
    elif [ -n "$SETUP_PROVIDERS" ] && [ -n "$SETUP_DISTRO" ] && [ "$SKIP_ONBOARDING" -eq 1 ]; then
      node dist/cli.js -p "$PROJECT_DIR" setup --providers "$SETUP_PROVIDERS" --distro "$SETUP_DISTRO" --skip-onboarding
    elif [ -n "$SETUP_PROVIDERS" ] && [ -n "$SETUP_DISTRO" ] && [ "$SKIP_PROVIDER_INSTALL" -eq 1 ]; then
      node dist/cli.js -p "$PROJECT_DIR" setup --providers "$SETUP_PROVIDERS" --distro "$SETUP_DISTRO" --skip-provider-install
    elif [ -n "$SETUP_PROVIDERS" ] && [ "$SKIP_ONBOARDING" -eq 1 ] && [ "$SKIP_PROVIDER_INSTALL" -eq 1 ]; then
      node dist/cli.js -p "$PROJECT_DIR" setup --providers "$SETUP_PROVIDERS" --skip-onboarding --skip-provider-install
    elif [ -n "$SETUP_DISTRO" ] && [ "$SKIP_ONBOARDING" -eq 1 ] && [ "$SKIP_PROVIDER_INSTALL" -eq 1 ]; then
      node dist/cli.js -p "$PROJECT_DIR" setup --distro "$SETUP_DISTRO" --skip-onboarding --skip-provider-install
    elif [ -n "$SETUP_PROVIDERS" ] && [ -n "$SETUP_DISTRO" ]; then
      node dist/cli.js -p "$PROJECT_DIR" setup --providers "$SETUP_PROVIDERS" --distro "$SETUP_DISTRO"
    elif [ -n "$SETUP_PROVIDERS" ] && [ "$SKIP_ONBOARDING" -eq 1 ]; then
      node dist/cli.js -p "$PROJECT_DIR" setup --providers "$SETUP_PROVIDERS" --skip-onboarding
    elif [ -n "$SETUP_PROVIDERS" ] && [ "$SKIP_PROVIDER_INSTALL" -eq 1 ]; then
      node dist/cli.js -p "$PROJECT_DIR" setup --providers "$SETUP_PROVIDERS" --skip-provider-install
    elif [ -n "$SETUP_DISTRO" ] && [ "$SKIP_ONBOARDING" -eq 1 ]; then
      node dist/cli.js -p "$PROJECT_DIR" setup --distro "$SETUP_DISTRO" --skip-onboarding
    elif [ -n "$SETUP_DISTRO" ] && [ "$SKIP_PROVIDER_INSTALL" -eq 1 ]; then
      node dist/cli.js -p "$PROJECT_DIR" setup --distro "$SETUP_DISTRO" --skip-provider-install
    elif [ "$SKIP_ONBOARDING" -eq 1 ] && [ "$SKIP_PROVIDER_INSTALL" -eq 1 ]; then
      node dist/cli.js -p "$PROJECT_DIR" setup --skip-onboarding --skip-provider-install
    elif [ -n "$SETUP_PROVIDERS" ]; then
      node dist/cli.js -p "$PROJECT_DIR" setup --providers "$SETUP_PROVIDERS"
    elif [ -n "$SETUP_DISTRO" ]; then
      node dist/cli.js -p "$PROJECT_DIR" setup --distro "$SETUP_DISTRO"
    elif [ "$SKIP_ONBOARDING" -eq 1 ]; then
      node dist/cli.js -p "$PROJECT_DIR" setup --skip-onboarding
    elif [ "$SKIP_PROVIDER_INSTALL" -eq 1 ]; then
      node dist/cli.js -p "$PROJECT_DIR" setup --skip-provider-install
    else
      node dist/cli.js -p "$PROJECT_DIR" setup
    fi
  fi
fi
