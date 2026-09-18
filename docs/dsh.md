# Using the gateway with DeepSeek Harness

[DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (DSH) can route model
requests through any OpenAI-compatible endpoint. Its `llm-pi-ai` plugin takes a
`providers` dictionary in `~/.dsh/settings.yaml`, which is all you need.

Everything below was verified end-to-end: a real agent task (create a file, read it back
with a shell tool, report the result) ran on `hy4-preview` through this gateway.

## 1. Start the gateway

```bash
node gateway.js --port 8790 --api-key workbuddy-local
```

Leave it running. DSH re-reads provider configuration per request, so you can change
settings without restarting DSH — but the gateway itself must be up.

## 2. Store the API key

DSH resolves `apiKeyEnv` through its credential store, so the key never has to sit in
`settings.yaml`. Add it to `~/.dsh/.credentials.yaml`:

```yaml
version: 1
refs:
  WORKBUDDY_GATEWAY_API_KEY: workbuddy-local
```

(The reference name is arbitrary; it just has to match `apiKeyEnv` below.)

## 3. Declare the provider

Merge this into the `llm-pi-ai` section of `~/.dsh/settings.yaml`:

```yaml
llm-pi-ai:
  providers:
    workbuddy:
      displayName: WorkBuddy (local gateway)
      api: openai-completions
      apiKeyEnv: WORKBUDDY_GATEWAY_API_KEY
      baseURL: http://127.0.0.1:8790/v1
      models:
        # Reasoning models: declare the thinking levels the model actually has.
        # The value is what gets sent as `reasoning_effort`. `off` sends that field,
        # so map it to a value the upstream ignores rather than leaving it empty.
        - id: hy4-preview
          name: Hunyuan Hy4 (WorkBuddy)
          contextWindow: 262144
          reasoningEfforts: &wbThinking
            off: 'off'
            minimal: minimal
            low: low
            medium: medium
            high: high
            xhigh: high

        - id: hy4-preview-f
          name: Hunyuan Hy4 Fast (WorkBuddy)
          contextWindow: 262144
          reasoningEfforts: *wbThinking

        - id: glm-5.3
          name: GLM-5.3 (WorkBuddy)
          contextWindow: 1048576
          reasoningEfforts: *wbThinking

        - id: kimi-k3
          name: Kimi K3 (WorkBuddy)
          contextWindow: 262144
          reasoningEfforts: *wbThinking

        # Non-reasoning models MUST be declared as such. Declaring thinking levels
        # for a model with no reasoning channel makes DSH send `reasoning_effort`
        # that the model ignores, and DSH rejects configurations that offer no
        # level beyond "off": use `false`, not an empty map.
        - id: deepseek-v4-flash
          name: DeepSeek V4 Flash (WorkBuddy)
          contextWindow: 1048576
          reasoningEfforts: false

        - id: hy3
          name: Hunyuan Hy3 (WorkBuddy)
          contextWindow: 262144
          reasoningEfforts: false

        - id: auto
          name: Auto (WorkBuddy routing)
          contextWindow: 262144
          reasoningEfforts: *wbThinking
```

A complete, copy-pasteable file with all 20 models is in
[`integrations/dsh/settings.example.yaml`](../integrations/dsh/settings.example.yaml).

Two schema rules worth knowing, both enforced with clear errors:

- `reasoningEfforts` must be either `false` or a map with **at least one level besides
  `off`**. An `off`-only map is rejected:
  `provider "workbuddy" model "..." reasoningEfforts offers no level beyond "off"`.
- Omitting `reasoningEfforts` on a hand-declared route means "not reasoning", i.e. the
  same as `false`.

## 4. Select the model

New sessions use `agent-default-model`:

```yaml
agent-default-model:
  provider: workbuddy
  model: hy4-preview
```

To switch an existing session, pick it from the model selector in the GUI. The session
transcript stays intact — only the model serving the next turn changes.

## Notes and gotchas

- **A reasoning model spends its output budget on reasoning first.** With a small
  `max_tokens` you get an empty answer and `finish_reason: length`. DSH's own
  `maxOutputTokens` default is generous, but if you set it low per model, raise it.
- **`contextWindow` is only authoritative where the vendor documents it** (GLM-5.2 and
  the DeepSeek V4 family claim 1M). The upstream does not validate `max_tokens`, so the
  real cap cannot be probed. If a request fails on length, lower the number for that
  model rather than trusting the table.
- **`GET /v1/models` is static** — it returns the gateway's configured list. DSH's model
  discovery can read it, but the catalogue in `settings.yaml` is what DSH actually
  serves, so keep the two in sync when you add a model.
- **Point the gateway at the right port.** If you change `--port`, update `baseURL`.
- **The gateway must be running before you send a turn.** If it is down, requests fail
  with a connection error rather than falling back to another provider.

## Troubleshooting

See [troubleshooting.md](../troubleshooting.md) — in particular the `11128` security
policy error, which the gateway should be recovering from automatically.
