#!/usr/bin/env node
/**
 * Smoke test: /v1/models, non-streaming, streaming and native tool calling.
 *
 * Usage:
 *   node tests/smoke-test.js                                   # defaults
 *   node tests/smoke-test.js http://127.0.0.1:8790 KEY model
 */

'use strict';

const BASE = process.argv[2] || 'http://127.0.0.1:8790';
const KEY = process.argv[3] || '';
const MODEL = process.argv[4] || 'deepseek-v4-flash';

const H = { 'Content-Type': 'application/json' };
if (KEY) H['Authorization'] = 'Bearer ' + KEY;

let failures = 0;
const fail = (msg) => { failures++; console.log('    FAIL: ' + msg); };

async function listModels() {
  const r = await fetch(BASE + '/v1/models', { headers: H });
  const j = await r.json();
  const ids = (j.data || []).map(m => m.id);
  console.log('[1] GET /v1/models ->', r.status, '|', ids.length, 'models:', ids.join(', '));
  if (r.status !== 200 || !ids.length) fail('model list empty');
}

async function nonStream() {
  // No max_tokens here on purpose: a reasoning model spends its output budget on the
  // reasoning channel first, so a small cap returns empty content with
  // finish_reason "length". Let the upstream use its default budget.
  const r = await fetch(BASE + '/v1/chat/completions', {
    method: 'POST', headers: H,
    body: JSON.stringify({ model: MODEL, messages: [{ role: 'user', content: 'Reply with just: pong' }] }),
  });
  const j = await r.json();
  const choice = (j.choices && j.choices[0]) || {};
  const text = ((choice.message && choice.message.content) || '').trim();
  const reasoning = ((choice.message && choice.message.reasoning_content) || '').length;
  console.log('[2] non-streaming ->', r.status, '| model=' + j.model,
    '| finish=' + choice.finish_reason,
    '| tokens=' + (j.usage && j.usage.total_tokens),
    '| reasoning chars=' + reasoning);
  console.log('    content:', text.slice(0, 100) || '(empty)');
  if (r.status !== 200) fail('non-streaming request failed');
  if (!text && !reasoning) fail('empty content and no reasoning');
  if (!text && choice.finish_reason === 'length') {
    console.log('    note: reasoning consumed the whole budget without producing content');
  }
}

async function streaming() {
  const r = await fetch(BASE + '/v1/chat/completions', {
    method: 'POST', headers: H,
    body: JSON.stringify({
      model: MODEL, stream: true,
      messages: [{ role: 'user', content: 'In one sentence, what is a CAN bus?' }],
      max_tokens: 1200,   // reasoning models spend the budget on reasoning first
    }),
  });
  const dec = new TextDecoder();
  let buf = '', text = '', reasoning = '', finish = null, usage = null, chunks = 0;
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
      if (o.usage) usage = o.usage;
      const ch = (o.choices || [])[0];
      if (!ch) continue;
      if (ch.finish_reason) finish = ch.finish_reason;
      if (ch.delta && ch.delta.content) text += ch.delta.content;
      if (ch.delta && ch.delta.reasoning_content) reasoning += ch.delta.reasoning_content;
      chunks++;
    }
  }
  console.log('[3] streaming ->', r.status, '| chunks=' + chunks, '| finish=' + finish,
    '| tokens=' + (usage && usage.total_tokens), '| reasoning chars=' + reasoning.length);
  console.log('    content:', text.trim().slice(0, 120) || '(empty - model may have spent the whole budget on reasoning)');
  if (r.status !== 200) fail('streaming request failed');
  if (!chunks) fail('no chunks received');
}

async function toolCall() {
  const r = await fetch(BASE + '/v1/chat/completions', {
    method: 'POST', headers: H,
    body: JSON.stringify({
      model: MODEL,
      messages: [{ role: 'user', content: 'What is the weather in Beijing right now? Use the tool.' }],
      tools: [{
        type: 'function',
        function: {
          name: 'get_weather',
          description: 'Get the current weather for a city',
          parameters: {
            type: 'object',
            properties: { city: { type: 'string', description: 'City name' } },
            required: ['city'],
          },
        },
      }],
      tool_choice: 'auto',
      max_tokens: 600,
    }),
  });
  const j = await r.json();
  const m = (j.choices && j.choices[0].message) || {};
  const finish = j.choices && j.choices[0].finish_reason;
  console.log('[4] tool calling ->', r.status, '| finish=' + finish);
  if (m.tool_calls) {
    console.log('    tool_calls:', m.tool_calls.map(t => t.function.name + '(' + t.function.arguments + ')').join(', '));
  } else {
    console.log('    no tool call; content:', String(m.content || '').trim().slice(0, 110));
    fail('model did not emit a tool call');
  }
}

(async () => {
  console.log('base :', BASE);
  console.log('model:', MODEL);
  console.log('');
  try { await listModels(); } catch (e) { fail('models: ' + e.message); }
  try { await nonStream(); } catch (e) { fail('non-streaming: ' + e.message); }
  try { await streaming(); } catch (e) { fail('streaming: ' + e.message); }
  try { await toolCall(); } catch (e) { fail('tools: ' + e.message); }
  console.log('');
  console.log(failures === 0 ? 'all checks passed' : failures + ' check(s) failed');
  process.exit(failures === 0 ? 0 : 1);
})();
