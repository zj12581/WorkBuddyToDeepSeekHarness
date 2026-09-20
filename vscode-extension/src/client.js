'use strict';
/**
 * Upstream client for the local workbuddy-gateway.
 *
 * Uses Node's native http module rather than global fetch on purpose: the VS Code
 * extension host honours platform proxy settings (http.proxySupport defaults to
 * "on"), so with a system proxy configured — even a disabled one — a request to
 * 127.0.0.1 can be handed to the proxy and fail with "fetch failed" while the
 * gateway is perfectly healthy. The native http module does not consult proxy
 * settings, which is exactly what we want for a loopback call.
 *
 * The gateway is a separate process the user runs. It holds the credentials and
 * owns all upstream protocol handling; this client just speaks OpenAI chat to it.
 */

const http = require('http');
const https = require('https');

const DEFAULT_GATEWAY = 'http://127.0.0.1:8790';

function normalizeBase(raw) {
  let s = String(raw || '').trim();
  if (!s) return DEFAULT_GATEWAY;
  s = s.replace(/\/+$/, '');
  if (/\/v1$/i.test(s)) return s.slice(0, -3);
  return s;
}

class GatewayUnreachable extends Error {
  constructor(message) {
    super(message);
    this.name = 'GatewayUnreachable';
  }
}

/** One raw request; resolves { status, body } or rejects on transport error. */
function rawRequest(urlStr, { method = 'GET', headers = {}, body = null, timeout = 0, signal } = {}) {
  return new Promise((resolve, reject) => {
    let u;
    try {
      u = new URL(urlStr);
    } catch (e) {
      reject(new Error('invalid gateway url: ' + urlStr));
      return;
    }
    const mod = u.protocol === 'https:' ? https : http;
    const opts = {
      protocol: u.protocol,
      hostname: u.hostname,
      port: u.port || (u.protocol === 'https:' ? 443 : 80),
      path: u.pathname + u.search,
      method,
      headers: body ? { ...headers, 'Content-Length': Buffer.byteLength(body) } : headers,
    };

    const req = mod.request(opts, (res) => {
      let data = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => resolve({ status: res.statusCode || 0, body: data, headers: res.headers }));
    });

    const onAbort = () => req.destroy(new Error('aborted'));
    if (signal) {
      if (signal.aborted) { onAbort(); return; }
      signal.addEventListener('abort', onAbort, { once: true });
    }
    const clear = () => { if (signal) signal.removeEventListener('abort', onAbort); };

    if (timeout > 0) {
      req.setTimeout(timeout, () => req.destroy(new Error('request timed out after ' + timeout + 'ms')));
    }
    req.on('error', (err) => { clear(); reject(err); });
    req.on('close', clear);

    if (body) req.write(body);
    req.end();
  });
}

function friendlyConnectError(base, err) {
  const detail = err && err.message ? err.message : String(err);
  return new GatewayUnreachable(
    'cannot reach the gateway at ' + base + ' (' + detail + ').\n'
    + 'Start it with:  node gateway.js --port ' + (new URL(base).port || 8790)
  );
}

/**
 * @param options { gatewayUrl, apiKey }
 */
function createClient(options) {
  const apiKey = (options && options.apiKey) || '';
  const base = normalizeBase(options && options.gatewayUrl);
  const authHeaders = () => (apiKey ? { Authorization: 'Bearer ' + apiKey } : {});

  return {
    base,

    /** GET /v1/models — returns [{ id, tier, ... }] */
    async listModels(signal) {
      let res;
      try {
        res = await rawRequest(base + '/v1/models', {
          method: 'GET',
          headers: { ...authHeaders() },
          timeout: 8000,
          signal,
        });
      } catch (err) {
        throw friendlyConnectError(base, err);
      }
      if (res.status !== 200) {
        throw new Error('gateway returned HTTP ' + res.status + ' while listing models');
      }
      try {
        const json = JSON.parse(res.body);
        return Array.isArray(json.data) ? json.data : [];
      } catch (e) {
        throw new Error('gateway returned a malformed model list');
      }
    },

    /**
     * Streaming chat completion over SSE.
     * @param body     OpenAI request body (model, messages, tools, ...)
     * @param onEvent  called with each parsed SSE payload object
     * @param signal   AbortSignal
     * @returns the final usage object, if the upstream sent one
     */
    async streamChat(body, onEvent, signal) {
      let u;
      try {
        u = new URL(base + '/v1/chat/completions');
      } catch (e) {
        throw new Error('invalid gateway url: ' + base);
      }
      const mod = u.protocol === 'https:' ? https : http;
      const payload = JSON.stringify({ ...body, stream: true });

      return new Promise((resolve, reject) => {
        const req = mod.request(
          {
            protocol: u.protocol,
            hostname: u.hostname,
            port: u.port || (u.protocol === 'https:' ? 443 : 80),
            path: u.pathname + u.search,
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'Accept': 'text/event-stream',
              'Content-Length': Buffer.byteLength(payload),
              ...authHeaders(),
            },
          },
          (res) => {
            const status = res.statusCode || 0;

            if (status !== 200) {
              let text = '';
              res.setEncoding('utf8');
              res.on('data', (c) => { text += c; });
              res.on('end', () => {
                let detail = text.slice(0, 300);
                try { detail = (JSON.parse(text).error || {}).message || detail; } catch { /* keep raw */ }
                const err = new Error('upstream HTTP ' + status + ': ' + detail);
                err.status = status;
                reject(err);
              });
              return;
            }

            let buffer = '';
            let usage = null;
            res.setEncoding('utf8');

            const handleLine = (lineRaw) => {
              const line = String(lineRaw).trim();
              if (!line.startsWith('data:')) return;
              const data = line.slice(5).trim();
              if (!data || data === '[DONE]') return;
              let payloadObj;
              try { payloadObj = JSON.parse(data); } catch { return; }
              if (payloadObj.usage) usage = payloadObj.usage;
              onEvent(payloadObj);
            };

            res.on('data', (chunk) => {
              buffer += chunk;
              let idx;
              while ((idx = buffer.indexOf('\n')) >= 0) {
                handleLine(buffer.slice(0, idx));
                buffer = buffer.slice(idx + 1);
              }
            });

            res.on('end', () => {
              if (buffer.trim()) handleLine(buffer);
              resolve(usage);
            });

            res.on('error', (err) => reject(err));
          }
        );

        const onAbort = () => req.destroy(new Error('aborted'));
        if (signal) {
          if (signal.aborted) { onAbort(); return; }
          signal.addEventListener('abort', onAbort, { once: true });
        }
        req.on('error', (err) => {
          // distinguish transport failures from upstream status errors
          if (err && err.message === 'aborted') { reject(err); return; }
          reject(friendlyConnectError(base, err));
        });
        req.setTimeout(0); // streaming: no overall timeout, user can Stop
        req.write(payload);
        req.end();
      });
    },
  };
}

module.exports = { createClient, normalizeBase, GatewayUnreachable, DEFAULT_GATEWAY, rawRequest };
