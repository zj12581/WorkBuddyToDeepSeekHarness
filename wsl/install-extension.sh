#!/usr/bin/env bash
# 把 vsix 安装到 WSL 侧的 vscode-server 扩展目录
set -euo pipefail

VSIX="${1:-/mnt/d/Project/WorkBuddyToDeepSeekHarness/vscode-extension/workbuddy-agent-0.1.0.vsix}"
DEST="$HOME/.vscode-server/extensions/local.workbuddy-agent-0.1.0"

[ -f "$VSIX" ] || { echo "找不到 $VSIX"; exit 1; }

rm -rf "$DEST"
mkdir -p "$DEST"

WORK="$(mktemp -d)"
cd "$WORK"
unzip -q "$VSIX"
cp -r extension/. "$DEST/"
cd /
rm -rf "$WORK"

echo "已安装到: $DEST"
echo "src:"
ls "$DEST/src"
