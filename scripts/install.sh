#!/usr/bin/env sh
set -eu

REPO="${COGNAL_REPO:-tscherrie/cognal}"
REF="${COGNAL_REF:-main}"
INSTALL_DIR="${COGNAL_INSTALL_DIR:-$HOME/cognal}"
RUN_SETUP=1
SETUP_PROVIDERS="${COGNAL_SETUP_PROVIDERS:-}"
SETUP_DISTRO="${COGNAL_SETUP_DISTRO:-}"

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
    --providers)
      SETUP_PROVIDERS="$2"
      shift 2
      ;;
    --distro)
      SETUP_DISTRO="$2"
      shift 2
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

REPO_URL="https://github.com/${REPO}.git"

echo "Installing Cognal from ${REPO_URL} (ref: ${REF}) into ${INSTALL_DIR}"

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
  SETUP_CMD="node dist/cli.js setup"
  if [ -n "$SETUP_PROVIDERS" ]; then
    SETUP_CMD="$SETUP_CMD --providers $SETUP_PROVIDERS"
  fi
  if [ -n "$SETUP_DISTRO" ]; then
    SETUP_CMD="$SETUP_CMD --distro $SETUP_DISTRO"
  fi

  echo "Running initial setup..."
  echo "Command: $SETUP_CMD"
  sh -c "$SETUP_CMD"
fi
