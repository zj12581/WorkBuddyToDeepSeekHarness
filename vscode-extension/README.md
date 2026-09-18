# WorkBuddy Agent for VS Code

Use your locally signed-in WorkBuddy / CodeBuddy account inside VS Code, through the
[workbuddy-gateway](../README.md) — the same local gateway this repository ships.

```
VS Code sidebar (webview)
        │  POST http://127.0.0.1:8790/v1/chat/completions
        ▼
  workbuddy-gateway  ── session, token refresh, prompt cache key, desensitization
        │
        ▼
  WorkBuddy upstream   (Hunyuan / GLM / Kimi / MiniMax / DeepSeek)
```

## What it does

- **Chat in the sidebar** with streaming, and rendering of the model's reasoning channel
  when the model has one.
- **Model picker** showing every model the gateway serves, with free models marked `★`.
- **Agent tools** operating on your workspace:
  - `read_file` — read a file
  - `write_file` — create/overwrite (**asks first**)
  - `list_dir` — list a directory
  - `run_terminal` — run a command (**asks first**, 60s timeout)
  - `insert_at_cursor` — insert text at the cursor
- **Credit visibility** — after each turn the panel reports tokens, `credit` and
  `prompt_cache_hit_tokens`, so you can see what a turn actually cost.
- **Explain selection** — select code, run `WorkBuddy Agent: Explain Selection`.

## Prerequisites

1. The **WorkBuddy desktop client is signed in** (that is where the session lives).
2. A running gateway:
   ```bash
   node gateway.js --port 8790 --api-key workbuddy-local
   ```
3. VS Code 1.74+.

The extension holds no credentials and never talks to the upstream directly. No gateway,
no model — it will say so instead of failing obscurely.

## Install (from source)

```bash
cd vscode-extension
npm install          # only needed for @types/vscode; runtime has no dependencies
```

Then either:

- press <kbd>F5</kbd> in VS Code to launch an Extension Development Host, or
- symlink/copy this folder into `~/.vscode/extensions/workbuddy-agent`.

## Settings

| Setting | Default | Meaning |
|---|---|---|
| `workbuddyAgent.gatewayUrl` | `http://127.0.0.1:8790` | Gateway base URL, with or without `/v1` |
| `workbuddyAgent.apiKey` | *(empty)* | Must match the gateway's `--api-key`; empty if it runs keyless |
| `workbuddyAgent.model` | `hy4-preview-f` | Default model. **Free** — do not confuse with `hy4-preview`, which bills |
| `workbuddyAgent.maxToolSteps` | `12` | Cap on tool calls per turn |
| `workbuddyAgent.autoApproveFileWrites` | `false` | Skip the write confirmation |
| `workbuddyAgent.autoApproveTerminal` | `false` | Skip the command confirmation |

## Commands

| Command | |
|---|---|
| `WorkBuddy Agent: Open Chat` | focus the sidebar |
| `WorkBuddy Agent: New Chat` | clear the conversation |
| `WorkBuddy Agent: Set Gateway URL` | |
| `WorkBuddy Agent: Set API Key` | stored in VS Code settings |
| `WorkBuddy Agent: Refresh Model List` | |
| `WorkBuddy Agent: Explain Selection` | uses the current selection as context |

## Notes and limits

- **Tool steps are capped** (`maxToolSteps`) so a confused model cannot loop forever.
- **Paths are confined to the workspace**; `../` escapes are rejected before any file is touched.
- **Terminal output is truncated** to 8k chars and each command has a 60s timeout.
- **Reasoning models need a generous budget.** They spend output tokens on reasoning first;
  the default request budget is 8192. If a model returns empty text with `finish_reason:
  length`, the panel tells you rather than showing a blank answer.
- The conversation history is **not persisted** — closing the panel clears it.
- This is a thin client on purpose: billing, caching and safety live in the gateway, so the
  two stay consistent.

## Files

```
vscode-extension/
├── package.json          manifest, settings, commands
└── src/
    ├── extension.js      view provider, webview UI, commands
    ├── agent.js          the tool loop
    ├── client.js         gateway HTTP/SSE client (own error types)
    └── tools.js          tool declarations + execution + approval
```
