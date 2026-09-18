#!/usr/bin/env node
/**
 * Check whether each model emits a separate reasoning channel
 * (`delta.reasoning_content`) or hides its thinking inside the answer text.
 *
 * This is the fact that decides how a client should declare a model's thinking
 * levels: a model with no reasoning channel must be declared as non-reasoning,
 * otherwise the client sends `reasoning_effort` that the model ignores (at best).
 *
 * Usage:
 *   node probes/probe-thinking.js                    # built-in list
 *   node probes/probe-thinking.js hy4-preview glm-5.3
 *   node probes/probe-thinking.js --json
 */

'use strict';

const { loadCredential } = require('./_auth');

const MODELS = [
  'auto', 'hy4-preview', 'hy4-preview-f', 'hy3', 'hy3-preview', 'hy3-preview-agent',
  'glm-5.3', 'glm-5.3-flash', 'glm-5.2', 'glm-5.1', 'glm-5v-turbo',
  'kimi-k3', 'kimi-k2.7', 'kimi-k2.6', 'kimi-k2.5',
  'minimax-m3', 'minimax-m2.7',
  'deepseek-v4-pro', 'deepseek-v4-flash', 'deepseek-v3.2',
];

// A prompt that makes a reasoning model actually think.
const PROMPT = 'A tank is filled by pipe A in 3 hours and by pipe B in 6 hours. '
  + 'With both open, how long does it take? Show your reasoning.';

async function check(cred, model) {
  const body = { model, messages: [{ role: 'user', content: PROMPT }], stream: true, max_tokens: 800 };
  const r = await fetch(cred.upstream + '/v2/chat/completions', {
    method: 'POST', headers: cred.headers, body: JSON.stringify(body),
  });
  if (!r.ok) {
    const t = await r.text().catch(() => '');
    return { model, ok: false, note: 'HTTP ' + r.status + ' ' + t.slice(0, 80).replace(/\s+/g, ' ') };
  }

  const dec = new TextDecoder();
  let buf = '', reasoning = '', content = '', resolved = '';
  for await (const c of r.body) {
    buf += dec.decode(c, { stream: true });
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i).trim();
      buf = buf.slice(i + 1);
      if (!line.startsWith('data:')) continue;
      const d = line.slice(5).trim();
      if (!d || d === '[DONE]') continue;
      let o; try { o = JSON.parse(d); } catch { continue; }
      if (o.model) resolved = o.model;
      const ch = (o.choices || [])[0];
      if (!ch || !ch.delta) continue;
      if (ch.delta.reasoning_content) reasoning += ch.delta.reasoning_content;
      if (ch.delta.content) content += ch.delta.content;
    }
  }
  return {
    model, ok: true, resolved,
    reasoningChars: reasoning.length,
    contentChars: content.length,
    reasoning: reasoning.length > 0,
    thinkingInContent: reasoning.length === 0 && /<thinking>|思考过程|让我(先)?(想|分析)/.test(content),
  };
}

(async () => {
  const argv = process.argv.slice(2);
  const asJson = argv.includes('--json');
  const models = argv.filter(a => !a.startsWith('--'));
  const list = models.length ? models : MODELS;

  const cred = await loadCredential();
  const results = [];
  for (const m of list) {
    try { results.push(await check(cred, m)); }
    catch (e) { results.push({ model: m, ok: false, note: 'ERR ' + e.message }); }
  }

  if (asJson) {
    console.log(JSON.stringify({ upstream: cred.upstream, results }, null, 2));
    return;
  }

  console.log('model'.padEnd(20) + 'resolved'.padEnd(20) + 'reasoning'.padStart(10) + 'content'.padStart(9) + '  verdict');
  console.log('-'.repeat(82));
  for (const r of results) {
    if (!r.ok) { console.log(r.model.padEnd(20) + '-'.padEnd(20) + '-'.padStart(10) + '-'.padStart(9) + '  ' + r.note); continue; }
    const verdict = r.reasoning ? 'separate reasoning channel' : (r.thinkingInContent ? 'thinking inside content' : 'no reasoning');
    console.log(r.model.padEnd(20) + String(r.resolved).padEnd(20)
      + String(r.reasoningChars).padStart(10) + String(r.contentChars).padStart(9) + '  ' + verdict);
  }
  const reasoningModels = results.filter(r => r.ok && r.reasoning).map(r => r.model);
  console.log('\nreasoning models (' + reasoningModels.length + '): ' + reasoningModels.join(','));
})();
