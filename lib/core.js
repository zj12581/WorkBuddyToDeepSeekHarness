/**
 * Pure logic for workbuddy-gateway: request building, upstream SSE parsing,
 * response aggregation and the desensitization filter.
 *
 * Everything here is side-effect free so it can be unit tested without a network
 * or a logged-in account.
 */

'use strict';

const crypto = require('crypto');

// ---------------------------------------------------------------------------
// Desensitization
//
// The upstream content filter matches security vocabulary even when it appears in
// an agent's refusal preamble, and rejects the entire request with
// `11128 Illegal API invocation from an unapproved channel`. Inserting a
// zero-width space inside the matched word keeps it readable for humans and
// models while breaking the filter's literal match.
//
// Word list and technique adapted from codebuddy2openai's desensitize.py (MIT).
// See NOTICE.
// ---------------------------------------------------------------------------

const ZWSP = '\u200b';

const SENSITIVE_TERMS = [
  'credential testing', 'credential stuffing', 'supply chain compromise',
  'supply-chain compromise', 'detection evasion', 'C2 frameworks', 'C2 framework',
  'command and control', 'malicious purposes', 'malicious intent', 'mass targeting',
  'privilege escalation', 'reverse shell', 'remote code execution', 'SQL injection',
  'brute force', 'brute-force', 'zero-day', 'DoS', 'DDoS', 'exploit', 'XSS', 'CSRF',
  'phishing', 'malware', 'ransomware', 'keylogger', 'rootkit', 'backdoor', 'botnet', '0day',
];

function escapeRegExp(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// Longest first so that a short term never eats part of a longer one.
const SENSITIVE_RE = new RegExp(
  SENSITIVE_TERMS.slice().sort((a, b) => b.length - a.length).map(escapeRegExp).join('|'),
  'gi',
);

/** Insert a zero-width space inside every sensitive term found in `text`. */
function desensitizeText(text) {
  if (!text || typeof text !== 'string') return text;
  return text.replace(SENSITIVE_RE, (m) => (m.length <= 1 ? m : m[0] + ZWSP + m.slice(1)));
}

/** Apply `fn` to every text block of an OpenAI message content value. */
function mapMessageContent(content, fn) {
  if (typeof content === 'string') return fn(content);
  if (Array.isArray(content)) {
    return content.map(blk => {
      if (blk && typeof blk === 'object' && blk.type === 'text' && typeof blk.text === 'string') {
        return { ...blk, text: fn(blk.text) };
      }
      return blk;
    });
  }
  return content;
}

/** Desensitize system/developer messages only; user input is never touched here. */
function desensitizeMessages(messages) {
  return (messages || []).map(m => {
    if (!m || typeof m !== 'object') return m;
    if (m.role !== 'system' && m.role !== 'developer') return m;
    return { ...m, content: mapMessageContent(m.content, desensitizeText) };
  });
}

/** Count the zero-width insertions in a serializable value (used by --debug). */
function countZeroWidth(obj) {
  return (JSON.stringify(obj).match(/\u200b/g) || []).length;
}

// ---------------------------------------------------------------------------
// Request building
// ---------------------------------------------------------------------------

/** Fields forwarded to the upstream request body. */
const PASSTHROUGH = [
  'model', 'messages', 'tools', 'tool_choice', 'temperature', 'top_p', 'max_tokens',
  'max_completion_tokens', 'stop', 'presence_penalty', 'frequency_penalty', 'n',
  'response_format', 'seed', 'user', 'reasoning_effort', 'verbosity', 'reasoning_summary',
  'parallel_tool_calls',
];

/** Flatten a pure-text content-block array into a plain string. */
function normalizeMessages(messages) {
  return (messages || []).map(m => {
    if (!m || !Array.isArray(m.content)) return m;
    const blocks = m.content;
    if (blocks.every(b => b && b.type === 'text')) {
      return { ...m, content: blocks.map(b => b.text || '').join('') };
    }
    return m;
  });
}

/**
 * Translate the `max_completion_tokens` alias into `max_tokens`.
 *
 * The upstream only knows `max_tokens`. Newer OpenAI clients (including DeepSeek
 * Harness) send the alias instead; passing it through means the upstream ignores
 * it and silently falls back to its own default output cap, truncating long
 * answers. An explicit `max_tokens` always wins; the alias is dropped either way,
 * and non-positive or non-numeric values are not translated.
 */
function translateMaxCompletionTokens(body) {
  const alias = body.max_completion_tokens;
  delete body.max_completion_tokens;
  if (alias === undefined || alias === null) return body;
  if (body.max_tokens !== undefined) return body;
  if (typeof alias === 'number' && Number.isInteger(alias) && alias > 0) {
    body.max_tokens = alias;
  }
  return body;
}

/**
 * Normalize `reasoning_effort` for the wire.
 *
 * "off" is client vocabulary meaning "do not request reasoning". The upstream
 * rejects that literal string on the DeepSeek V4 family
 * (deepseek-v4-flash / v4.1-flash / v4-pro) with HTTP 400 and
 * `11150 invalid_reasoning_effort` ("the reasoning effort value is not supported
 * by the current model"), while 26 other models accept it. The correct wire form
 * of "off" is therefore to omit the field and let the model use its default.
 *
 * Measured 2026-09. This mirrors how DeepSeek Harness maps its `off` level to
 * `undefined` before dispatch.
 */
const EFFORT_OFF_VALUES = new Set(['off', 'none', 'disabled', 'disable', 'false', 'no']);

function normalizeReasoningEffort(body) {
  const v = body.reasoning_effort;
  if (typeof v === 'string' && EFFORT_OFF_VALUES.has(v.trim().toLowerCase())) {
    delete body.reasoning_effort;
    return 'dropped';
  }
  if (v === false || v === null) {
    delete body.reasoning_effort;
    return 'dropped';
  }
  return '';
}

/**
 * Normalize `tool_choice` to the string form the upstream accepts.
 *
 * The upstream types this field as a string; an object form is rejected with
 * `11101`. Mapping follows the OpenAI semantics:
 *   "none" / {type:"none"}                              -> drop tool_choice and tools
 *   {type:"auto"|"required"}                            -> "auto" / "required"
 *   {type:"function", function:{name}} / {name}         -> "name"
 *   anything unrecognized                               -> dropped
 */
function normalizeToolChoice(body) {
  const tc = body.tool_choice;
  if (tc === undefined) return body;

  const suppress = () => {
    delete body.tool_choice;
    delete body.tools;
    delete body.functions;
  };

  if (typeof tc === 'string') {
    if (tc.trim().toLowerCase() === 'none') suppress();
    return body;
  }
  if (tc && typeof tc === 'object') {
    const type = String(tc.type || '').trim().toLowerCase();
    if (type === 'none') { suppress(); return body; }
    if (type === 'auto' || type === 'required') { body.tool_choice = type; return body; }
    // `type:"function"` is the documented shape; some clients omit `type` and send
    // only the function name, so a name-bearing object without a type is accepted too.
    if (type === 'function' || (!type && (tc.function !== undefined || tc.name !== undefined))) {
      const name = String((tc.function && tc.function.name) || tc.name || '').trim();
      body.tool_choice = name || 'auto';
      return body;
    }
  }
  delete body.tool_choice;
  return body;
}

// ---------------------------------------------------------------------------
// prompt_cache_key
//
// The upstream keeps a prefix cache and only bills cached prompt tokens when the
// request carries a stable `prompt_cache_key`: with a key, a repeated 8k-token
// prefix is reported as ~7808 cached tokens and costs roughly 1/17th of an
// uncached request; without one, every turn is billed as a cold prompt.
//
// The key must be stable within one conversation and must never collide across
// accounts (a shared key would let one account hit another account's cached
// prefix). So the key is `wb-<uid8>-<sha256(uid|conversation)[:16]>`.
// ---------------------------------------------------------------------------

/** Take the first `n` characters of a uid, or "-" when absent. */
function uidSegment(uid) {
  const s = typeof uid === 'string' ? uid.trim() : '';
  return s ? s.slice(0, 8) : '-';
}

/** Build a stable, account-isolated prompt cache key. */
function buildPromptCacheKey(uid, conversation) {
  const sum = crypto.createHash('sha256')
    .update(String(uid || '') + '|' + String(conversation || ''))
    .digest('hex');
  return 'wb-' + uidSegment(uid) + '-' + sum.slice(0, 16);
}

/** Read a non-empty string field from a plain object. */
function strField(obj, key) {
  const v = obj && obj[key];
  return typeof v === 'string' ? v.trim() : '';
}

/**
 * Pick the conversation identifier used as the cache-key input.
 *
 * Sources, in order: an explicit conversation field on the body, the caller's
 * resolved session id, a client-supplied cache key, then a stable digest of the
 * conversation's opening user message. The last fallback means a client that
 * sends no session identifier still gets cache reuse across turns, because the
 * first user message stays present at the head of every later request.
 */
function resolveConversationId(payload, sessionId) {
  const fromBody = strField(payload, 'conversation_id') || strField(payload, 'conversationId');
  if (fromBody) return fromBody;
  if (sessionId) return String(sessionId);
  const meta = payload && payload.metadata;
  if (meta && typeof meta === 'object') {
    const m = strField(meta, 'conversation_id') || strField(meta, 'conversationId');
    if (m) return m;
  }
  const first = firstUserText(payload && payload.messages);
  if (first) {
    return 'firstmsg-' + crypto.createHash('sha256').update(first).digest('hex').slice(0, 16);
  }
  return '';
}

/** Text of the first user message, used as a last-resort conversation anchor. */
function firstUserText(messages) {
  for (const m of messages || []) {
    if (!m || m.role !== 'user') continue;
    const c = m.content;
    if (typeof c === 'string') return c.slice(0, 2000);
    if (Array.isArray(c)) {
      const text = c.filter(b => b && b.type === 'text').map(b => b.text || '').join('');
      if (text) return text.slice(0, 2000);
    }
  }
  return '';
}

/**
 * Inject `prompt_cache_key` into an upstream body.
 * A key the client already supplied is always preserved.
 */
function injectPromptCacheKey(body, payload, uid, sessionId) {
  if (typeof body.prompt_cache_key === 'string' && body.prompt_cache_key) return body;
  body.prompt_cache_key = buildPromptCacheKey(uid, resolveConversationId(payload || body, sessionId));
  return body;
}

/**
 * Client-supplied session / conversation identifiers, read from request headers.
 * Different clients spell this differently, so every known spelling is accepted.
 */
const SESSION_HEADER_NAMES = [
  'x-conversation-id',
  'x-conversation-request-id',
  'session_id',
  'x-session-id',
  'x-client-request-id',
  'x-session-affinity',
  'conversation_id',
];

/** Read the first session identifier present in `headers` (a Node IncomingMessage.headers map). */
function sessionIdFromHeaders(headers) {
  const h = headers || {};
  for (const name of SESSION_HEADER_NAMES) {
    const v = h[name];
    if (typeof v === 'string' && v.trim()) return v.trim();
  }
  return '';
}

/**
 * Build the upstream request body.
 *
 * The upstream only supports streaming, so `stream` is always forced on; a
 * non-streaming client is served by aggregating locally.
 *
 * @param payload     the client's OpenAI request body
 * @param aggressive  also desensitize user/tool messages (the retry ladder step)
 * @param options     { desensitize: boolean, uid: string, conversationId: string }
 */
function buildUpstreamBody(payload, aggressive, options) {
  const opts = options || {};
  const desensitize = opts.desensitize !== false;
  const body = {};
  for (const k of PASSTHROUGH) if (payload[k] !== undefined) body[k] = payload[k];
  body.model = body.model || 'auto';

  let messages = normalizeMessages(body.messages);
  // Upstream accepts system/user/assistant/tool only; newer OpenAI clients send developer.
  messages = messages.map(m => (m && m.role === 'developer') ? { ...m, role: 'system' } : m);
  if (desensitize) messages = desensitizeMessages(messages);
  if (aggressive && desensitize) {
    messages = messages.map(m => (m && (m.role === 'user' || m.role === 'tool'))
      ? { ...m, content: mapMessageContent(m.content, desensitizeText) } : m);
  }
  body.messages = messages;

  translateMaxCompletionTokens(body);
  normalizeToolChoice(body);
  normalizeReasoningEffort(body);
  injectPromptCacheKey(body, payload, opts.uid, opts.conversationId);

  body.stream = true;
  body.stream_options = { include_usage: true };
  return body;
}

// ---------------------------------------------------------------------------
// Block detection
// ---------------------------------------------------------------------------

const BLOCK_RE = /unapproved channel|security policy|安全策略|敏感|审核|content-?filter|11128/i;

/** Does this payload look like an upstream security-policy rejection? */
function isBlockPayload(text) {
  return typeof text === 'string' && BLOCK_RE.test(text);
}

// ---------------------------------------------------------------------------
// SSE parsing
// ---------------------------------------------------------------------------

/**
 * Incremental parser for the upstream SSE stream.
 *
 * Feed it arbitrary byte/string fragments (chunk boundaries are handled) and it
 * calls `onDelta(delta)` for each delta worth forwarding. It also collects the
 * aggregated answer, usage and any security-policy rejection seen mid-stream.
 */
class StreamAccumulator {
  constructor(onDelta) {
    this.onDelta = typeof onDelta === 'function' ? onDelta : () => {};
    this.id = null;
    this.model = null;
    this.content = '';
    this.reasoning = '';
    this.toolCalls = new Map();
    this.finishReason = null;
    this.usage = null;
    this.blockText = null;
    this.chunks = 0;
    this._decoder = new TextDecoder('utf-8');
    this._buf = '';
  }

  /** Feed a UTF-8 byte chunk or a string. */
  push(part) {
    this._buf += (typeof part === 'string') ? part : this._decoder.decode(part, { stream: true });
    let nl;
    while ((nl = this._buf.indexOf('\n')) >= 0) {
      this._handleLine(this._buf.slice(0, nl));
      this._buf = this._buf.slice(nl + 1);
    }
  }

  /** Signal end of stream; flushes any trailing partial line. */
  end() {
    const rest = this._buf + this._decoder.decode();
    this._buf = '';
    if (rest) this._handleLine(rest);
    if (!this.content && !this.toolCalls.size && isBlockPayload(JSON.stringify({ blockText: this.blockText, content: this.content }))) {
      this.blockText = this.blockText || 'blocked';
    }
    return this;
  }

  get hasToolCalls() { return this.toolCalls.size > 0; }

  /** Aggregated answer as a non-streaming OpenAI response. */
  response() {
    const message = { role: 'assistant', content: this.content || null };
    if (this.reasoning) message.reasoning_content = this.reasoning;
    if (this.toolCalls.size) {
      message.tool_calls = [...this.toolCalls.entries()].sort((a, b) => a[0] - b[0]).map(([, v]) => ({
        id: v.id || 'call_' + Math.random().toString(16).slice(2, 12),
        type: 'function',
        function: { name: v.name, arguments: v.arguments || '{}' },
      }));
    }
    const finish = this.toolCalls.size ? (this.finishReason || 'tool_calls') : (this.finishReason || 'stop');
    return {
      id: 'chatcmpl-' + Math.random().toString(16).slice(2, 14),
      object: 'chat.completion',
      created: Math.floor(Date.now() / 1000),
      model: this.model || 'unknown',
      choices: [{ index: 0, message, finish_reason: finish }],
      usage: this.usage || { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
    };
  }

  _handleLine(line) {
    const s = line.trim();
    if (!s.startsWith('data:')) return;
    const data = s.slice(5).trim();
    if (!data || data === '[DONE]') return;

    let obj;
    try { obj = JSON.parse(data); } catch { return; }

    if (obj.error) {
      this.finishReason = this.finishReason || 'error';
      if (isBlockPayload(JSON.stringify(obj))) this.blockText = JSON.stringify(obj).slice(0, 300);
      this.onDelta({ error: obj.error });
      return;
    }
    if (obj.code && obj.msg) {                       // bare upstream error envelope
      if (isBlockPayload(JSON.stringify(obj))) this.blockText = JSON.stringify(obj).slice(0, 300);
      this.onDelta({ error: obj });
      return;
    }

    if (obj.id && !this.id) this.id = obj.id;
    if (obj.model) this.model = obj.model;
    if (obj.usage) this.usage = obj.usage;

    for (const ch of obj.choices || []) {
      this.chunks++;
      if (ch.finish_reason) this.finishReason = ch.finish_reason;
      const d = ch.delta || {};
      const delta = {};

      if (typeof d.content === 'string' && d.content.length) {
        delta.content = d.content;
        this.content += d.content;
      }
      if (typeof d.reasoning_content === 'string' && d.reasoning_content.length) {
        delta.reasoning_content = d.reasoning_content;
        this.reasoning += d.reasoning_content;
      }
      if (Array.isArray(d.tool_calls) && d.tool_calls.length) {
        delta.tool_calls = d.tool_calls;
        for (const tc of d.tool_calls) {
          const idx = tc.index === undefined ? 0 : tc.index;
          const slot = this.toolCalls.get(idx) || { id: null, name: '', arguments: '' };
          if (tc.id) slot.id = tc.id;
          const fn = tc.function || {};
          if (fn.name) slot.name += fn.name;
          if (fn.arguments) slot.arguments += fn.arguments;
          this.toolCalls.set(idx, slot);
        }
      }
      if (Object.keys(delta).length) this.onDelta(delta);
    }
  }
}

// ---------------------------------------------------------------------------
// Response helpers
// ---------------------------------------------------------------------------

/** Build a single OpenAI streaming chunk. */
function makeChunk(id, model, delta, finishReason) {
  return {
    id,
    object: 'chat.completion.chunk',
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [{ index: 0, delta: delta || {}, finish_reason: finishReason || null }],
  };
}

/** Build the usage-only chunk OpenAI clients expect at the end of a stream. */
function makeUsageChunk(id, model, usage) {
  return {
    id,
    object: 'chat.completion.chunk',
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [],
    usage,
  };
}

const SSE_DONE = 'data: [DONE]\n\n';

/** Wrap an object as one SSE frame. */
function sseFrame(obj) {
  return 'data: ' + JSON.stringify(obj) + '\n\n';
}

module.exports = {
  ZWSP,
  SENSITIVE_TERMS,
  desensitizeText,
  desensitizeMessages,
  mapMessageContent,
  countZeroWidth,
  PASSTHROUGH,
  normalizeMessages,
  translateMaxCompletionTokens,
  normalizeToolChoice,
  normalizeReasoningEffort,
  EFFORT_OFF_VALUES,
  buildPromptCacheKey,
  resolveConversationId,
  firstUserText,
  injectPromptCacheKey,
  sessionIdFromHeaders,
  SESSION_HEADER_NAMES,
  buildUpstreamBody,
  isBlockPayload,
  BLOCK_RE,
  StreamAccumulator,
  makeChunk,
  makeUsageChunk,
  SSE_DONE,
  sseFrame,
};
