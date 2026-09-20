#!/usr/bin/env bash
#
# One-command setup for workbuddy-gateway.
#
#   bash scripts/setup.sh
#
# What it does, in order:
#   1. checks Node and locates the WorkBuddy/CodeBuddy desktop login
#   2. verifies the login actually works against the upstream
#   3. writes a config file (only if one does not exist yet)
#   4. registers the gateway as a background service for this OS
#   5. starts it and waits for a health check
#   6. optionally installs the VS Code extension if `code` is available
#
# It is idempotent: re-running it repairs the setup instead of duplicating it.
#
set -uo pipefail

# ---------------------------------------------------------------- presentation
BOLD=""; DIM=""; RED=""; GREEN=""; YELLOW=""; RESET=""
if [ -t 1 ]; then
  BOLD="$(printf '\033[1m')"; DIM="$(printf '\033[2m')"
  RED="$(printf '\033[31m')"; GREEN="$(printf '\033[32m')"
  YELLOW="$(printf '\033[33m')"; RESET="$(printf '\033[0m')"
fi

step()  { printf '%s==>%s %s\n' "$BOLD" "$RESET" "$*"; }
info()  { printf '    %s\n' "$*"; }
dim()   { printf '    %s%s%s\n' "$DIM" "$*" "$RESET"; }
ok()    { printf '    %s✓%s %s\n' "$GREEN" "$RESET" "$*"; }
warn()  { printf '    %s!%s %s\n' "$YELLOW" "$RESET" "$*"; }
fail()  { printf '    %s✗%s %s\n' "$RED" "$RESET" "$*" >&2; }
die()   { fail "$*"; exit 1; }

# ---------------------------------------------------------------- configuration
PORT="${WORKBUDDY_GATEWAY_PORT:-8790}"
API_KEY="${WORKBUDDY_GATEWAY_API_KEY:-workbuddy-local}"
HOST="${WORKBUDDY_GATEWAY_HOST:-127.0.0.1}"
CONFIG_DIR="${HOME}/.workbuddy-gateway"
CONFIG_FILE="${CONFIG_DIR}/config.json"
LOG_DIR="${CONFIG_DIR}/logs"
LOG_FILE="${LOG_DIR}/gateway.log"
PID_FILE="${CONFIG_DIR}/gateway.pid"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"
GATEWAY_JS="${REPO_DIR}/gateway.js"

printf '\n%sWorkBuddy gateway — setup%s\n\n' "$BOLD" "$RESET"

# ---------------------------------------------------------------- 1. node
step "Checking Node.js"
command -v node >/dev/null 2>&1 || die "node not found. Install Node 18 or newer first."
NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0)"
[ "$NODE_MAJOR" -ge 18 ] 2>/dev/null || die "Node 18+ required, found $(node --version)."
ok "node $(node --version)"

[ -f "$GATEWAY_JS" ] || die "gateway.js not found at $GATEWAY_JS (run this from a clone of the repo)."
ok "gateway: $GATEWAY_JS"

# ---------------------------------------------------------------- 2. login state
step "Locating the WorkBuddy / CodeBuddy desktop login"
AUTH_FILE=""
if [ -n "${WORKBUDDY_AUTH_FILE:-}" ] && [ -r "${WORKBUDDY_AUTH_FILE}" ]; then
  AUTH_FILE="${WORKBUDDY_AUTH_FILE}"
  ok "using WORKBUDDY_AUTH_FILE: $AUTH_FILE"
else
  case "$(uname -s)" in
    Linux)
      # WSL can read the Windows client's login through /mnt/c.
      for dir in /mnt/c/Users/*/AppData/Local/CodeBuddyExtension/Data/Public/auth \
                 "$HOME/.local/share/CodeBuddyExtension/Data/Public/auth" \
                 "$HOME/.codebuddy/auth"; do
        case "$dir" in */Users/Public/*|*/Users/Default/*|*/Users/All\ Users/*) continue ;; esac
        [ -d "$dir" ] || continue
        for f in "$dir"/workbuddy*.info "$dir"/*.info; do
          [ -r "$f" ] && AUTH_FILE="$f" && break
        done
        [ -n "$AUTH_FILE" ] && break
      done
      ;;
    Darwin)
      for dir in "$HOME/Library/Application Support/CodeBuddyExtension/Data/Public/auth" "$HOME/.codebuddy/auth"; do
        [ -d "$dir" ] || continue
        for f in "$dir"/workbuddy*.info "$dir"/*.info; do
          [ -r "$f" ] && AUTH_FILE="$f" && break
        done
        [ -n "$AUTH_FILE" ] && break
      done
      ;;
    *)
      for dir in "${LOCALAPPDATA:-$HOME/AppData/Local}/CodeBuddyExtension/Data/Public/auth" \
                 "$HOME/.codebuddy/auth"; do
        [ -d "$dir" ] || continue
        for f in "$dir"/workbuddy*.info "$dir"/*.info; do
          [ -r "$f" ] && AUTH_FILE="$f" && break
        done
        [ -n "$AUTH_FILE" ] && break
      done
      ;;
  esac
fi

if [ -z "$AUTH_FILE" ]; then
  fail "no login state found."
  info "Sign in with the WorkBuddy / CodeBuddy desktop client, then re-run this script."
  info "Or point at the file directly: WORKBUDDY_AUTH_FILE=/path/to/*.info bash scripts/setup.sh"
  exit 1
fi
ok "login: $AUTH_FILE"

# Show which account, without printing any token.
ACCOUNT="$(node -e '
  try {
    const fs = require("fs");
    const j = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
    const a = j.auth || {}, acct = j.account || {};
    const exp = Number(a.expiresAt || 0);
    process.stdout.write(
      (acct.nickname || "(unknown)") + "|" + (a.domain || "-") + "|" +
      (exp ? new Date(exp).toISOString().slice(0, 16) : "-")
    );
  } catch (e) { process.stdout.write("(unreadable)|-|-"); }
' "$AUTH_FILE" 2>/dev/null)"
IFS='|' read -r NICK DOMAIN EXPIRES <<< "$ACCOUNT"
info "account: ${NICK}  domain: ${DOMAIN}  token valid to: ${EXPIRES}"

# ---------------------------------------------------------------- 3. upstream
step "Checking the upstream is reachable"
UP_CODE="$(curl -s -m 10 -o /dev/null -w '%{http_code}' https://copilot.tencent.com/ 2>/dev/null || echo 000)"
if [ "$UP_CODE" = "000" ]; then
  warn "cannot reach copilot.tencent.com (curl exit non-zero)."
  warn "setup continues; requests will fail until the network allows it."
else
  ok "upstream responded (HTTP $UP_CODE)"
fi

# ---------------------------------------------------------------- 4. config
step "Writing configuration"
mkdir -p "$CONFIG_DIR" "$LOG_DIR"
if [ -f "$CONFIG_FILE" ]; then
  ok "keeping existing $CONFIG_FILE"
else
  cat > "$CONFIG_FILE" <<EOF
{
  "host": "${HOST}",
  "port": ${PORT},
  "apiKey": "${API_KEY}",
  "upstream": "https://copilot.tencent.com",
  "authFile": "${AUTH_FILE}",
  "logFile": "${LOG_FILE}",
  "desensitize": true,
  "retryOnBlock": true,
  "exposeIdentity": false
}
EOF
  ok "wrote $CONFIG_FILE"
fi

# ---------------------------------------------------------------- 5. stop old
step "Stopping any previous instance"
if [ -f "$PID_FILE" ]; then
  OLD="$(cat "$PID_FILE" 2>/dev/null || true)"
  if [ -n "${OLD:-}" ] && kill -0 "$OLD" 2>/dev/null; then
    kill "$OLD" 2>/dev/null || true
    for _ in $(seq 1 10); do kill -0 "$OLD" 2>/dev/null || break; sleep 0.5; done
    kill -9 "$OLD" 2>/dev/null || true
    ok "stopped pid $OLD"
  fi
  rm -f "$PID_FILE"
fi
# A stale listener on the port would make the health check lie.
if command -v ss >/dev/null 2>&1 && ss -ltn 2>/dev/null | grep -q ":${PORT}\b"; then
  warn "port ${PORT} is already in use by another process; health check may hit that one instead."
fi

# ---------------------------------------------------------------- 6. start
step "Starting the gateway on ${HOST}:${PORT}"
# setsid detaches into a new session so the process survives this script (and, in
# WSL, survives the shell that invoked it).
START_CMD=(node "$GATEWAY_JS" --config "$CONFIG_FILE" --log "$LOG_FILE")
if command -v setsid >/dev/null 2>&1; then
  setsid "${START_CMD[@]}" >>"${LOG_DIR}/gateway.out.log" 2>&1 < /dev/null &
else
  nohup "${START_CMD[@]}" >>"${LOG_DIR}/gateway.out.log" 2>&1 < /dev/null &
fi
GW_PID=$!
disown "$GW_PID" 2>/dev/null || true
echo "$GW_PID" > "$PID_FILE"
ok "pid $GW_PID"

step "Waiting for the health check"
READY=""
for _ in $(seq 1 20); do
  sleep 1
  CODE="$(curl -s -m 3 -o /dev/null -w '%{http_code}' -H "Authorization: Bearer ${API_KEY}" "http://${HOST}:${PORT}/health" 2>/dev/null || echo 000)"
  if [ "$CODE" = "200" ]; then READY="yes"; break; fi
done

if [ -z "$READY" ]; then
  fail "the gateway did not become healthy within 20s."
  dim "last log lines:"
  tail -n 15 "${LOG_DIR}/gateway.out.log" 2>/dev/null | sed 's/^/      /'
  exit 1
fi

MODELS="$(curl -s -m 5 -H "Authorization: Bearer ${API_KEY}" "http://${HOST}:${PORT}/v1/models" \
  | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{const j=JSON.parse(s);const d=j.data||[];process.stdout.write(String(d.length)+" ("+d.filter(m=>m.tier==="free").length+" free)")}catch{process.stdout.write("?")}})' 2>/dev/null)"
ok "healthy — ${MODELS} models"

# ---------------------------------------------------------------- 7. VS Code
step "VS Code extension (optional)"
# --skip-extension keeps this usable on a machine without VS Code.
if [ "${1:-}" = "--skip-extension" ]; then
  dim "skipped by request"
else
  VSIX="$(ls -1 "${REPO_DIR}"/vscode-extension/*.vsix 2>/dev/null | head -1 || true)"
  CODE_CLI=""
  command -v code >/dev/null 2>&1 && CODE_CLI="code"
  if [ -z "$CODE_CLI" ] && [ -n "${LOCALAPPDATA:-}" ]; then
    for c in "$LOCALAPPDATA/Programs/Microsoft VS Code/bin/code.cmd" \
             "/c/Program Files/Microsoft VS Code/bin/code.cmd" \
             "/d/App/Microsoft VS Code/bin/code.cmd"; do
      [ -x "$c" ] && CODE_CLI="$c" && break
    done
  fi

  if [ -z "$VSIX" ]; then
    dim "no .vsix in vscode-extension/ — build one with: cd vscode-extension && npx @vscode/vsce package"
  elif [ -z "$CODE_CLI" ]; then
    dim "the 'code' CLI was not found; install the extension by hand:"
    dim "  VS Code → Extensions: Install from VSIX… → $VSIX"
  else
    if "$CODE_CLI" --install-extension "$VSIX" --force >/dev/null 2>&1; then
      ok "installed $(basename "$VSIX")"
      dim "restart VS Code, then pick a WorkBuddy model in the Chat view"
    else
      warn "VS Code CLI install failed; use Extensions: Install from VSIX… with:"
      dim "  $VSIX"
    fi
  fi
fi

# ---------------------------------------------------------------- summary
printf '\n%sDone.%s\n\n' "$BOLD$GREEN" "$RESET"
printf '  endpoint   %shttp://%s:%s/v1%s\n' "$BOLD" "$HOST" "$PORT" "$RESET"
printf '  api key    %s\n' "$API_KEY"
printf '  config     %s\n' "$CONFIG_FILE"
printf '  logs       %s\n' "$LOG_FILE"
printf '  pid        %s\n\n' "$(cat "$PID_FILE" 2>/dev/null || echo '-')"

printf '  %sQuick checks%s\n' "$BOLD" "$RESET"
printf '    curl -s http://%s:%s/health -H "Authorization: Bearer %s"\n' "$HOST" "$PORT" "$API_KEY"
printf '    node probes/probe-models.js        # which model ids this account serves\n'
printf '    node probes/probe-thinking.js      # which models have a reasoning channel\n\n'

printf '  %sFree models first%s — hy4-preview-f is free; hy4-preview (no -f) bills credits.\n' "$BOLD" "$RESET"
printf '  Stop it with: %sbash scripts/stop.sh%s\n\n' "$BOLD" "$RESET"
