'use strict';
/**
 * Upstream client. Talks to the local workbuddy-gateway over the OpenAI chat
 * protocol, which is also the protocol the upstream itself speaks.
 *
 * The gateway is an independent process; this extension owns none of the
 * credential handling. Without a reachable gateway there is simply no model.
 */

const DEFAULT_GATEWAY = 'http://127.0.0.1:8790';

function normalizeBase(raw) {
  let s = String(raw || '').trim();
  if (!s) return DEFAULT_GATEWAY;
  s = s.replace(/\/+$/, '');
  // Accept either the bare host or a host that already includes /v1.
  if (/\/v1$/i.test(s)) return s.slice(0, -3);
  return s;
}

class GatewayUnreachable extends Error {
  constructor(message) {
    super(message);
    this.name = 'GatewayUnreachable';
  }
}

/**
 * @param options { gatewayUrl, apiKey, fetchImpl }
 */
function createClient(options) {
  const impl = (options && options.fetchImpl) || globalThis.fetch;
  if (!impl) throw new Error('no fetch implementation available');
  const apiKey = (options && options.apiKey) || '';
  const base = normalizeBase(options && options.gatewayUrl);

  async function request(path, body, signal) {
    const headers = { 'Content-Type': 'application/json' };
    if (apiKey) headers['Authorization'] = 'Bearer ' + apiKey;
    let res;
    try {
      res = await impl(base + path, {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
        ...(signal ? { signal } : {}),
      });
    } catch (err) {
      throw new GatewayUnreachable(
        'cannot reach the gateway at ' + base + ' (' + (err && err.message ? err.message : err) + '). '
        + 'Start it with: node gateway.js --port <port>'
      );
    }
    return res;
  }

  return {
    base,

    /** GET /v1/models — returns [{ id, tier, ... }] */
    async listModels(signal) {
      const headers = {};
      if (apiKey) headers['Authorization'] = 'Bearer ' + apiKey;
      let res;
      try {
        res = await impl(base + '/v1/models', { method: 'GET', headers, ...(signal ? { signal } : {}) });
      } catch (err) {
        throw new GatewayUnreachable(
          'cannot reach the gateway at ' + base + ' (' + (err && err.message ? err.message : err) + ').'
        );
      }
      if (!res.ok) {
        throw new Error('gateway returned HTTP ' + res.status + ' while listing models');
      }
      const json = await res.json();
      return (json && json.data) ? json.data : [];
    },

    /**
     * Streaming chat completion.
     *
     * @param body      OpenAI request body (model, messages, tools, ...)
     * @param onEvent   called with parsed SSE payload objects
     * @param signal    AbortSignal
     */
    async streamChat(body, onEvent, signal) {
      const res = await request('/v1/chat/completions', { ...body, stream: true }, signal);
      if (!res.ok) {
        const text = await res.text().catch(() => '');
        let detail = text.slice(0, 300);
        try { detail = (JSON.parse(text).error || {}).message || detail; } catch { /* keep raw */ }
        const err = new Error('upstream HTTP ' + res.status + ': ' + detail);
        err.status = res.status;
        throw err;
      }
      if (!res.body) throw new Error('gateway returned an empty response body');

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      let usage = null;

      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });

          let idx;
          while ((idx = buffer.indexOf('\n')) >= 0) {
            const line = buffer.slice(0, idx).trim();
            buffer = buffer.slice(idx + 1);
            if (!line.startsWith('data:')) continue;
            const data = line.slice(5).trim();
            if (!data || data === '[DONE]') continue;

            let payload;
            try { payload = JSON.parse(data); } catch { continue; }
            if (payload.usage) usage = payload.usage;
            onEvent(payload);
          }
        }
        // flush a trailing partial line
        const rest = buffer + decoder.decode();
        if (rest.trim()) {
          const line = rest.trim();
          if (line.startsWith('data:')) {
            const data = line.slice(5).trim();
            if (data && data !== '[DONE]') {
              try {
                const payload = JSON.parse(data);
                if (payload.usage) usage = payload.usage;
                onEvent(payload);
              } catch { /* ignore */ }
            }
          }
        }
      } finally {
        try { await reader.cancel(); } catch { /* ignore */ }
      }
      return usage;
    },
  };
}

module.exports = { createClient, normalizeBase, GatewayUnreachable, DEFAULT_GATEWAY };
