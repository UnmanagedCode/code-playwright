#!/usr/bin/env bash
# Self-installer for code-playwright. Invoked as `bash install.sh` — cwd is
# irrelevant, it derives its own directory from $0. Safe to re-run: this is
# used as both a post-clone AND post-pull hook by the Code Conductor Plugin
# Library, so every step below must no-op or upgrade in place when the repo
# is already set up.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")" && pwd)"
cd "$SCRIPT_DIR"

log() { echo "[install] $*"; }
fail() { echo "[install] ERROR: $*" >&2; exit 1; }

command -v node >/dev/null 2>&1 || fail "node not found on PATH — install Node 22+ first."
command -v npm  >/dev/null 2>&1 || fail "npm not found on PATH."

log "Installing npm dependencies..."
npm install --no-audit --no-fund || fail "npm install failed — see errors above."

IS_TERMUX=0
if [ -n "${PREFIX:-}" ] && [[ "$PREFIX" == *com.termux* ]]; then
  IS_TERMUX=1
fi

if [ "$IS_TERMUX" = "1" ]; then
  log "Termux detected — ensuring system chromium package is installed..."
  if ! command -v chromium-browser >/dev/null 2>&1; then
    if ! dpkg -s x11-repo >/dev/null 2>&1; then
      log "Enabling x11-repo..."
      pkg install -y x11-repo </dev/null
      pkg update -y </dev/null 2>&1 || true
    fi
    log "Installing chromium via pkg..."
    pkg install -y chromium </dev/null
  else
    log "chromium-browser already installed — skipping."
  fi
else
  log "Non-Termux Linux detected — ensuring a Playwright-managed Chromium is downloaded..."
  PW_CLI="$SCRIPT_DIR/node_modules/.bin/playwright-core"
  [ -x "$PW_CLI" ] || fail "playwright-core CLI not found at $PW_CLI after npm install — check package.json."

  "$PW_CLI" install chromium || fail "playwright-core install chromium failed — check your network connection and rerun bash install.sh."

  if [ "$(id -u)" = "0" ]; then
    log "Running as root — attempting install-deps for chromium..."
    "$PW_CLI" install-deps chromium || log "install-deps failed (non-fatal) — you may need to install system libs manually."
  else
    log "Not running as root — skipping install-deps. If chromium fails to launch due to missing shared libs, run: sudo \"$PW_CLI\" install-deps chromium"
  fi
fi

log "Done."
