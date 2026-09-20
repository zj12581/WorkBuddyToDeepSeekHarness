/**
 * WorkBuddy balance for DeepSeek Harness.
 *
 * Registers a `/balance` slash command that reports the account's credit
 * balance, read from the same upstream billing endpoint the desktop client uses.
 *
 * The plugin is self-contained: it does not import from the gateway repository,
 * so it can be dropped into a DSH profile on its own. The only thing it shares
 * with the gateway is the login file on disk.
 *
 * The billing endpoint is read-only, so this never writes to the auth file and
 * never triggers a token refresh. If the access token has expired the command
 * says so and asks the user to run the desktop client (or the gateway) once to
 * refresh it; rewriting another application's session store to satisfy a status
 * command is not worth the risk.
 *
 * Results are cached for a short window: the endpoint has a settlement delay
 * (consecutive queries return slightly different numbers while it catches up),
 * so repeats are pointless and a slash command is easy to spam.
 *
 * @module dsh-plugin-workbuddy-balance
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/** Cordis plugin name. */
const name = 'workbuddy-balance';

/**
 * The command registry is the plugin's whole purpose; without it the fiber stays
 * pending. No other service is required — this talks to the network directly.
 */
const inject = ['commands'];

const UPSTREAM = 'https://copilot.tencent.com';
const BILLING_PATH = '/v2/billing/meter/get-user-resource';
const PRODUCT_CODE = 'p_tcaca';
const CACHE_MS = 30_000;
const REQUEST_TIMEOUT_MS = 15_000;

// ---------------------------------------------------------------------------
// login file discovery
// ---------------------------------------------------------------------------

/** Directories that may hold the desktop client's session, most likely first. */
function authDirCandidates() {
  const home = os.homedir();
  const local = process.env.LOCALAPPDATA || path.join(home, 'AppData', 'Local');
  const appdata = process.env.APPDATA || path.join(home, 'AppData', 'Roaming');
  const out = [];

  const push = (d) => { if (d && !out.includes(d)) out.push(d); };

  // Explicit override always wins.
  if (process.env.WORKBUDDY_AUTH_DIR) push(process.env.WORKBUDDY_AUTH_DIR);

  // Windows
  push(path.join(local, 'CodeBuddyExtension', 'Data', 'Public', 'auth'));
  push(path.join(appdata, 'CodeBuddyExtension', 'Data', 'Public', 'auth'));

  // macOS
  push(path.join(home, 'Library', 'Application Support', 'CodeBuddyExtension', 'Data', 'Public', 'auth'));

  // Linux, including WSL reading the Windows client through /mnt/c
  push(path.join(home, '.local', 'share', 'CodeBuddyExtension', 'Data', 'Public', 'auth'));
  try {
    const usersDir = '/mnt/c/Users';
    for (const entry of fs.readdirSync(usersDir)) {
      if (/^(Public|Default|Default User|All Users)$/i.test(entry)) continue;
      push(path.join(usersDir, entry, 'AppData', 'Local', 'CodeBuddyExtension', 'Data', 'Public', 'auth'));
    }
  } catch { /* not WSL, or /mnt/c is unavailable */ }

  return out;
}

/** Resolve the newest readable session file, preferring a workbuddy-named one. */
function resolveAuthFile() {
  if (process.env.WORKBUDDY_AUTH_FILE) {
    return fs.existsSync(process.env.WORKBUDDY_AUTH_FILE) ? process.env.WORKBUDDY_AUTH_FILE : null;
  }
  for (const dir of authDirCandidates()) {
    let entries;
    try { entries = fs.readdirSync(dir); } catch { continue; }
    const infos = entries.filter((f) => f.endsWith('.info'));
    if (!infos.length) continue;
    // A workbuddy-specific file beats a generic one.
    const preferred = infos.filter((f) => /workbuddy/i.test(f));
    const chosen = (preferred.length ? preferred : infos)[0];
    return path.join(dir, chosen);
  }
  return null;
}

function readSession() {
  const file = resolveAuthFile();
  if (!file) return { error: 'no login file found' };
  let store;
  try {
    store = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (e) {
    return { error: 'could not read ' + file + ': ' + e.message };
  }
  const auth = store.auth || {};
  const account = store.account || {};
  if (!auth.accessToken) return { error: 'the login file has no accessToken' };
  return { file, auth, account };
}

// ---------------------------------------------------------------------------
// billing
// ---------------------------------------------------------------------------

let cache = null;

/** Human-scale a credit number: 1354.29 -> "1,354.29". */
function fmt(n) {
  return Number(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

/** Percentage of the package still available. */
function pct(remain, size) {
  if (!size) return null;
  return Math.round((remain / size) * 1000) / 10;
}

/**
 * Query the upstream billing endpoint.
 * @returns a normalized summary, or throws with a human-readable message.
 */
async function fetchBalance() {
  const session = readSession();
  if (session.error) throw new Error(session.error);

  const { auth, account } = session;
  const expiresAt = Number(auth.expiresAt || 0);
  if (expiresAt && Date.now() > expiresAt) {
    const when = new Date(expiresAt).toISOString().replace('T', ' ').slice(0, 16);
    throw new Error('the access token expired at ' + when
      + ' — open the WorkBuddy desktop client, or send one request through the gateway, to refresh it');
  }

  const headers = {
    'Content-Type': 'application/json',
    Accept: 'application/json',
    Authorization: 'Bearer ' + auth.accessToken,
    'X-User-Id': String(account.uid || ''),
    'X-Domain': auth.domain || 'www.workbuddy.cn',
    'User-Agent': 'WorkBuddy/1.0',
  };
  const body = {
    PageNumber: 1,
    PageSize: 100,
    ProductCode: PRODUCT_CODE,
    Status: [0, 3],
    PackageEndTimeRangeBegin: '2020-01-01 00:00:00',
    PackageEndTimeRangeEnd: '2036-01-01 00:00:00',
  };

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  let payload;
  try {
    const res = await fetch(UPSTREAM + BILLING_PATH, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    if (res.status === 401) {
      throw new Error('the upstream rejected the token (HTTP 401) — sign in again with the desktop client');
    }
    if (!res.ok) throw new Error('the upstream answered HTTP ' + res.status);
    payload = await res.json();
  } catch (e) {
    if (e.name === 'AbortError') throw new Error('the billing request timed out after ' + (REQUEST_TIMEOUT_MS / 1000) + 's');
    throw e;
  } finally {
    clearTimeout(timer);
  }

  const accounts = payload?.data?.Response?.Data?.Accounts;
  if (!Array.isArray(accounts)) {
    throw new Error('the billing response had no Accounts array (the upstream shape may have changed)');
  }

  /*
   * Two families of counters exist per package:
   *   Capacity*      — the package's lifetime allowance
   *   CycleCapacity* — what remains in the *current* billing cycle
   * The cycle figures are the ones that matter: a package can show a healthy
   * lifetime CapacityRemain while its current cycle is exhausted
   * (observed: CapacityRemain 500, CycleCapacityRemain 0).
   */
  const packages = accounts.map((a) => {
    const remain = Number(a.CycleCapacityRemainPrecise ?? a.CycleCapacityRemain ?? 0);
    const size = Number(a.CycleCapacitySizePrecise ?? a.CycleCapacitySize ?? 0);
    const used = Number(a.CycleCapacityUsedPrecise ?? a.CycleCapacityUsed ?? 0);
    return {
      name: a.PackageName || '(unnamed package)',
      sub: a.SubProductName || '',
      remain,
      size,
      used,
      percent: pct(remain, size),
      cycleEnd: a.CycleEndTime || '',
      unit: a.CapacityUnit || 'credits',
    };
  }).filter((p) => p.size > 0 || p.remain > 0);

  const totalRemain = packages.reduce((s, p) => s + p.remain, 0);
  const totalSize = packages.reduce((s, p) => s + p.size, 0);
  const totalUsed = packages.reduce((s, p) => s + p.used, 0);

  return {
    packages,
    totalRemain,
    totalSize,
    totalUsed,
    percent: pct(totalRemain, totalSize),
    domain: auth.domain || '-',
  };
}

/** Cached wrapper so a repeated `/balance` does not hammer the endpoint. */
async function balance() {
  const now = Date.now();
  if (cache && now - cache.at < CACHE_MS) return { ...cache.value, cached: true };
  const value = await fetchBalance();
  cache = { at: now, value };
  return { ...value, cached: false };
}

// ---------------------------------------------------------------------------
// rendering
// ---------------------------------------------------------------------------

/**
 * Group packages that share a name.
 *
 * The account typically holds several grants of the same product (a dozen
 * "赠送包" entries are normal), and listing each one produces a wall of
 * identical lines. Summing them per name keeps the common case short while
 * still reporting how many grants are behind a figure.
 */
function groupPackages(packages) {
  const byName = new Map();
  for (const p of packages) {
    const key = p.name;
    const entry = byName.get(key) || {
      name: p.name,
      remain: 0,
      size: 0,
      used: 0,
      count: 0,
      cycleEnds: new Set(),
    };
    entry.remain += p.remain;
    entry.size += p.size;
    entry.used += p.used;
    entry.count += 1;
    if (p.cycleEnd) entry.cycleEnds.add(p.cycleEnd);
    byName.set(key, entry);
  }
  return [...byName.values()].map((e) => ({
    name: e.name,
    remain: e.remain,
    size: e.size,
    used: e.used,
    count: e.count,
    percent: pct(e.remain, e.size),
    cycleEnd: [...e.cycleEnds].sort()[0] || '',
  }));
}

/** Render the summary as the plain text a slash command returns. */
function render(result) {
  const lines = [];
  lines.push('WorkBuddy balance — ' + result.domain);
  lines.push('');
  lines.push('  ' + fmt(result.totalRemain) + ' / ' + fmt(result.totalSize)
    + ' credits remaining'
    + (result.percent === null ? '' : '  (' + result.percent + '%)'));
  lines.push('  ' + fmt(result.totalUsed) + ' used');
  lines.push('');

  const grouped = groupPackages(result.packages)
    // Show anything with credit left, plus fully-spent packages so an exhausted
    // grant is still visible rather than silently dropped.
    .filter((g) => g.remain > 0 || g.percent === 0)
    .sort((a, b) => b.remain - a.remain);

  if (grouped.length) {
    lines.push('  Packages');
    for (const g of grouped) {
      const parts = [fmt(g.remain) + ' / ' + fmt(g.size)];
      if (g.percent !== null) parts.push(g.percent + '%');
      let line = '    ' + parts.join('  ') + '   ' + g.name;
      if (g.count > 1) line += '  ×' + g.count;
      if (g.cycleEnd) line += '   (next cycle ends ' + g.cycleEnd.slice(0, 10) + ')';
      lines.push(line);
    }
  }

  if (result.cached) {
    lines.push('');
    lines.push('  (cached; the endpoint has a settlement delay, so this is at most 30s old)');
  }
  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// plugin
// ---------------------------------------------------------------------------

/** Execute one `/balance` invocation. */
async function execute(ctx) {
  try {
    const result = await balance();
    if (!result.packages.length) {
      return { kind: 'success', text: 'No credit packages found on this account.' };
    }
    return { kind: 'success', text: render(result) };
  } catch (error) {
    return { kind: 'error', text: 'Could not read the WorkBuddy balance: ' + (error?.message || String(error)) };
  }
}

/**
 * Register `/balance`.
 * @param ctx - context carrying the command registry.
 */
function apply(ctx) {
  ctx.effect(function* () {
    yield ctx.commands.register({
      name: 'balance',
      description: 'Show the WorkBuddy / CodeBuddy credit balance',
      handler: () => execute(ctx),
    });
  }, 'workbuddy-balance lifecycle');
}

export { apply, inject, name };
