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
SKIP_PREREQS="${COGNAL_INSTALL_SKIP_PREREQS:-0}"

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
    --skip-prereqs)
      SKIP_PREREQS=1
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

run_privileged() {
  if [ "$(id -u)" -eq 0 ]; then
    "$@"
    return
  fi
  if ! command -v sudo >/dev/null 2>&1; then
    echo "Missing required command for privileged install steps: sudo" >&2
    exit 1
  fi
  sudo "$@"
}

install_signal_cli_from_release() {
  if command -v signal-cli >/dev/null 2>&1; then
    return
  fi

  echo "Installing signal-cli (latest release)..."
  VERSION="$(curl -Ls -o /dev/null -w '%{url_effective}' https://github.com/AsamK/signal-cli/releases/latest | sed -e 's|^.*/v||')"
  if [ -z "$VERSION" ]; then
    echo "Failed to resolve latest signal-cli version." >&2
    exit 1
  fi

  TMP_DIR="$(mktemp -d)"
  ARCHIVE_PATH="$TMP_DIR/signal-cli-$VERSION.tar.gz"
  curl -L --fail --show-error "https://github.com/AsamK/signal-cli/releases/download/v$VERSION/signal-cli-$VERSION.tar.gz" -o "$ARCHIVE_PATH"
  run_privileged tar xf "$ARCHIVE_PATH" -C /opt
  run_privileged ln -sfn "/opt/signal-cli-$VERSION/bin/signal-cli" /usr/local/bin/signal-cli
  rm -rf "$TMP_DIR"
}

install_linux_prereqs() {
  if [ "$SKIP_PREREQS" -eq 1 ]; then
    echo "Skipping Java/signal-cli prerequisite installation (--skip-prereqs)."
    return
  fi

  if [ ! -r /etc/os-release ]; then
    echo "Could not detect Linux distro (/etc/os-release missing). Skipping automatic prerequisites."
    return
  fi

  DISTRO_ID="$(. /etc/os-release; printf '%s' "${ID:-unknown}")"
  if [ "$DISTRO_ID" != "ubuntu" ] && [ "$DISTRO_ID" != "debian" ]; then
    echo "Automatic prerequisite installation is supported on Ubuntu/Debian only. Detected: $DISTRO_ID"
    return
  fi

  NEED_APT=0
  if ! command -v java >/dev/null 2>&1; then
    NEED_APT=1
  fi
  if ! command -v curl >/dev/null 2>&1; then
    NEED_APT=1
  fi
  if [ "$NEED_APT" -eq 1 ]; then
    echo "Installing Java/curl prerequisites (sudo required)..."
    run_privileged apt-get update
    if ! run_privileged apt-get install -y ca-certificates curl openjdk-21-jre-headless; then
      run_privileged apt-get install -y ca-certificates curl openjdk-17-jre-headless
    fi
  fi

  install_signal_cli_from_release

  if ! command -v signal-cli >/dev/null 2>&1; then
    echo "signal-cli installation failed. Please install manually." >&2
    exit 1
  fi
}

if [ ! -d "$PROJECT_DIR" ]; then
  echo "Project directory does not exist: $PROJECT_DIR" >&2
  exit 1
fi

PROJECT_DIR=$(cd "$PROJECT_DIR" && pwd)
mkdir -p "$(dirname "$INSTALL_DIR")"

REPO_URL="https://github.com/${REPO}.git"

install_linux_prereqs

echo "Installing Cognal from ${REPO_URL} (ref: ${REF}) into ${INSTALL_DIR}"
echo "Target project: ${PROJECT_DIR}"

if [ -d "${INSTALL_DIR}/.git" ]; then
  git -C "${INSTALL_DIR}" fetch --all --tags
  git -C "${INSTALL_DIR}" checkout "${REF}"
  git -C "${INSTALL_DIR}" pull --ff-only origin "${REF}" || true
else
  rm -rf "${INSTALL_DIR}"
  git clone --branch "${REF}" "${REPO_URL}" "${INSTALL_DIR}"
fi

cd "${INSTALL_DIR}"

npm install
npm run build
npm link

echo "Cognal installed."

if [ "$RUN_SETUP" -eq 1 ]; then
  SETUP_CMD="node dist/cli.js -p '${PROJECT_DIR}' setup"
  if [ -n "$SETUP_PROVIDERS" ]; then
    SETUP_CMD="$SETUP_CMD --providers $SETUP_PROVIDERS"
  fi
  if [ -n "$SETUP_DISTRO" ]; then
    SETUP_CMD="$SETUP_CMD --distro $SETUP_DISTRO"
  fi
  if [ "$SKIP_ONBOARDING" -eq 1 ]; then
    SETUP_CMD="$SETUP_CMD --skip-onboarding"
  fi

  echo "Running initial setup..."
  echo "Command: $SETUP_CMD"
  if [ -r /dev/tty ]; then
    sh -c "$SETUP_CMD" </dev/tty >/dev/tty 2>/dev/tty
  else
    sh -c "$SETUP_CMD"
  fi
fi
