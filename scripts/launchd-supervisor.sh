#!/bin/bash
# LaunchAgent one-shot: ensures a tmux-owned discord-bridge session is running.
# The LaunchAgent fires this at login and periodically via StartInterval; the
# script exits immediately after verifying/starting tmux. The bot itself runs
# inside tmux via scripts/run-bot-loop.sh, so it is detached from launchd and
# immune to macOS's "inherently inefficient" LaunchAgent killer.
#
# Attach for debugging: tmux -L discord-bridge attach -t discord-bridge
# Stop the bot:         tmux -L discord-bridge kill-session -t discord-bridge

set -u

SCRIPT_DIR="$(CDPATH= cd -- "$(dirname "$0")" && pwd)"
REPO_ROOT="$(CDPATH= cd -- "$SCRIPT_DIR/.." && pwd)"
SESSION="discord-bridge"
LOG_DIR="$HOME/Library/Logs/discord-bridge"
SUPERVISOR_LOG="$LOG_DIR/supervisor.log"
FORCE_RESTART_FLAG="/tmp/discord-bridge.force-restart"
LOCK_FILE="$HOME/Library/Application Support/discord-bridge/bot.pid"
INNER_SCRIPT="$SCRIPT_DIR/run-bot-loop.sh"

mkdir -p "$LOG_DIR"

ts() { date '+%Y-%m-%d %H:%M:%S'; }

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
TMUX_BIN="$(find_bin "$(command -v tmux 2>/dev/null || true)" /opt/homebrew/bin/tmux /usr/local/bin/tmux)" || {
  echo "[$(ts)] tmux binary not found"
  exit 1
}

is_bridge_process() {
  pid="$1"
  cmd="$(ps -p "$pid" -o command= 2>/dev/null || true)"

  case "$cmd" in
    *"$REPO_ROOT/dist/bot.js"*|*"$REPO_ROOT/src/bot.ts"*)
      return 0
      ;;
    *)
      return 1
      ;;
  esac
}

bridge_process_pids() {
  ps ax -o pid= -o command= | while read -r pid cmd; do
    case "$cmd" in
      *"$REPO_ROOT/dist/bot.js"*|*"$REPO_ROOT/src/bot.ts"*)
        printf '%s\n' "$pid"
        ;;
    esac
  done
}

bridge_process_count() {
  set -- $(bridge_process_pids)
  printf '%s\n' "$#"
}

stop_bridge_processes() {
  pids="$(bridge_process_pids | tr '\n' ' ')"
  if [ -z "$pids" ]; then
    rm -f "$LOCK_FILE"
    return 0
  fi

  for pid in $pids; do
    echo "[$(ts)] stopping existing bot pid $pid"
    kill "$pid" 2>/dev/null || true
  done

  for _ in 1 2 3 4 5 6 7 8 9 10; do
    remaining="$(bridge_process_pids | tr '\n' ' ')"
    if [ -z "$remaining" ]; then
      rm -f "$LOCK_FILE"
      sleep 2
      return 0
    fi
    sleep 1
  done

  remaining="$(bridge_process_pids | tr '\n' ' ')"
  for pid in $remaining; do
    echo "[$(ts)] bot pid $pid still alive; sending SIGKILL"
    kill -9 "$pid" 2>/dev/null || true
  done

  sleep 1
  remaining="$(bridge_process_pids | tr '\n' ' ')"
  if [ -n "$remaining" ]; then
    echo "[$(ts)] bot pids survived shutdown: $remaining"
    return 1
  fi

  rm -f "$LOCK_FILE"
  sleep 2
  return 0
}

cleanup_lock_holder() {
  if [ ! -f "$LOCK_FILE" ]; then
    return 0
  fi

  lock_pid=$(cat "$LOCK_FILE" 2>/dev/null || true)
  if ! [[ "$lock_pid" =~ ^[0-9]+$ ]]; then
    rm -f "$LOCK_FILE"
    return 0
  fi

  if ! kill -0 "$lock_pid" 2>/dev/null; then
    rm -f "$LOCK_FILE"
    return 0
  fi

  if ! is_bridge_process "$lock_pid"; then
    echo "[$(ts)] lock pid $lock_pid is alive but does not look like discord-bridge; removing stale lock only"
    rm -f "$LOCK_FILE"
    return 0
  fi

  echo "[$(ts)] stopping existing bot pid $lock_pid from lock file"
  kill "$lock_pid" 2>/dev/null || true

  for _ in 1 2 3 4 5; do
    if ! kill -0 "$lock_pid" 2>/dev/null; then
      break
    fi
    sleep 1
  done

  if kill -0 "$lock_pid" 2>/dev/null; then
    echo "[$(ts)] bot pid $lock_pid still alive; sending SIGKILL"
    kill -9 "$lock_pid" 2>/dev/null || true
    sleep 1
  fi

  if kill -0 "$lock_pid" 2>/dev/null; then
    echo "[$(ts)] bot pid $lock_pid survived shutdown; keeping lock file and aborting restart"
    return 1
  fi

  rm -f "$LOCK_FILE"
  return 0
}

force_restart=0
if [ -f "$FORCE_RESTART_FLAG" ]; then
  force_restart=1
  rm -f "$FORCE_RESTART_FLAG"
fi

{
  if "$TMUX_BIN" -L "$SESSION" has-session -t "$SESSION" 2>/dev/null; then
    if [ "$force_restart" -eq 1 ]; then
      echo "[$(ts)] force restart requested; recycling tmux session '$SESSION'"
      "$TMUX_BIN" -L "$SESSION" kill-session -t "$SESSION" 2>/dev/null
      cleanup_lock_holder || exit 1
      stop_bridge_processes || exit 1
    else
      pane_pid=$("$TMUX_BIN" -L "$SESSION" list-panes -t "$SESSION" -F '#{pane_pid}' 2>/dev/null | head -n 1)
      bot_count="$(bridge_process_count)"
      if [ -n "$pane_pid" ] && ps -p "$pane_pid" >/dev/null 2>&1 && [ "$bot_count" -eq 1 ]; then
        echo "[$(ts)] tmux session '$SESSION' already alive"
        exit 0
      fi

      echo "[$(ts)] session unhealthy (pane_pid=${pane_pid:-none}, bot_count=$bot_count); recycling"
      "$TMUX_BIN" -L "$SESSION" kill-session -t "$SESSION" 2>/dev/null
      stop_bridge_processes || exit 1
    fi
  elif [ "$force_restart" -eq 1 ]; then
    echo "[$(ts)] force restart requested; no existing tmux session"
    cleanup_lock_holder || exit 1
    stop_bridge_processes || exit 1
  else
    bot_count="$(bridge_process_count)"
    if [ "$bot_count" -gt 0 ]; then
      echo "[$(ts)] found $bot_count bot process(es) without tmux session; recycling"
      stop_bridge_processes || exit 1
    fi
  fi

  echo "[$(ts)] starting tmux session '$SESSION'"

  "$TMUX_BIN" -L "$SESSION" new-session -d -s "$SESSION" "$INNER_SCRIPT"
  echo "[$(ts)] tmux new-session exit=$?"
  exit 0
} >>"$SUPERVISOR_LOG" 2>&1
