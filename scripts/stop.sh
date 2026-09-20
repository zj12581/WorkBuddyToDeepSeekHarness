#!/usr/bin/env bash
#
# Stop the gateway started by scripts/setup.sh.
#
#   bash scripts/stop.sh
#
set -uo pipefail

CONFIG_DIR="${HOME}/.workbuddy-gateway"
PID_FILE="${CONFIG_DIR}/gateway.pid"
PORT="${WORKBUDDY_GATEWAY_PORT:-8790}"

say() { printf '%s\n' "$*"; }

if [ ! -f "$PID_FILE" ]; then
  say "no pid file at $PID_FILE — nothing recorded as running"
else
  PID="$(cat "$PID_FILE" 2>/dev/null || true)"
  if [ -z "${PID:-}" ]; then
    rm -f "$PID_FILE"
    say "empty pid file, removed"
  elif ! kill -0 "$PID" 2>/dev/null; then
    rm -f "$PID_FILE"
    say "pid $PID is not running, removed stale pid file"
  else
    say "stopping pid $PID ..."
    kill "$PID" 2>/dev/null || true
    for _ in $(seq 1 20); do
      kill -0 "$PID" 2>/dev/null || break
      sleep 0.5
    done
    if kill -0 "$PID" 2>/dev/null; then
      say "still alive, sending SIGKILL"
      kill -9 "$PID" 2>/dev/null || true
    fi
    rm -f "$PID_FILE"
    say "stopped"
  fi
fi

# Report anything still holding the port, so a silent leftover is visible.
if command -v ss >/dev/null 2>&1; then
  if ss -ltn 2>/dev/null | grep -q ":${PORT}\b"; then
    say "note: something is still listening on port ${PORT}"
  else
    say "port ${PORT} is free"
  fi
elif command -v lsof >/dev/null 2>&1; then
  if lsof -iTCP:"${PORT}" -sTCP:LISTEN >/dev/null 2>&1; then
    say "note: something is still listening on port ${PORT}"
  else
    say "port ${PORT} is free"
  fi
fi
