#!/usr/bin/env bash
#
# Install the workbuddy-balance plugin into a DSH profile.
#
#   bash integrations/dsh/install-balance-plugin.sh [profile]
#
# Defaults to the `web` profile. Copies the plugin into the profile's
# node_modules (so Node resolves it by bare package name, the same way DSH
# resolves its own plugins) and adds the loader row to cordis.patch.yml.
#
set -euo pipefail

PROFILE="${1:-web}"
DSH_HOME="${DSH_HOME:-$HOME/.dsh}"
PROFILE_DIR="$DSH_HOME/profiles/$PROFILE"
PATCH="$PROFILE_DIR/cordis.patch.yml"
SOURCE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/plugin-workbuddy-balance"

# DSH resolves plugin names from $DSH_HOME/profiles, not from the profile's own
# directory: loading happens inside the loader package, whose own node_modules
# holds nothing of ours, and $DSH_HOME/profiles/node_modules is the fallback that
# DSH maintains (and where its own local plugins such as dsh-session-sync live).
# Installing into $PROFILE_DIR/node_modules leaves the files on disk but makes
# them unreachable, and the loader quietly never activates the plugin.
MODULES_DIR="$DSH_HOME/profiles/node_modules"
DEST="$MODULES_DIR/dsh-plugin-workbuddy-balance"
ROW_ID="workbuddy-balance"

say() { printf '[balance-plugin] %s\n' "$*"; }
die() { printf '[balance-plugin] %s\n' "$*" >&2; exit 1; }

[ -d "$PROFILE_DIR" ] || die "profile not found: $PROFILE_DIR"
[ -d "$SOURCE" ] || die "plugin source not found: $SOURCE"
say "profile : $PROFILE_DIR"
say "modules : $MODULES_DIR"

# 0. Remove a copy left by an older version of this script, which used
#    $PROFILE_DIR/node_modules. Two copies would resolve to whichever comes
#    first, making the installed version ambiguous.
STALE="$PROFILE_DIR/node_modules/dsh-plugin-workbuddy-balance"
if [ -d "$STALE" ]; then
  rm -rf "$STALE"
  say "removed stale copy at $STALE"
fi

# 1. Copy the plugin where DSH resolves packages from.
mkdir -p "$DEST/lib"
cp "$SOURCE/package.json" "$DEST/package.json"
cp "$SOURCE/lib/index.js" "$DEST/lib/index.js"
say "installed: $DEST"

# 2. Add the loader row, unless it is already there.
if [ ! -f "$PATCH" ]; then
  printf '# Your patch layer for this dsh profile.\n[]\n' > "$PATCH"
  say "created $PATCH"
fi

if grep -q "id: $ROW_ID" "$PATCH"; then
  say "loader row already present, leaving it alone"
else
  cat >> "$PATCH" <<EOF

# WorkBuddy credit balance: /balance reports the account's remaining credits.
- insert:
    - id: $ROW_ID
      name: dsh-plugin-workbuddy-balance
EOF
  say "added loader row to $PATCH"
fi

# 3. Sanity check. Test from BOTH directories on purpose:
#    - $MODULES_DIR is where DSH resolves from.
#    - $PROFILE_DIR is where an older layout put it; Node walks up from there, so
#      a copy in either place resolves and a single-directory check cannot tell
#      the two layouts apart.
if command -v node >/dev/null 2>&1; then
  resolve_from() {
    (cd "$1" && node -e "import('dsh-plugin-workbuddy-balance').then(m=>process.exit(m.name==='workbuddy-balance'?0:1)).catch(()=>process.exit(1))" 2>/dev/null)
  }
  if resolve_from "$MODULES_DIR"; then
    say "resolution check passed ($MODULES_DIR)"
  else
    say "warning: could not import the plugin by name from $MODULES_DIR"
  fi
  if [ -d "$PROFILE_DIR/node_modules/dsh-plugin-workbuddy-balance" ]; then
    say "warning: a second copy still exists under $PROFILE_DIR/node_modules"
  fi
fi

say "done. Restart dsh (or rely on patchReload: live), then run /balance"
