'use strict';
/**
 * Resolve the API key the running gateway actually expects.
 *
 * The gateway is started by the user (often from a script or a scheduled task),
 * so its key is not something this extension can know in advance. Rather than
 * making the user copy it into settings, we look in the places the key is
 * already recorded:
 *
 *   1. the VS Code setting (explicit wins)
 *   2. the gateway's own start scripts in a known checkout
 *   3. the gateway's log banner
 *
 * The gateway only ever listens on loopback, so reading a local file for its key
 * is not a meaningful exposure — and it removes the most common setup failure:
 * "HTTP 401 because the key was never configured".
 */

const fs = require('fs');
const path = require('path');
const os = require('os');

/**
 * Directories that plausibly hold a gateway config or checkout.
 *
 * The first entry matters most: the setup scripts this repository ships write
 * their config to `~/.workbuddy-gateway/`, so an install done the documented way
 * puts the key there and nowhere else. Leaving that path out is the difference
 * between a working install and a 401 on first launch.
 */
function candidateDirs(extra) {
  const dirs = [];
  if (extra) dirs.push(extra);
  if (process.env.WORKBUDDY_GATEWAY_DIR) dirs.push(process.env.WORKBUDDY_GATEWAY_DIR);

  const home = os.homedir();
  dirs.push(
    // What scripts/setup.{ps1,sh} write. Possibly also what `--config` points at.
    path.join(home, '.workbuddy-gateway'),
    // A manual clone, in the layouts people tend to use.
    path.join(home, 'workbuddy-gateway'),
    path.join(home, 'WorkBuddyToDeepSeekHarness'),
    path.join(home, 'Documents', 'workbuddy-gateway'),
    path.join(home, 'Documents', 'WorkBuddyToDeepSeekHarness')
  );

  // Under WSL the gateway usually runs on the Windows side, so its config lives
  // on the Windows drive and is reachable through /mnt/c.
  try {
    const usersDir = '/mnt/c/Users';
    for (const user of fs.readdirSync(usersDir)) {
      if (/^(Public|Default|Default User|All Users)$/i.test(user)) continue;
      dirs.push(path.join(usersDir, user, '.workbuddy-gateway'));
      dirs.push(path.join(usersDir, user, 'workbuddy-gateway'));
    }
  } catch { /* not WSL, or /mnt/c unavailable */ }

  return dirs;
}

/** Pull `--api-key X` out of a start script's text. */
function apiKeyFromScript(text) {
  if (!text) return null;
  // Matches: --api-key workbuddy-local   /   set WORKBUDDY_GATEWAY_API_KEY=workbuddy-local
  let m = /--api-key\s+([A-Za-z0-9._-]+)/.exec(text);
  if (m) return m[1];
  m = /WORKBUDDY_GATEWAY_API_KEY\s*=\s*([A-Za-z0-9._-]+)/.exec(text);
  if (m) return m[1];
  return null;
}

/**
 * Try to discover the key the local gateway is running with.
 * Returns { key, source } or null when nothing conclusive is found.
 */
function discoverGatewayApiKey(extraDir) {
  for (const dir of candidateDirs(extraDir)) {
    let entries;
    try { entries = fs.readdirSync(dir); } catch { continue; }

    // Prefer an explicit config file, then the start scripts.
    const ordered = [
      'config.json',
      'start-gateway.cmd',
      'start-gateway.sh',
      'run-gateway.cmd',
      'start-workbuddy2api.cmd',
    ];
    for (const name of ordered) {
      if (!entries.includes(name)) continue;
      let text;
      try { text = fs.readFileSync(path.join(dir, name), 'utf8'); } catch { continue; }

      if (name === 'config.json') {
        try {
          // Strip a UTF-8 BOM first. PowerShell 5.1's `Set-Content -Encoding
          // UTF8` and Notepad both write one, and JSON.parse rejects it — which
          // would make discovery skip a perfectly good config and report the key
          // as missing.
          const body = text.charCodeAt(0) === 0xFEFF ? text.slice(1) : text;
          const j = JSON.parse(body);
          if (j && typeof j.apiKey === 'string' && j.apiKey.trim()) {
            return { key: j.apiKey.trim(), source: path.join(dir, name) };
          }
        } catch { /* fall through to script parsing */ }
        continue;
      }
      const key = apiKeyFromScript(text);
      if (key) return { key, source: path.join(dir, name) };
    }
  }
  return null;
}

module.exports = { discoverGatewayApiKey, apiKeyFromScript, candidateDirs };
