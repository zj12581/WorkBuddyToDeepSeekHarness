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

// ---------------------------------------------------------------------------
// Fix 1: prompt_cache_key
// ---------------------------------------------------------------------------

// A fake uid - never a real account id.
const UID_A = 'testuser-1234';
const UID_B = 'otheruser-9999';

test('buildPromptCacheKey: stable per account+conversation, distinct otherwise', () => {
  const a1 = core.buildPromptCacheKey(UID_A, 'conv-1');
  const a2 = core.buildPromptCacheKey(UID_A, 'conv-1');
  const a3 = core.buildPromptCacheKey(UID_A, 'conv-2');
  const b1 = core.buildPromptCacheKey(UID_B, 'conv-1');

  assert.strictEqual(a1, a2, 'same uid + same conversation must be stable across calls');
  assert.notStrictEqual(a1, a3, 'a different conversation must produce a different key');
  assert.notStrictEqual(a1, b1, 'a different account must never collide with another one');

  // Format: wb-<uid first 8 chars>-<16 hex chars>.
  assert.match(a1, /^wb-testuser-[0-9a-f]{16}$/);
  assert.match(b1, /^wb-otheruse-[0-9a-f]{16}$/);
});

test('buildPromptCacheKey: degrades gracefully when the uid is missing', () => {
  assert.match(core.buildPromptCacheKey('', 'conv-1'), /^wb---[0-9a-f]{16}$/);
  assert.match(core.buildPromptCacheKey(undefined, undefined), /^wb---[0-9a-f]{16}$/);
});

test('resolveConversationId: falls back to the first user message digest', () => {
  // No conversation field, no session header: the opening user message is the anchor.
  const payload = { messages: [{ role: 'system', content: 'be nice' }, { role: 'user', content: 'hello there' }] };
  const id = core.resolveConversationId(payload, '');

  assert.ok(id.startsWith('firstmsg-'), 'the fallback should be a firstmsg digest, got ' + id);
  assert.strictEqual(id, core.resolveConversationId(payload, ''), 'the digest must be stable');
  assert.notStrictEqual(id, core.resolveConversationId({ messages: [{ role: 'user', content: 'something else' }] }, ''));
});

test('resolveConversationId: conversations sharing a prefix share an id', () => {
  // Turn 1 and turn 2 of one conversation: identical head, different tail. The
  // opening user message stays at the head, so both turns must hash the same.
  const head = [
    { role: 'system', content: 'you are helpful' },
    { role: 'user', content: 'explain DNS' },
  ];
  const turn1 = { messages: [...head] };
  const turn2 = { messages: [...head, { role: 'assistant', content: 'DNS is ...' }, { role: 'user', content: 'and DHCP?' }] };

  assert.strictEqual(core.resolveConversationId(turn1, ''), core.resolveConversationId(turn2, ''),
    'later turns of one conversation must reuse the same cache key');
});

test('resolveConversationId: prefers body field, then session id, then metadata', () => {
  const withBody = { conversation_id: 'body-1', messages: [{ role: 'user', content: 'x' }] };
  assert.strictEqual(core.resolveConversationId(withBody, 'hdr-1'), 'body-1');
  assert.strictEqual(core.resolveConversationId({ conversationId: 'body-2' }, 'hdr-1'), 'body-2');

  assert.strictEqual(core.resolveConversationId({ messages: [{ role: 'user', content: 'x' }] }, 'hdr-1'), 'hdr-1');

  const withMeta = { metadata: { conversation_id: 'meta-1' }, messages: [{ role: 'user', content: 'x' }] };
  assert.strictEqual(core.resolveConversationId(withMeta, ''), 'meta-1');

  // Empty session id falls through instead of returning "".
  assert.strictEqual(core.resolveConversationId(withBody, undefined), 'body-1');
});

test('sessionIdFromHeaders: accepts every known spelling', () => {
  assert.strictEqual(core.sessionIdFromHeaders({ 'x-conversation-id': 'a' }), 'a');
  assert.strictEqual(core.sessionIdFromHeaders({ 'x-conversation-request-id': 'b' }), 'b');
  assert.strictEqual(core.sessionIdFromHeaders({ session_id: 'c' }), 'c');
  assert.strictEqual(core.sessionIdFromHeaders({ 'x-session-id': 'd' }), 'd');
  assert.strictEqual(core.sessionIdFromHeaders({ 'x-client-request-id': 'e' }), 'e');
  assert.strictEqual(core.sessionIdFromHeaders({ 'x-session-affinity': 'f' }), 'f');
  assert.strictEqual(core.sessionIdFromHeaders({ conversation_id: 'g' }), 'g');
  assert.strictEqual(core.sessionIdFromHeaders({}), '');
  assert.strictEqual(core.sessionIdFromHeaders(undefined), '');
  assert.strictEqual(core.sessionIdFromHeaders({ 'x-session-id': '   ' }), '', 'blank values are ignored');
});

test('injectPromptCacheKey: never overwrites a client-supplied key', () => {
  const body = { prompt_cache_key: 'client-owned' };
  core.injectPromptCacheKey(body, { messages: [] }, UID_A, 'sess-1');
  assert.strictEqual(body.prompt_cache_key, 'client-owned');
});

test('buildUpstreamBody: injects a prompt_cache_key derived from uid + conversation', () => {
  const payload = { model: 'auto', messages: [{ role: 'user', content: 'hi' }] };
  const body = core.buildUpstreamBody(payload, false, {
    desensitize: true, uid: UID_A, conversationId: 'conv-42',
  });
  assert.strictEqual(body.prompt_cache_key, core.buildPromptCacheKey(UID_A, 'conv-42'));

  // No conversation id at all: still gets a key, via the first user message.
  const bare = core.buildUpstreamBody(payload, false, { desensitize: true });
  assert.strictEqual(bare.prompt_cache_key, core.buildPromptCacheKey('', core.resolveConversationId(payload, '')));
});

// ---------------------------------------------------------------------------
// Fix 2: max_completion_tokens -> max_tokens
// ---------------------------------------------------------------------------

test('translateMaxCompletionTokens: a positive integer becomes max_tokens', () => {
  const body = { max_completion_tokens: 4096 };
  core.translateMaxCompletionTokens(body);
  assert.strictEqual(body.max_tokens, 4096);
  assert.strictEqual(body.max_completion_tokens, undefined, 'the alias must always be dropped');
});

test('translateMaxCompletionTokens: an explicit max_tokens wins and the alias is only dropped', () => {
  const body = { max_tokens: 512, max_completion_tokens: 4096 };
  core.translateMaxCompletionTokens(body);
  assert.strictEqual(body.max_tokens, 512, 'the explicit value must not be overwritten');
  assert.strictEqual(body.max_completion_tokens, undefined, 'the alias is dropped without being translated');
});

test('translateMaxCompletionTokens: zero, negative, fractional and non-numbers are not translated', () => {
  for (const bad of [0, -1, 12.5, '4096', null, NaN, Infinity]) {
    const body = { max_completion_tokens: bad };
    core.translateMaxCompletionTokens(body);
    assert.strictEqual(body.max_tokens, undefined, 'should not translate ' + JSON.stringify(bad));
    assert.strictEqual(body.max_completion_tokens, undefined, 'alias must still be dropped for ' + JSON.stringify(bad));
  }
});

test('translateMaxCompletionTokens: absent alias leaves the body untouched', () => {
  const body = { max_tokens: 100 };
  core.translateMaxCompletionTokens(body);
  assert.deepStrictEqual(body, { max_tokens: 100 });
});

// ---------------------------------------------------------------------------
// Fix 3: tool_choice normalization
// ---------------------------------------------------------------------------

test('normalizeToolChoice: "none" and {type:"none"} drop tool_choice, tools and functions', () => {
  const tools = [{ type: 'function', function: { name: 'f' } }];

  const a = { tool_choice: 'none', tools, functions: [{ name: 'legacy' }] };
  core.normalizeToolChoice(a);
  assert.strictEqual(a.tool_choice, undefined);
  assert.strictEqual(a.tools, undefined, 'tools must go too, otherwise the model may still call them');
  assert.strictEqual(a.functions, undefined);

  const b = { tool_choice: { type: 'none' }, tools };
  core.normalizeToolChoice(b);
  assert.strictEqual(b.tool_choice, undefined);
  assert.strictEqual(b.tools, undefined);
});

test('normalizeToolChoice: {type:"auto"|"required"} becomes the matching string', () => {
  const auto = { tool_choice: { type: 'auto' } };
  core.normalizeToolChoice(auto);
  assert.strictEqual(auto.tool_choice, 'auto');

  const required = { tool_choice: { type: 'required' } };
  core.normalizeToolChoice(required);
  assert.strictEqual(required.tool_choice, 'required');
});

test('normalizeToolChoice: a named function becomes its name string', () => {
  const a = { tool_choice: { type: 'function', function: { name: 'get_weather' } } };
  core.normalizeToolChoice(a);
  assert.strictEqual(a.tool_choice, 'get_weather');

  const b = { tool_choice: { name: 'search' } };
  core.normalizeToolChoice(b);
  assert.strictEqual(b.tool_choice, 'search');
});

test('normalizeToolChoice: a named function with no name falls back to "auto"', () => {
  const a = { tool_choice: { type: 'function', function: {} } };
  core.normalizeToolChoice(a);
  assert.strictEqual(a.tool_choice, 'auto');

  const b = { tool_choice: { type: 'function' } };
  core.normalizeToolChoice(b);
  assert.strictEqual(b.tool_choice, 'auto');

  // A malformed function payload counts as an empty name as well.
  const c = { tool_choice: { type: 'function', function: 42 } };
  core.normalizeToolChoice(c);
  assert.strictEqual(c.tool_choice, 'auto');
});

test('normalizeToolChoice: unrecognized shapes are dropped', () => {
  for (const bad of [{ type: 'bogus' }, {}, [], 123]) {
    const body = { tool_choice: bad };
    core.normalizeToolChoice(body);
    assert.strictEqual(body.tool_choice, undefined, 'should drop ' + JSON.stringify(bad));
  }
});

test('normalizeToolChoice: a plain string other than "none" is left alone', () => {
  for (const keep of ['auto', 'required', 'get_weather']) {
    const body = { tool_choice: keep };
    core.normalizeToolChoice(body);
    assert.strictEqual(body.tool_choice, keep);
  }
  assert.strictEqual(core.normalizeToolChoice({}).tool_choice, undefined, 'absent field stays absent');
});

test('buildUpstreamBody: applies the max_tokens and tool_choice fixes end to end', () => {
  const body = core.buildUpstreamBody({
    model: 'auto',
    messages: [{ role: 'user', content: 'hi' }],
    max_completion_tokens: 8000,
    tool_choice: { type: 'function', function: { name: 'get_weather' } },
    tools: [{ type: 'function', function: { name: 'get_weather' } }],
  }, false, { desensitize: true, uid: UID_A, conversationId: 'conv-1' });

  assert.strictEqual(body.max_tokens, 8000, 'the alias must reach the upstream as max_tokens');
  assert.strictEqual(body.max_completion_tokens, undefined);
  assert.strictEqual(body.tool_choice, 'get_weather', 'the upstream only accepts a string here');
  assert.ok(body.prompt_cache_key, 'a cache key must be present');
});

// ---------------------------------------------------------------------------
// reasoning_effort — "off" must be omitted, not forwarded
// ---------------------------------------------------------------------------

test('normalizeReasoningEffort: "off" and its synonyms are removed from the body', () => {
  // The DeepSeek V4 family answers 400 / 11150 invalid_reasoning_effort when the
  // literal string "off" reaches it, so the field has to go.
  for (const value of ['off', 'OFF', '  off  ', 'none', 'disabled', 'disable', 'false', 'no']) {
    const body = { model: 'deepseek-v4-flash', reasoning_effort: value };
    core.normalizeReasoningEffort(body);
    assert.strictEqual(body.reasoning_effort, undefined, JSON.stringify(value) + ' must be dropped');
  }
});

test('normalizeReasoningEffort: false and null are removed too', () => {
  for (const value of [false, null]) {
    const body = { reasoning_effort: value };
    core.normalizeReasoningEffort(body);
    assert.strictEqual(body.reasoning_effort, undefined);
  }
});

test('normalizeReasoningEffort: real levels pass through untouched', () => {
  for (const value of ['minimal', 'low', 'medium', 'high', 'xhigh', 'max']) {
    const body = { reasoning_effort: value };
    core.normalizeReasoningEffort(body);
    assert.strictEqual(body.reasoning_effort, value, value + ' must be forwarded');
  }
});

test('normalizeReasoningEffort: an absent field stays absent', () => {
  const body = { model: 'x' };
  core.normalizeReasoningEffort(body);
  assert.deepStrictEqual(Object.keys(body), ['model']);
});

test('buildUpstreamBody: reasoning_effort "off" never reaches the wire', () => {
  const off = core.buildUpstreamBody({
    model: 'deepseek-v4-flash',
    messages: [{ role: 'user', content: 'hi' }],
    reasoning_effort: 'off',
  }, false, { desensitize: true });
  assert.strictEqual(off.reasoning_effort, undefined, '"off" must not be forwarded');

  const high = core.buildUpstreamBody({
    model: 'deepseek-v4-flash',
    messages: [{ role: 'user', content: 'hi' }],
    reasoning_effort: 'high',
  }, false, { desensitize: true });
  assert.strictEqual(high.reasoning_effort, 'high', 'a real level must be forwarded');
});
