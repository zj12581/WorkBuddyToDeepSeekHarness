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
DEST="$PROFILE_DIR/node_modules/dsh-plugin-workbuddy-balance"
ROW_ID="workbuddy-balance"

say() { printf '[balance-plugin] %s\n' "$*"; }
die() { printf '[balance-plugin] %s\n' "$*" >&2; exit 1; }

[ -d "$PROFILE_DIR" ] || die "profile not found: $PROFILE_DIR"
[ -d "$SOURCE" ] || die "plugin source not found: $SOURCE"
say "profile : $PROFILE_DIR"

# 1. Copy the plugin next to the profile's other packages.
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

# 3. Sanity check: can Node resolve it by bare name from the profile?
if command -v node >/dev/null 2>&1; then
  if (cd "$PROFILE_DIR" && node -e "import('dsh-plugin-workbuddy-balance').then(m=>process.exit(m.name==='workbuddy-balance'?0:1)).catch(()=>process.exit(1))" 2>/dev/null); then
    say "resolution check passed"
  else
    say "warning: could not import the plugin by name from the profile directory"
  fi
fi

say "done. Restart dsh (or rely on patchReload: live), then run /balance"
