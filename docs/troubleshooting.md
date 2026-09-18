# Troubleshooting

## `11128 Illegal API invocation from an unapproved channel`

```json
{"code":11128,"msg":"Illegal API invocation from an unapproved channel",
 "displayMsg":{"zh":"请求被安全策略拦截，请稍后重试或联系支持。"}}
```

This is the upstream content filter rejecting the *whole request*. In practice it almost
always fires on the compliance preamble an agent client injects into its system prompt —
a list of things the agent swears it will refuse ("DoS", "exploit", "credential testing",
"C2 frameworks", ...). The filter matches the vocabulary, not the intent.

What to check, in order:

1. **Is desensitization on?** `GET /health` reports `"desensitize": true`. If you started
   the gateway with `--no-desensitize`, that is your answer.
2. **Did the retry ladder run?** With `--debug`, the log shows
   `blocked by upstream security policy, retrying with heavier desensitization`. If the
   retry is missing, check that `"retryOnBlock"` is true.
3. **Reproduce it in isolation:**
   ```bash
   node probes/probe-block.js
   ```
   Five scenarios; all should print `OK:`. Compare against
   `node gateway.js --no-desensitize --no-retry` to see the failure mode.
4. **Still blocked?** The offending text is somewhere the desensitizer does not reach —
   most likely a tool-call result being echoed back, or a system message built from user
   content. Extend `SENSITIVE_TERMS` in `lib/core.js`, or send the exact failing request
   body (visible with `--debug`) in an issue.

Note that genuinely harmful *user* input is still blocked, by design. That is not a bug.

## `400 ... model [xxx] service info not found [11102]`

The model id does not exist upstream. Ids change without notice.

```bash
node probes/probe-models.js --json | grep -v '"exact": true'
```

Update the list in your config (`models`) and in your client, and consider opening a PR
with the refreshed matrix in the README.

## Empty answer with `finish_reason: "length"`

A reasoning model spent its entire output budget on the reasoning channel before writing
any content. Raise `max_tokens` for that request. This is most visible on
`hy4-preview`, `hy4-preview-f`, `glm-5.3`, `kimi-k3`, `kimi-k2.7` and `minimax-m2.7`.

## `no WorkBuddy/CodeBuddy auth file found`

The desktop client is not signed in, or the auth file lives somewhere unusual.

```bash
# what the gateway looks at
node -e "console.log(require('./lib/credentials').authFileCandidates().join('\n'))"
```

Sign in with the desktop client, or point at the file directly:

```bash
node gateway.js --auth-file "/path/to/workbuddy-desktop.info"
# or set WORKBUDDY_AUTH_FILE / "authFile" in config.json
```

## `token refresh failed`

The refresh token itself has expired or was invalidated (for example by signing out in
the desktop client, or signing in on too many devices). Sign in again in the desktop
client. The gateway picks the new session up automatically on the next request — no
restart needed.

## `401 invalid api key`

The client's key does not match `--api-key`. Either align them, or start the gateway with
no `--api-key` for keyless loopback use.

## `upstream unreachable: fetch failed`

Network-level failure: no route to the upstream host (proxy, VPN, firewall), or the
upstream itself is down. Test independently:

```bash
node probes/probe-models.js hy4-preview
```

If the probe works, the problem is between the gateway and the network — check
`WORKBUDDY_UPSTREAM` / `--upstream` if you routed it through a proxy.

## Tool calls work, but the model answers in prose instead

Make sure the request actually carries `tools`. Some clients drop tools when the model is
not marked as supporting them. Verify directly against the gateway with the tool-call
section of `tests/smoke-test.js` (check `[4] tool calling`).

## Streaming feels slow / the answer arrives all at once

By design. The gateway buffers an upstream stream before writing it out, so that a
mid-stream security rejection can be retried instead of emitting half an answer.
Time-to-first-byte is therefore close to total time. If you would rather trade that
guarantee for incremental output, stream straight through in `handleChat`
(`gateway.js`) and drop the retry path.

## The gateway stopped working after an upstream change

Upstream internals change without notice. Two places absorb most of it:

- `lib/core.js` — request shape (`PASSTHROUGH`), block detection (`BLOCK_RE`),
  desensitization word list.
- `gateway.js` — endpoints and headers (`/v2/chat/completions`,
  `/v2/plugin/auth/token/refresh`).

Capture what the upstream actually returned (run with `--debug`) and open an issue with
that output — the error envelope usually says exactly what it disliked.
