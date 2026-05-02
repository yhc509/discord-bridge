#!/bin/bash
# Runs inside the tmux session. Keeps the node bot alive: restarts on crash
# after a short backoff. Attach to this session to see live bot output:
#   tmux -L discord-bridge attach -t discord-bridge

set -u

SCRIPT_DIR="$(CDPATH= cd -- "$(dirname "$0")" && pwd)"
REPO_ROOT="$(CDPATH= cd -- "$SCRIPT_DIR/.." && pwd)"
BOT_JS="$REPO_ROOT/dist/bot.js"
BOT_CWD="$REPO_ROOT"
LOG_DIR="$HOME/Library/Logs/discord-bridge"
BOT_LOG="$LOG_DIR/bot.log"

mkdir -p "$LOG_DIR"
cd "$BOT_CWD" || exit 1

find_bin() {
  for candidate in "$@"; do
    if [ -n "$candidate" ] && [ -x "$candidate" ]; then
      printf '%s\n' "$candidate"
      return 0
    fi
  done

  return 1
}

export PATH="$SCRIPT_DIR:$HOME/.local/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin"
NODE_BIN="$(find_bin "$(command -v node 2>/dev/null || true)" /opt/homebrew/bin/node /usr/local/bin/node)" || {
  echo "[$(date '+%F %T')] node binary not found" | tee -a "$BOT_LOG"
  exit 1
}

while true; do
  echo "[$(date '+%F %T')] starting node bot" | tee -a "$BOT_LOG"
  "$NODE_BIN" "$BOT_JS" 2>&1 | tee -a "$BOT_LOG"
  status=${PIPESTATUS[0]}
  echo "[$(date '+%F %T')] node exited (status=$status); restarting in 5s" | tee -a "$BOT_LOG"
  sleep 5
done
