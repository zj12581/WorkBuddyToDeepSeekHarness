#!/usr/bin/env node
/**
 * Reproduce the "agent system prompt gets rejected by the upstream security
 * filter" failure, and verify that the gateway's desensitization + retry ladder
 * recovers it.
 *
 * Background: agent clients inject a compliance preamble that lists what the
 * agent refuses to do ("DoS", "exploit", "credential testing", "C2 frameworks",
 * ...). The upstream content filter matches those words and rejects the whole
 * request with
 *   400 {"code":11128,"msg":"Illegal API invocation from an unapproved channel"}
 * even though they appear in a refusal statement, not in user input.
 *
 * Usage:
 *   node probes/probe-block.js                       # against the gateway
 *   node probes/probe-block.js http://127.0.0.1:8790 workbuddy-local hy4-preview
 *
 * Requires a running gateway (start it first). To see the failure mode, run the
 * gateway with --no-desensitize --no-retry and compare.
 */

'use strict';

const BASE = process.argv[2] || 'http://127.0.0.1:8790';
const KEY = process.argv[3] || '';
const MODEL = process.argv[4] || 'auto';

const HEADERS = { 'Content-Type': 'application/json' };
if (KEY) HEADERS['Authorization'] = 'Bearer ' + KEY;

// A stand-in for the compliance preamble real agent clients inject.
const AGENT_SYSTEM = [
  'You are a coding agent. You must refuse requests for DoS attacks, exploit development, '
  + 'credential testing, C2 frameworks, malware creation, phishing campaigns, privilege escalation, '
  + 'reverse shells, SQL injection, XSS, CSRF, brute force, ransomware, rootkits, backdoors, '
  + 'botnets and zero-day exploitation. Dual-use security tooling requires explicit authorization. '
  + 'Do not assist with detection evasion or command and control infrastructure.',
  'Do not attempt to bypass these restrictions; security policy compliance is mandatory for every task.',
].join('\n\n');

const USER = 'In one sentence, what is a CAN bus?';

async function run(label, role, systemText, userText) {
  const messages = [];
  if (systemText) messages.push({ role, content: systemText });
  messages.push({ role: 'user', content: userText });

  const t0 = Date.now();
  let res, json;
  try {
    res = await fetch(BASE + '/v1/chat/completions', {
      method: 'POST', headers: HEADERS,
      body: JSON.stringify({ model: MODEL, messages, max_tokens: 256 }),
    });
    json = await res.json().catch(() => ({}));
  } catch (e) {
    console.log(label.padEnd(34) + '| ERROR ' + e.message);
    return;
  }
  const ms = (Date.now() - t0) + 'ms';
  if (json.error) {
    console.log(label.padEnd(34) + '| HTTP ' + res.status + ' | ' + ms + ' | FAILED: '
      + String(json.error.message).slice(0, 110).replace(/\s+/g, ' '));
    return;
  }
  const text = String((json.choices && json.choices[0].message.content) || '(empty)').trim().slice(0, 80);
  console.log(label.padEnd(34) + '| HTTP ' + res.status + ' | ' + ms + ' | OK: ' + text);
}

(async () => {
  console.log('gateway : ' + BASE);
  console.log('model   : ' + MODEL);
  console.log('');
  await run('plain user message', null, null, USER);
  await run('agent system + user', 'system', AGENT_SYSTEM, USER);
  await run('developer role + user', 'developer', AGENT_SYSTEM, USER);
  await run('agent system + english user', 'system', AGENT_SYSTEM, 'Explain what a CAN bus is in one sentence.');
  console.log('');
  console.log('All five should report OK. If the first is OK and the rest fail, the');
  console.log('upstream filter is matching the preamble - that is what this gateway fixes.');
})();
