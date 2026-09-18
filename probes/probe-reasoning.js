#!/usr/bin/env node
/**
 * Probe how the upstream reacts to `reasoning_effort` values.
 *
 * Observed behaviour (2026-09, CN account): every level is accepted with HTTP 200
 * and the model still returns a reasoning channel. So this probe cannot tell you
 * which level a model honours - it only proves the value is not rejected.
 *
 * More importantly, what it *can* show is whether a given level trips the
 * upstream security filter, which is why the gateway keeps a retry ladder.
 *
 * Usage:
 *   node probes/probe-reasoning.js
 *   node probes/probe-reasoning.js hy4-preview glm-5.3
 */

'use strict';

const { loadCredential } = require('./_auth');

const MODELS = ['hy4-preview', 'glm-5.3', 'kimi-k3', 'deepseek-v4-flash'];
const LEVELS = [undefined, 'minimal', 'low', 'medium', 'high', 'xhigh'];

async function probe(cred, model, effort) {
  const body = { model, messages: [{ role: 'user', content: '2+2=?' }], stream: true, max_tokens: 16 };
  if (effort !== undefined) body.reasoning_effort = effort;
  const r = await fetch(cred.upstream + '/v2/chat/completions', {
    method: 'POST', headers: cred.headers, body: JSON.stringify(body),
  });
  const t = await r.text();
  if (r.status !== 200) {
    let note = t.slice(0, 90).replace(/\s+/g, ' ');
    try { const j = JSON.parse(t); note = (j.msg || note) + (j.code ? ' [' + j.code + ']' : ''); } catch { /* raw */ }
    return 'HTTP ' + r.status + ' ' + note;
  }
  return 'HTTP 200 reasoning=' + t.includes('reasoning_content');
}

(async () => {
  const models = process.argv.slice(2).filter(a => !a.startsWith('--'));
  const list = models.length ? models : MODELS;
  const cred = await loadCredential();

  console.log('upstream : ' + cred.upstream);
  for (const m of list) {
    for (const e of LEVELS) {
      let out;
      try { out = await probe(cred, m, e); } catch (err) { out = 'ERR ' + err.message; }
      console.log(m.padEnd(20) + String(e === undefined ? '(not sent)' : e).padEnd(12) + out);
    }
    console.log('');
  }
})();
