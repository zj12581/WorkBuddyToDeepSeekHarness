# Wiring the gateway into common clients

Every client below speaks the OpenAI chat protocol, so the settings are the same three
values. Only the labels differ.

| Setting | Value |
|---|---|
| Base URL / API host / endpoint | `http://127.0.0.1:8790/v1` |
| API key | your `--api-key` value (`workbuddy-local` in the examples) |
| Model | any id from `GET /v1/models` |

Start the gateway first, then add the provider:

```bash
node gateway.js --port 8790 --api-key workbuddy-local
```

---

## DeepSeek Harness

See the dedicated guide: [dsh.md](dsh.md). It covers reasoning-level declaration, which
matters because DSH validates that a model declaring thinking levels actually offers one.

## Cherry Studio

Settings → Model Providers → **Add**:

- Provider type: **OpenAI**
- API Host: `http://127.0.0.1:8790`
- API Key: `workbuddy-local`
- Models → **Add model** for each id you want (`hy4-preview`, `glm-5.3`, `deepseek-v4-flash`, …)

Cherry Studio appends `/v1/chat/completions` itself, so do not add `/v1` to the host.

## LobeChat

Settings → Language Model → **OpenAI**:

- API Proxy Address: `http://127.0.0.1:8790/v1` (LobeChat appends `/chat/completions`)
- API Key: `workbuddy-local`
- Model list: add the ids manually, or use the "fetch models" action — the gateway
  implements `GET /v1/models` for exactly this.

## NextChat

Settings → Custom Endpoint:

- API Endpoint: `http://127.0.0.1:8790`
- API Key: `workbuddy-local`
- Custom Model Names: `hy4-preview,glm-5.3,deepseek-v4-flash,kimi-k3` (comma separated)

## Open WebUI

Admin Settings → Connections → **OpenAI API**:

- Base URL: `http://127.0.0.1:8790/v1`
- API Key: `workbuddy-local`

Note: Open WebUI runs in a container by default, where `127.0.0.1` means the container
itself. Use `http://host.docker.internal:8790/v1` (Docker Desktop) or the host's LAN
address, and make sure the gateway binds an interface the container can reach. Binding
beyond loopback means anyone on that network can spend your quota — prefer keeping it on
loopback and running the client on the host.

## Any OpenAI SDK

```python
from openai import OpenAI

client = OpenAI(base_url="http://127.0.0.1:8790/v1", api_key="workbuddy-local")

stream = client.chat.completions.create(
    model="hy4-preview",
    messages=[{"role": "user", "content": "In one sentence, what is a CAN bus?"}],
    stream=True,
    max_tokens=2000,          # reasoning models need headroom before they write content
)
for chunk in stream:
    if chunk.choices and chunk.choices[0].delta.content:
        print(chunk.choices[0].delta.content, end="")
```

```javascript
const res = await fetch('http://127.0.0.1:8790/v1/chat/completions', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer workbuddy-local' },
  body: JSON.stringify({
    model: 'glm-5.3',
    messages: [{ role: 'user', content: 'In one sentence, what is a CAN bus?' }],
    max_tokens: 2000,
  }),
});
console.log((await res.json()).choices[0].message.content);
```

---

## Two things that trip people up

**Reasoning models and `max_tokens`.** Models with a separate reasoning channel
(`hy4-preview`, `hy4-preview-f`, `glm-5.3`, `glm-5.3-flash`, `kimi-k3`, `kimi-k2.7`,
`minimax-m2.7`, `auto`) think before answering. Give them room, or you get an empty
`content` with `finish_reason: "length"`. The matrix in the [README](../README.md) lists
which is which.

**Anonymous tool-role history.** When you replay a tool-calling conversation back into the
gateway, keep the `role: "tool"` messages and their `tool_call_id`s intact. The upstream
accepts them, and the gateway forwards them unchanged.
