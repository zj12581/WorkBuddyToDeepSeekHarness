# WorkBuddy Agent for VS Code

Use your locally signed-in WorkBuddy / CodeBuddy account inside VS Code, through the
local [workbuddy-gateway](../README.md).

There are two ways it integrates, and they are independent — use either or both.

## 1. Models in the Chat view (recommended)

The extension registers a **language model provider**, so the WorkBuddy models appear
in VS Code's own Chat view model picker. GitHub Copilot Chat — or any other chat
participant — then drives the conversation with *its* agent loop, tools, approval
prompts and diff UI. The extension only supplies the model.

**Why this is the good path:** agent quality is the host's, not ours. You get
Copilot's tool orchestration for free, and this extension stays small.

Setup:

```bash
cd vscode-extension
npx @vscode/vsce package
code --install-extension workbuddy-agent-0.1.0.vsix
```

Restart VS Code, open the Chat view, and pick a **WorkBuddy** model (look for the `★`
prefix on free ones).

## 2. Standalone agent panel

A self-contained agent in the **secondary side bar** (the right-hand column, next to the
editor), plus a `@workbuddy` chat participant. Use this when you do not have Copilot
Chat installed.

Open it with the command palette → **WorkBuddy Agent: Open Agent Panel (right side)**.

It has:

- a streaming conversation with **collapsible tool steps** (`read_file`, `apply_edit`, `run_terminal`, …)
- **inline permission prompts** — Allow once / Allow for session / Deny, instead of modal dialogs
- a **status strip** showing what is happening right now (Thinking… / Running read_file… / Waiting for your approval)
- **session persistence** — conversations survive closing the panel and reloading the window
- **model + reasoning-depth pickers**, and a per-session credit total

## Settings

| Setting | Default | Meaning |
|---|---|---|
| `workbuddyAgent.gatewayUrl` | `http://127.0.0.1:8790` | Gateway base URL. Probed automatically, including the in-WSL port. |
| `workbuddyAgent.apiKey` | *(auto)* | Gateway key. Read from the gateway's own start script when left empty. |
| `workbuddyAgent.model` | `hy4-preview-f` | Default model id. |
| `workbuddyAgent.reasoningEffort` | `off` | `off` / `minimal` / `low` / `medium` / `high` / `xhigh`. `off` omits the field entirely. |
| `workbuddyAgent.maxToolSteps` | `50` | Tool calls allowed per turn before the run stops. |
| `workbuddyAgent.autoApproveFileWrites` | `false` | Skip the prompt for file writes. |
| `workbuddyAgent.autoApproveTerminal` | `false` | Skip the prompt for shell commands. |

The same settings apply to both integration paths.

## Pick a cheap model

Twelve of the 32 models are marked free (`★`) by the gateway. **That marking is a
starting point, not a promise** — free/paid on this platform does not follow the price
multiplier and shifts over time. A second measurement days later found `kimi-k2.7`,
`kimi-k2.6`, `kimi-k2.5` and `minimax-m2.7` billing `0.01`–`0.02` per request while
`deepseek-v4.1-flash` had become free.

The models carrying `★` in the picker:

```
auto  hy4-preview-f  hy3  glm-5.3-flash  glm-5.1  glm-5.0-turbo
kimi-k2.7  kimi-k2.6  kimi-k2.5  minimax-m2.7  deepseek-v4-flash  deepseek-v3.2
```

> **`hy4-preview` vs `hy4-preview-f`** — one suffix apart. The official client's UI calls
> both "Hy4 preview", but only `-f` is free; the other bills.

To see what a request actually cost, the panel shows a per-session credit total and the
gateway log (`--debug`) prints `credit=` for every call.

**`hy4-preview-f` is the model most often rate-limited upstream** (`HTTP 429`, code
`6004`, with a reset time in the message). If it errors, use `deepseek-v4-flash` — free
and reliably available.

## Requirements

- VS Code **1.104+** (for `lm.registerLanguageModelChatProvider`)
- Node ≥ 18 on the machine running the gateway
- The gateway running — see the [main README](../README.md#one-command)

## Troubleshooting

**No WorkBuddy group in the model picker**

The provider never returns an empty list, so the group should always be visible. If it
is not:

1. Confirm the extension is active: command palette → **Developer: Show Running Extensions**
2. Check the log: **Developer: Show Logs…** → *Extension Host*, look for `workbuddy`
3. Fully quit and restart VS Code — the provider registers during activation, so a
   window reload is not always enough.

**`No gateway answered`**

Start it. In WSL, use `bash ../wsl/start-gateway.sh` — a gateway bound to Windows
loopback cannot be reached from WSL, and on Windows 10 neither mirrored networking nor
`portproxy` is an option.

**HTTP 401 while listing models**

The key does not match. Set `workbuddyAgent.apiKey`, or make sure the gateway was
started with the same `--api-key`.

**Every request fails with a connection error**

Something on the machine is intercepting `fetch` (a system proxy, for example). This
extension deliberately uses Node's `http` module rather than `fetch` for that reason —
if you still see it, check `HTTP_PROXY` / `HTTPS_PROXY` in the environment VS Code runs in.

**"Stopped after N tool calls"**

The per-turn tool limit. Raise `workbuddyAgent.maxToolSteps`, or reply `continue`.

## Development

```bash
cd vscode-extension
npx @vscode/vsce package --no-dependencies
code --install-extension workbuddy-agent-0.1.0.vsix --force
```

To install into WSL as well: `bash ../wsl/install-extension.sh`.
