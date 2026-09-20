#!/usr/bin/env bash
#
# Stop the workbuddy-gateway instance started by wsl/start-gateway.sh.
# Only touches the in-WSL instance; the Windows gateway is never affected.
#
set -uo pipefail

STATE_DIR="${HOME}/.workbuddy-gateway-wsl"
PID_FILE="${STATE_DIR}/gateway.pid"
PORT="${WORKBUDDY_WSL_PORT:-8791}"

say() { printf '[workbuddy-wsl] %s\n' "$*"; }

if [ ! -f "$PID_FILE" ]; then
  say "no pid file — nothing to stop"
  exit 0
fi

PID="$(cat "$PID_FILE" 2>/dev/null || true)"
if [ -z "${PID:-}" ]; then
  rm -f "$PID_FILE"
  say "empty pid file, removed"
  exit 0
fi

if ! kill -0 "$PID" 2>/dev/null; then
  rm -f "$PID_FILE"
  say "pid ${PID} is not running, removed stale pid file"
  exit 0
fi

say "stopping pid ${PID} ..."
kill "$PID" 2>/dev/null || true

for i in $(seq 1 10); do
  sleep 1
  if ! kill -0 "$PID" 2>/dev/null; then
    rm -f "$PID_FILE"
    say "stopped"
    exit 0
  fi
done

say "still alive after 10s, sending SIGKILL"
kill -9 "$PID" 2>/dev/null || true
rm -f "$PID_FILE"
say "stopped (forced)"
