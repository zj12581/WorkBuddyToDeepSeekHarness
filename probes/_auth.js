#!/usr/bin/env node
/**
 * Shared helper for the probe scripts: locate the desktop auth file, keep the
 * access token fresh, and expose the upstream request headers.
 *
 * Probes talk to the upstream directly (bypassing the gateway) so that they
 * measure the account's real model availability rather than the gateway's
 * configured list.
 */

'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');

const UPSTREAM = process.env.WORKBUDDY_UPSTREAM || 'https://copilot.tencent.com';

function authFileCandidates() {
  const list = [];
  if (process.env.WORKBUDDY_AUTH_FILE) list.push(process.env.WORKBUDDY_AUTH_FILE);
  const local = process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local');
  const appdata = process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming');
  const dirs = [
    path.join(local, 'CodeBuddyExtension', 'Data', 'Public', 'auth'),
    path.join(appdata, 'CodeBuddyExtension', 'Data', 'Public', 'auth'),
    path.join(os.homedir(), '.codebuddy', 'auth'),
    path.join(os.homedir(), 'Library', 'Application Support', 'CodeBuddyExtension', 'Data', 'Public', 'auth'),
    path.join(os.homedir(), '.local', 'share', 'CodeBuddyExtension', 'Data', 'Public', 'auth'),
  ];
  for (const d of dirs) {
    try {
      for (const f of fs.readdirSync(d)) if (f.endsWith('.info')) list.push(path.join(d, f));
    } catch { /* directory absent */ }
  }
  return list;
}

function resolveAuthFile() {
  const cands = authFileCandidates();
  const picked = cands.find(p => /workbuddy/i.test(path.basename(p))) || cands[0];
  if (!picked) {
    console.error('No WorkBuddy/CodeBuddy auth file found.');
    console.error('Sign in with the desktop client first, or point WORKBUDDY_AUTH_FILE at the auth file.');
    process.exit(1);
  }
  return picked;
}

function readStore(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

async function refreshIfNeeded(file, store) {
  const auth = store.auth || {};
  const exp = Number(auth.expiresAt || 0);
  if (exp && Date.now() < exp - 60_000) return store;

  const acct = store.account || {};
  const headers = {
    'Content-Type': 'application/json',
    'Accept': 'application/json',
    'Authorization': 'Bearer ' + (auth.accessToken || ''),
    'X-User-Id': String(acct.uid || ''),
    'X-Domain': auth.domain || 'www.workbuddy.cn',
    'User-Agent': 'workbuddy-gateway-probe/1.0',
    'X-Refresh-Token': auth.refreshToken || '',
    'X-Auth-Refresh-Source': 'plugin',
  };
  const res = await fetch(UPSTREAM + '/v2/plugin/auth/token/refresh', { method: 'POST', headers, body: '{}' });
  const data = await res.json().catch(() => ({}));
  if (data.code !== 0 || !data.data) {
    console.error('Token refresh failed: ' + JSON.stringify(data).slice(0, 200));
    return store;
  }
  const fresh = data.data;
  fresh.domain = fresh.domain || auth.domain;
  const now = Date.now();
  if (!fresh.expiresAt && fresh.expiresIn) fresh.expiresAt = now + fresh.expiresIn * 1000;
  if (!fresh.refreshExpiresAt && fresh.refreshExpiresIn) fresh.refreshExpiresAt = now + fresh.refreshExpiresIn * 1000;
  store.auth = fresh;

  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(store, null, 2), { mode: 0o600 });
  fs.renameSync(tmp, file);
  console.error('(token refreshed)');
  return store;
}

/** Returns { file, store, headers, upstream }. */
async function loadCredential() {
  const file = resolveAuthFile();
  const store = await refreshIfNeeded(file, readStore(file));
  const auth = store.auth || {};
  const acct = store.account || {};
  const headers = {
    'Content-Type': 'application/json',
    'Accept': 'application/json',
    'Authorization': 'Bearer ' + (auth.accessToken || ''),
    'X-User-Id': String(acct.uid || ''),
    'X-Domain': auth.domain || 'www.workbuddy.cn',
    'User-Agent': 'workbuddy-gateway-probe/1.0',
  };
  if (acct.enterpriseId) {
    headers['X-Enterprise-Id'] = String(acct.enterpriseId);
    headers['X-Tenant-Id'] = String(acct.enterpriseId);
  }
  return { file, store, headers, upstream: UPSTREAM };
}

module.exports = { loadCredential, authFileCandidates, resolveAuthFile, UPSTREAM };
