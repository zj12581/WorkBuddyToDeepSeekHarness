# workbuddy-gateway

**Expose a locally logged-in WorkBuddy / CodeBuddy account as an OpenAI-compatible API — one file, zero dependencies.**

[中文说明](README.zh.md) · [DeepSeek Harness integration](docs/dsh.md) · [Troubleshooting](docs/troubleshooting.md)

```
any OpenAI-compatible client (DeepSeek Harness, Cherry Studio, LobeChat, ...)
        │  POST http://127.0.0.1:8790/v1/chat/completions
        ▼
  gateway.js  ── reads the desktop client's session, refreshes it, normalizes the stream
        │  POST https://copilot.tencent.com/v2/chat/completions   (OpenAI chat protocol)
        ▼
  WorkBuddy backend  (Hunyuan / GLM / Kimi / MiniMax / DeepSeek)
```

## Why this one

There are already several proxy projects for the same subscription ([list in NOTICE](NOTICE)). This one is different in three ways:

| | |
|---|---|
| **Zero dependencies, no build** | `node gateway.js` and you are done. No Docker, no Go toolchain, no `pip install`. Node ≥ 18 only, using the built-in `fetch`. |
| **Built against a real agent, not just curl** | Agent clients inject a compliance preamble ("refuse DoS / exploit / credential testing / C2 frameworks …"). The upstream content filter matches those words and rejects the whole request with `11128 Illegal API invocation from an unapproved channel`. This gateway desensitizes that preamble and retries — see [why](#the-problem-this-actually-solves). |
| **A reproducible capability matrix** | `probes/` measures which model ids the account really serves and which of them emit a separate reasoning channel. Facts you can re-run, not documentation copied from a blog post. |

## Quick start

Requires: the WorkBuddy / CodeBuddy **desktop client, signed in** (that is where the session lives), and Node ≥ 18.

```bash
git clone https://github.com/zj12581/WorkBuddyToDeepSeekHarness.git
cd WorkBuddyToDeepSeekHarness

# 1. real end-to-end check: models, non-streaming, streaming, native tool calls
node tests/smoke-test.js

# 2. run it
node gateway.js --port 8790 --api-key workbuddy-local
```

Then point any OpenAI-compatible client at:

- **Base URL** `http://127.0.0.1:8790/v1`
- **API key** whatever you passed to `--api-key` (or leave both empty for keyless local use)
- **Model** one of the ids from `GET /v1/models`

Working example for DeepSeek Harness: [`docs/dsh.md`](docs/dsh.md).

### Verify without a client

```bash
curl -s http://127.0.0.1:8790/v1/models -H "Authorization: Bearer workbuddy-local"

curl -s http://127.0.0.1:8790/v1/chat/completions \
  -H "Authorization: Bearer workbuddy-local" -H "Content-Type: application/json" \
  -d '{"model":"hy4-preview","messages":[{"role":"user","content":"In one sentence, what is a CAN bus?"}]}'
```

## Endpoints

| Method | Path | Notes |
|---|---|---|
| `GET` | `/v1/models` | the configured model list |
| `POST` | `/v1/chat/completions` | streaming and non-streaming, native `tools` / `tool_calls` |
| `GET` | `/health` | session state (identity fields redacted by default) |

Also accepts `/models` and `/chat/completions` without the `/v1` prefix.

## The problem this actually solves

An agent client sends something like this as its system prompt:

> You must refuse requests for **DoS** attacks, **exploit** development, **credential testing**, **C2 frameworks**, **malware** creation, … **privilege escalation**, **reverse shells**, **SQL injection** …

The upstream filters on those literal words and answers:

```json
{"code":11128,"msg":"Illegal API invocation from an unapproved channel",
 "displayMsg":{"zh":"请求被安全策略拦截，请稍后重试或联系支持。"}}
```

The refusal statement is being read as the malicious request. This gateway:

1. **Desensitizes** `system` / `developer` messages: inserts a zero-width space inside each matched term (`DoS` → `D<U+200B>oS`). Invisible to humans and models, fatal to a literal keyword match. User input is never rewritten by this step.
2. **Retries once** with heavier desensitization (user/tool messages included) if the upstream still rejects it.
3. **Normalizes `developer` → `system`**, because the upstream only accepts `system`/`user`/`assistant`/`tool` while newer OpenAI clients send `developer`.

Reproduce the failure and the fix:

```bash
node gateway.js --no-desensitize --no-retry   # terminal 1: the failure mode
node probes/probe-block.js                    # terminal 2: watch the preamble get rejected

node gateway.js                               # terminal 1: the fix
node probes/probe-block.js                    # terminal 2: all five cases pass
```

## Capability matrix

Observed on 2026-09 with a CN account. **This table is data, not documentation** — re-run `node probes/probe-models.js` and `node probes/probe-thinking.js` to refresh it. Upstream ids change without notice.

| Model id | Available | Separate reasoning channel | Notes |
|---|---|---|---|
| `auto` | ✅ | ✅ | resolves to `hy4-preview-f` upstream |
| `hy4-preview` | ✅ | ✅ | Hunyuan |
| `hy4-preview-f` | ✅ | ✅ | fast variant |
| `hy3` | ✅ | ❌ | |
| `hy3-preview` | ✅ | ❌ | |
| `hy3-preview-agent` | ✅ | ❌ | agent-tuned; only probed, not exercised by an agent |
| `glm-5.3` | ✅ | ✅ | |
| `glm-5.3-flash` | ✅ | ✅ | |
| `glm-5.2` | ✅ | ❌ | 1M context per vendor docs |
| `glm-5.1` | ✅ | ❌ | |
| `glm-5v-turbo` | ✅ | ❌ | multimodal |
| `kimi-k3` | ✅ | ✅ | |
| `kimi-k2.7` | ✅ | ✅ | |
| `kimi-k2.6` | ✅ | ❌ | |
| `kimi-k2.5` | ✅ | ❌ | |
| `minimax-m3` | ✅ | ❌ | multimodal |
| `minimax-m2.7` | ✅ | ✅ | |
| `deepseek-v4-pro` | ✅ | ❌ | 1M context per vendor docs |
| `deepseek-v4-flash` | ✅ | ❌ | 1M context per vendor docs |
| `deepseek-v3.2` | ✅ | ❌ | |

Ids that do **not** exist (the upstream answers `11102 service info not found`): `hy4`, `hy4-preview-agent`, `hy3-preview-f`, `hunyuan`, `hunyuan-turbo`, `kimi-k2.7-code`.

Two practical consequences:

- A model with **no** reasoning channel must be declared non-reasoning in your client. Otherwise the client sends `reasoning_effort` that the model ignores, and any "thinking" the client displays is fabricated by the client, not the model.
- A model **with** a reasoning channel spends its output budget on reasoning first. If `max_tokens` is too small the answer comes back empty with `finish_reason: "length"` — pass a generous budget for reasoning models.

## Configuration

Priority: CLI flags / environment → config file → built-in defaults.

```bash
node gateway.js \
  --port 8790 --host 127.0.0.1 \
  --api-key workbuddy-local \
  --config ~/.workbuddy-gateway/config.json \
  --log ./logs/gateway.log \
  --debug
```

Start from [`config.example.json`](config.example.json). Environment equivalents: `WORKBUDDY_GATEWAY_PORT`, `WORKBUDDY_GATEWAY_API_KEY`, `WORKBUDDY_GATEWAY_HOST`, `WORKBUDDY_GATEWAY_CONFIG`, `WORKBUDDY_GATEWAY_LOG`, `WORKBUDDY_GATEWAY_DEBUG`, `WORKBUDDY_MODELS`, `WORKBUDDY_UPSTREAM`, `WORKBUDDY_AUTH_FILE`.

| Flag | Effect |
|---|---|
| `--no-desensitize` | disable the system-prompt filter rewrite (useful to demonstrate the failure) |
| `--no-retry` | disable the block-retry ladder |
| `--expose-identity` | include `nickname` / `uid` in `GET /health` (off by default) |
| `--model-list a,b,c` | replace the served model list |

## How it works

- **Session discovery.** The desktop client stores its session in a platform-specific app data directory. The gateway looks in the known locations (Windows / macOS / Linux, several fallbacks) and prefers a `workbuddy*` file. Override with `authFile` / `WORKBUDDY_AUTH_FILE`.
- **Token refresh.** Before each request the access token is checked; with under 60s left it is refreshed via the client's own refresh endpoint and written back atomically, exactly as the desktop client does. The desktop client and the gateway can therefore run side by side without invalidating each other.
- **Always streaming upstream.** The upstream only supports `stream: true`. The gateway always requests a stream and aggregates locally when the client asked for a non-streaming response.
- **Buffered before written.** A streaming answer is buffered until the upstream stream ends, so a mid-stream security rejection can be retried instead of emitting half an answer.
- **Reasoning passthrough.** `delta.reasoning_content` is forwarded as `reasoning_content`, which clients that understand it (DeepSeek Harness, for one) render as a thinking channel.

## Layout

```
gateway.js              the server (config, HTTP routes, retry ladder)
lib/core.js             pure logic: desensitization, request building, SSE parsing
lib/credentials.js      session discovery, token refresh, upstream headers
probes/probe-models.js  which model ids the account really serves
probes/probe-thinking.js which models emit a reasoning channel
probes/probe-reasoning.js how the upstream reacts to reasoning_effort
probes/probe-limits.js  which max_tokens values are accepted (weak signal, see file header)
probes/probe-block.js   reproduce the security-filter rejection and verify the fix
tests/unit/             offline unit tests for lib/core.js
tests/smoke-test.js     live end-to-end check against a running gateway
docs/                   DeepSeek Harness integration, client setup, troubleshooting
```

## Running it in the background

`--detach` re-launches the gateway detached from the current shell and prints the PID:

```bash
node gateway.js --port 8790 --api-key workbuddy-local --log ./logs/gateway.log --detach
# [workbuddy-gateway] detached, pid 29396 (pid file: ./logs/gateway.pid)
```

Stop it with the printed command (`taskkill /PID <pid> /T /F` on Windows, `kill <pid>` elsewhere).

To start it at login, use the platform's own mechanism rather than a wrapper script:

- **Linux** — a `systemd --user` unit (`~/.config/systemd/user/workbuddy-gateway.service`) with
  `ExecStart=/usr/bin/node /path/to/gateway.js --log %h/.workbuddy-gateway/gateway.log`, then
  `systemctl --user enable --now workbuddy-gateway`.
- **macOS** — a `launchd` agent in `~/Library/LaunchAgents/` running the same command.
- **Windows** — Task Scheduler: create a task with trigger "At log on" and action
  `node C:\path\to\gateway.js --log C:\path\to\logs\gateway.log`.

## Tests

```bash
node --test tests/unit/core.test.js   # offline, no account needed
node tests/smoke-test.js              # live, requires a running gateway
```

## Security

- Binds `127.0.0.1` by default. **Do not expose it to a network** — whoever can reach the port can spend your account's quota and read your session's output.
- The auth file is equivalent to full control of the account. Keep it out of version control (`.gitignore` already covers `*.info`, `auths/`, `logs/`).
- Logs can contain full prompts and answers. They stay local and are never sent anywhere by this project.
- This project makes no outbound request other than to the configured upstream. There is no telemetry and no analytics.

## Legal and compliance boundary

This is **unofficial** software. It is not affiliated with, endorsed by, or supported by Tencent, CodeBuddy or WorkBuddy.

- Use it **only with an account you personally own and are authorized to use**, on your own machine or in a private environment.
- Reusing a desktop login session through a proxy may conflict with the upstream platform's terms of service. Account restrictions or bans are possible. **You accept that risk.**
- Do not share, resell, redistribute or publicly host the resulting endpoint, and do not use it to circumvent the upstream's content policy for genuinely harmful input. The desensitization feature exists to stop *refusal statements* from being misread, not to smuggle disallowed requests through.
- The software is provided "as is", without warranty of any kind. The authors are not liable for account suspension, data loss, or any other consequence of use.

Upstream protocols and model ids change without notice. If this stops working, the fix usually lives in `lib/core.js` (request shape) or `probes/` (model list).

## License

MIT — see [LICENSE](LICENSE). Third-party credits in [NOTICE](NOTICE).
