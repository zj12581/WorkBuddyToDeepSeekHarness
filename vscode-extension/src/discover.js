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

/** Directories that plausibly hold a gateway checkout. */
function candidateDirs(extra) {
  const dirs = [];
  if (extra) dirs.push(extra);
  if (process.env.WORKBUDDY_GATEWAY_DIR) dirs.push(process.env.WORKBUDDY_GATEWAY_DIR);
  const home = os.homedir();
  dirs.push(
    path.join(home, 'workbuddy-gateway'),
    path.join(home, 'WorkBuddyToDeepSeekHarness'),
    path.join(home, 'Documents', 'workbuddy-gateway')
  );
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
          const j = JSON.parse(text);
          if (j && typeof j.apiKey === 'string' && j.apiKey) {
            return { key: j.apiKey, source: path.join(dir, name) };
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
