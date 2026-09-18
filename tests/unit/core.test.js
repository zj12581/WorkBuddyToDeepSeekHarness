/**
 * Unit tests for the gateway's pure logic. No network, no account required.
 *
 *   node --test tests/unit
 */

'use strict';

const test = require('node:test');
const assert = require('node:assert');

const core = require('../../lib/core');
const { StreamAccumulator } = core;

const ZWSP = '\u200b';

test('desensitizeText: inserts a zero-width space after the first character', () => {
  const input = 'Refuse requests for DoS attacks and exploit development.';
  const out = core.desensitizeText(input);
  assert.ok(out.includes(ZWSP), 'a zero-width space should have been inserted');
  assert.strictEqual(out.replace(new RegExp(ZWSP, 'g'), ''), input, 'visible text must be unchanged');
  // The break goes after the first character, so "DoS" -> "D<ZWSP>oS"
  // (and "DDoS" -> "D<ZWSP>DoS", since the alternation prefers the longer term).
  assert.ok(out.includes('D' + ZWSP + 'oS'), 'DoS should be broken after its first character');
  assert.ok(out.includes('e' + ZWSP + 'xploit'), 'exploit should be broken after its first character');
});

test('desensitizeText: never changes text with no sensitive term', () => {
  const clean = 'Please summarise this quarterly report.';
  assert.strictEqual(core.desensitizeText(clean), clean);
  assert.strictEqual(core.desensitizeText(''), '');
  assert.strictEqual(core.desensitizeText(undefined), undefined);
});

test('desensitizeText: matches case-insensitively and handles multi-word terms', () => {
  const out = core.desensitizeText('CREDENTIAL TESTING and privilege escalation are refused.');
  assert.ok(out.includes('C' + ZWSP + 'REDENTIAL TESTING'));
  assert.ok(out.includes('p' + ZWSP + 'rivilege escalation'));
});

test('desensitizeText: a longer term wins over a shorter one inside it', () => {
  // "C2 frameworks" must not be matched as a bare "C2"; note that "zero-day" and
  // the "0day" alternative can both contribute, so assert on the visible text
  // rather than on an exact insertion count.
  const input = 'C2 frameworks and zero-day exploits.';
  const out = core.desensitizeText(input);
  assert.strictEqual(out.replace(new RegExp(ZWSP, 'g'), ''), input, 'visible text must be unchanged');
  assert.ok(out.includes('C' + ZWSP + '2 frameworks'), 'the long term should be broken at its start');
  assert.ok(out.includes('z' + ZWSP + 'ero-day'), 'zero-day should be broken at its start');
});

test('desensitizeMessages: only system/developer messages are touched', () => {
  const messages = [
    { role: 'system', content: 'Refuse DoS attacks.' },
    { role: 'developer', content: 'No exploit development.' },
    { role: 'user', content: 'explain DoS attacks' },
    { role: 'assistant', content: 'exploit' },
  ];
  const out = core.desensitizeMessages(messages);
  assert.ok(out[0].content.includes(ZWSP), 'system should be desensitized');
  assert.ok(out[1].content.includes(ZWSP), 'developer should be desensitized');
  assert.strictEqual(out[2].content, 'explain DoS attacks', 'user input must be untouched');
  assert.strictEqual(out[3].content, 'exploit', 'assistant history must be untouched');
});

test('desensitizeMessages: handles content-block arrays and leaves non-text blocks alone', () => {
  const messages = [{
    role: 'system',
    content: [
      { type: 'text', text: 'Refuse DoS attacks.' },
      { type: 'image_url', image_url: { url: 'http://example.invalid/x.png' } },
    ],
  }];
  const out = core.desensitizeMessages(messages);
  assert.ok(out[0].content[0].text.includes(ZWSP));
  assert.deepStrictEqual(out[0].content[1], { type: 'image_url', image_url: { url: 'http://example.invalid/x.png' } });
});

test('isBlockPayload: recognises the upstream security rejection', () => {
  assert.ok(core.isBlockPayload('{"code":11128,"msg":"Illegal API invocation from an unapproved channel"}'));
  assert.ok(core.isBlockPayload('{"message":"The request was blocked by security policy."}'));
  assert.ok(core.isBlockPayload('请求被安全策略拦截，请稍后重试'));
  assert.ok(!core.isBlockPayload('{"id":"cmb-1","choices":[]}'));
  assert.ok(!core.isBlockPayload(''));
  assert.ok(!core.isBlockPayload(undefined));
});

test('buildUpstreamBody: forwards only whitelisted fields and always streams', () => {
  const body = core.buildUpstreamBody({
    model: 'glm-5.3',
    messages: [{ role: 'user', content: 'hi' }],
    stream: false,
    temperature: 0.2,
    top_p: 0.9,
    max_tokens: 100,
    some_unknown_field: 'drop me',
    api_key: 'must not leak',
  }, false, { desensitize: true });

  assert.strictEqual(body.model, 'glm-5.3');
  assert.strictEqual(body.stream, true);
  assert.deepStrictEqual(body.stream_options, { include_usage: true });
  assert.strictEqual(body.temperature, 0.2);
  assert.strictEqual(body.top_p, 0.9);
  assert.strictEqual(body.max_tokens, 100);
  assert.strictEqual(body.some_unknown_field, undefined);
  assert.strictEqual(body.api_key, undefined);
});

test('buildUpstreamBody: defaults the model and downgrades developer to system', () => {
  const body = core.buildUpstreamBody({
    messages: [{ role: 'developer', content: 'be nice' }, { role: 'user', content: 'hi' }],
  }, false, { desensitize: true });
  assert.strictEqual(body.model, 'auto');
  assert.strictEqual(body.messages[0].role, 'system');
});

test('buildUpstreamBody: flattens pure-text content blocks', () => {
  const body = core.buildUpstreamBody({
    model: 'auto',
    messages: [{ role: 'user', content: [{ type: 'text', text: 'a' }, { type: 'text', text: 'b' }] }],
  }, false, { desensitize: true });
  assert.strictEqual(body.messages[0].content, 'ab');
});

test('buildUpstreamBody: aggressive mode also desensitizes user messages', () => {
  const payload = { model: 'auto', messages: [{ role: 'user', content: 'tell me about exploit development' }] };

  const normal = core.buildUpstreamBody(payload, false, { desensitize: true });
  assert.strictEqual(normal.messages[0].content, 'tell me about exploit development');

  const aggressive = core.buildUpstreamBody(payload, true, { desensitize: true });
  assert.ok(aggressive.messages[0].content.includes(ZWSP));
});

test('buildUpstreamBody: desensitize=false leaves everything alone', () => {
  const body = core.buildUpstreamBody({
    model: 'auto',
    messages: [{ role: 'system', content: 'Refuse DoS attacks.' }],
  }, true, { desensitize: false });
  assert.strictEqual(body.messages[0].content, 'Refuse DoS attacks.');
});

// ---------------------------------------------------------------------------
// SSE parsing
// ---------------------------------------------------------------------------

const sse = (obj) => 'data: ' + JSON.stringify(obj) + '\n\n';

test('StreamAccumulator: assembles content, reasoning, usage and finish reason', () => {
  const deltas = [];
  const acc = new StreamAccumulator(d => deltas.push(d));

  acc.push(sse({ id: 'x', model: 'glm-5.3', choices: [{ index: 0, delta: { role: 'assistant', content: '' } }] }));
  acc.push(sse({ choices: [{ index: 0, delta: { reasoning_content: 'think ' } }] }));
  acc.push(sse({ choices: [{ index: 0, delta: { content: 'Hello' } }] }));
  acc.push(sse({ choices: [{ index: 0, delta: { content: ' world' } }] }));
  acc.push(sse({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 5, completion_tokens: 2, total_tokens: 7 } }));
  acc.push('data: [DONE]\n\n');
  acc.end();

  assert.strictEqual(acc.content, 'Hello world');
  assert.strictEqual(acc.reasoning, 'think ');
  assert.strictEqual(acc.finishReason, 'stop');
  assert.deepStrictEqual(acc.usage, { prompt_tokens: 5, completion_tokens: 2, total_tokens: 7 });
  assert.strictEqual(acc.model, 'glm-5.3');
  assert.ok(deltas.some(d => d.content === 'Hello'));
  assert.ok(deltas.some(d => d.reasoning_content === 'think '));
});

test('StreamAccumulator: tolerates arbitrary chunk boundaries', () => {
  const wire = sse({ model: 'auto', choices: [{ index: 0, delta: { content: 'split-safe' } }] })
    + sse({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] })
    + 'data: [DONE]\n\n';

  // Feed one byte at a time: the worst possible fragmentation.
  const acc = new StreamAccumulator(() => {});
  for (const ch of Buffer.from(wire, 'utf8')) acc.push(Buffer.from([ch]));
  acc.end();

  assert.strictEqual(acc.content, 'split-safe');
  assert.strictEqual(acc.finishReason, 'stop');
});

test('StreamAccumulator: reassembles tool calls split across chunks', () => {
  const acc = new StreamAccumulator(() => {});
  acc.push(sse({ choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: 'call_1', function: { name: 'get_weather', arguments: '{"ci' } }] } }] }));
  acc.push(sse({ choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: 'ty":"Beijing"}' } }] } }] }));
  acc.push(sse({ choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] }));
  acc.end();

  const out = acc.response();
  const tc = out.choices[0].message.tool_calls;
  assert.strictEqual(tc.length, 1);
  assert.strictEqual(tc[0].id, 'call_1');
  assert.strictEqual(tc[0].function.name, 'get_weather');
  assert.strictEqual(tc[0].function.arguments, '{"city":"Beijing"}');
  assert.strictEqual(out.choices[0].finish_reason, 'tool_calls');
});

test('StreamAccumulator: keeps parallel tool calls separate by index', () => {
  const acc = new StreamAccumulator(() => {});
  acc.push(sse({ choices: [{ index: 0, delta: { tool_calls: [
    { index: 0, id: 'a', function: { name: 'one', arguments: '{}' } },
    { index: 1, id: 'b', function: { name: 'two', arguments: '{}' } },
  ] } }] }));
  acc.end();

  const tc = acc.response().choices[0].message.tool_calls;
  assert.deepStrictEqual(tc.map(t => t.function.name), ['one', 'two']);
});

test('StreamAccumulator: flags a security rejection delivered mid-stream', () => {
  const acc = new StreamAccumulator(() => {});
  acc.push('data: {"code":11128,"msg":"Illegal API invocation from an unapproved channel"}\n\n');
  acc.end();
  assert.ok(acc.blockText, 'blockText should be set');
  assert.ok(acc.blockText.includes('11128'));
});

test('StreamAccumulator: ignores malformed frames instead of throwing', () => {
  const acc = new StreamAccumulator(() => {});
  acc.push('data: {not json}\n\n');
  acc.push(': keep-alive comment\n\n');
  acc.push('data: [DONE]\n\n');
  acc.end();
  assert.strictEqual(acc.content, '');
  assert.strictEqual(acc.finishReason, null);
});

test('StreamAccumulator: reports a normal error frame through onDelta', () => {
  const seen = [];
  const acc = new StreamAccumulator(d => seen.push(d));
  acc.push('data: {"error":{"message":"upstream exploded","type":"upstream_error"}}\n\n');
  acc.end();
  assert.strictEqual(seen.length, 1);
  assert.strictEqual(seen[0].error.message, 'upstream exploded');
  assert.strictEqual(acc.finishReason, 'error');
});

test('response(): produces an OpenAI-shaped non-streaming body', () => {
  const acc = new StreamAccumulator(() => {});
  acc.push(sse({ model: 'kimi-k3', choices: [{ index: 0, delta: { content: 'hi' } }] }));
  acc.end();

  const out = acc.response();
  assert.strictEqual(out.object, 'chat.completion');
  assert.strictEqual(out.model, 'kimi-k3');
  assert.strictEqual(out.choices[0].message.role, 'assistant');
  assert.strictEqual(out.choices[0].message.content, 'hi');
  assert.strictEqual(out.choices[0].finish_reason, 'stop');
  assert.deepStrictEqual(out.usage, { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 });
});

test('makeChunk / makeUsageChunk / sseFrame: emit parseable OpenAI frames', () => {
  const chunk = core.makeChunk('id1', 'auto', { content: 'x' });
  assert.strictEqual(chunk.object, 'chat.completion.chunk');
  assert.strictEqual(chunk.choices[0].delta.content, 'x');
  assert.strictEqual(chunk.choices[0].finish_reason, null);

  const usage = core.makeUsageChunk('id1', 'auto', { total_tokens: 3 });
  assert.deepStrictEqual(usage.choices, []);
  assert.strictEqual(usage.usage.total_tokens, 3);

  const frame = core.sseFrame(chunk);
  assert.ok(frame.startsWith('data: '));
  assert.ok(frame.endsWith('\n\n'));
  assert.deepStrictEqual(JSON.parse(frame.slice(6).trim()), chunk);
  assert.strictEqual(core.SSE_DONE, 'data: [DONE]\n\n');
});
