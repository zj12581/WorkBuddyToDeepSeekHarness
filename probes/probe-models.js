#!/usr/bin/env node
/**
 * Probe which model ids the upstream actually serves.
 *
 * The upstream answers a missing model with
 *   400 {"code":11102,"msg":"model [xxx] service info not found"}
 * so "HTTP 200 + the returned chunk's model field equals the requested id" is a
 * reliable availability check. A 200 whose model field differs means the id is an
 * alias (or falls back to another model).
 *
 * Usage:
 *   node probes/probe-models.js                 # built-in candidate list
 *   node probes/probe-models.js hy4 glm-5.4 ... # your own candidates
 *   node probes/probe-models.js --json          # machine-readable output
 */

'use strict';

const { loadCredential } = require('./_auth');

const CANDIDATES = [
  // Hunyuan (Hy)
  'auto', 'hy4', 'hy4-preview', 'hy4-preview-f', 'hy4-preview-agent',
  'hy3', 'hy3-preview', 'hy3-preview-agent',
  // Zhipu GLM
  'glm-5.3', 'glm-5.3-flash', 'glm-5.2', 'glm-5.1', 'glm-5v-turbo',
  // Moonshot Kimi
  'kimi-k3', 'kimi-k2.7', 'kimi-k2.7-code', 'kimi-k2.6', 'kimi-k2.5',
  // MiniMax
  'minimax-m3', 'minimax-m2.7',
  // DeepSeek
  'deepseek-v4-pro', 'deepseek-v4-flash', 'deepseek-v3.2',
  // Deliberately wrong, to show what a miss looks like
  'hunyuan', 'no-such-model',
];

async function probe(cred, model) {
  const body = { model, messages: [{ role: 'user', content: 'hi' }], stream: true, max_tokens: 4 };
  const r = await fetch(cred.upstream + '/v2/chat/completions', {
    method: 'POST', headers: cred.headers, body: JSON.stringify(body),
  });
  const text = await r.text();
  if (r.status !== 200) {
    let note = text.slice(0, 100).replace(/\s+/g, ' ');
    try {
      const j = JSON.parse(text);
      note = (j.msg || j.error_msg || note) + (j.code ? ' [' + j.code + ']' : '');
    } catch { /* keep raw */ }
    return { model, ok: false, note };
  }
  let resolved = '';
  const m = text.match(/data: (\{.*?\})\n/);
  if (m) { try { resolved = JSON.parse(m[1]).model || ''; } catch { /* ignore */ } }
  return { model, ok: true, resolved, exact: resolved === model };
}

(async () => {
  const argv = process.argv.slice(2);
  const asJson = argv.includes('--json');
  const models = argv.filter(a => !a.startsWith('--'));
  const list = models.length ? models : CANDIDATES;

  const cred = await loadCredential();
  const results = [];
  for (const m of list) {
    try { results.push(await probe(cred, m)); }
    catch (e) { results.push({ model: m, ok: false, note: 'ERR ' + e.message }); }
  }

  if (asJson) {
    console.log(JSON.stringify({ upstream: cred.upstream, results }, null, 2));
    return;
  }

  console.log('upstream : ' + cred.upstream);
  console.log('request id'.padEnd(24) + 'result');
  console.log('-'.repeat(78));
  for (const r of results) {
    if (r.ok) {
      console.log(r.model.padEnd(24) + 'HTTP 200  resolved=' + r.resolved + (r.exact ? '  OK' : '  (alias / fallback)'));
    } else {
      console.log(r.model.padEnd(24) + r.note);
    }
  }
  const usable = results.filter(r => r.ok && r.exact).map(r => r.model);
  console.log('\nusable ids (' + usable.length + '): ' + usable.join(','));
})();
