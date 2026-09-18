#!/usr/bin/env node
/**
 * Probe which `max_tokens` values the upstream accepts, per model.
 *
 * Note: the upstream does NOT validate this field (it accepts values far beyond
 * any real context window), so this probe cannot discover a model's true output
 * cap. It is only useful to confirm that a value you intend to send is not
 * rejected outright. Treat it as a guard rail, not as a source of truth.
 *
 * Usage:
 *   node probes/probe-limits.js
 *   node probes/probe-limits.js deepseek-v4-flash 65536 131072
 */

'use strict';

const { loadCredential } = require('./_auth');

const MODELS = ['deepseek-v4-flash', 'glm-5.3', 'kimi-k3', 'minimax-m3', 'hy4-preview'];
const VALUES = [65536, 131072, 262144];

async function probe(cred, model, maxTokens) {
  const body = { model, messages: [{ role: 'user', content: 'hi' }], stream: true, max_tokens: maxTokens };
  const r = await fetch(cred.upstream + '/v2/chat/completions', {
    method: 'POST', headers: cred.headers, body: JSON.stringify(body),
  });
  const t = await r.text();
  if (r.status !== 200) return { ok: false, note: 'HTTP ' + r.status + ' ' + t.slice(0, 90).replace(/\s+/g, ' ') };
  if (/max_tokens|context|too long|exceed|超出/i.test(t)) return { ok: false, note: 'REJECTED ' + t.slice(0, 90).replace(/\s+/g, ' ') };
  return { ok: true };
}

(async () => {
  const argv = process.argv.slice(2);
  const cred = await loadCredential();

  let models = MODELS;
  let values = VALUES;
  if (argv.length) {
    models = [argv[0]];
    if (argv.length > 1) values = argv.slice(1).map(Number);
  }

  console.log('upstream : ' + cred.upstream);
  for (const m of models) {
    const parts = [];
    for (const v of values) {
      let r;
      try { r = await probe(cred, m, v); } catch (e) { r = { ok: false, note: 'ERR ' + e.message }; }
      parts.push('max_tokens=' + v + ': ' + (r.ok ? 'accepted' : r.note));
    }
    console.log(m.padEnd(20) + parts.join('  |  '));
  }
  console.log('\nreminder: acceptance here only means the request was not rejected; it does not reveal the real output cap.');
})();
