'use strict';
/**
 * Extension entry point: registers the sidebar chat view and its commands.
 */

const vscode = require('vscode');
const { createClient, GatewayUnreachable } = require('./client');
const { runTurn } = require('./agent');

function cfg() {
  return vscode.workspace.getConfiguration('workbuddyAgent');
}

function currentModelMeta(provider) {
  const id = cfg().get('model', 'hy4-preview-f');
  return { id, meta: provider.getModelMeta(id) };
}

function activate(context) {
  const provider = new ChatViewProvider(context);

  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider('workbuddyAgent.chatView', provider, {
      webviewOptions: { retainContextWhenHidden: true },
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('workbuddyAgent.open', () => {
      vscode.commands.executeCommand('workbuddyAgent.chatView.focus');
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('workbuddyAgent.newChat', () => provider.clear())
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('workbuddyAgent.setGateway', async () => {
      const value = await vscode.window.showInputBox({
        prompt: 'Gateway base URL (no trailing /v1)',
        value: cfg().get('gatewayUrl', 'http://127.0.0.1:8790'),
      });
      if (value) {
        await cfg().update('gatewayUrl', value.trim(), vscode.ConfigurationTarget.Global);
        provider.refreshModels();
      }
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('workbuddyAgent.setApiKey', async () => {
      const value = await vscode.window.showInputBox({
        prompt: 'API key expected by the gateway (empty = none)',
        value: cfg().get('apiKey', ''),
        password: true,
      });
      if (value !== undefined) {
        await cfg().update('apiKey', value.trim(), vscode.ConfigurationTarget.Global);
        provider.refreshModels();
      }
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('workbuddyAgent.refreshModels', () => provider.refreshModels())
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('workbuddyAgent.explainSelection', async () => {
      const editor = vscode.window.activeTextEditor;
      if (!editor) return;
      const selection = editor.document.getText(editor.selection);
      if (!selection) return;
      const language = editor.document.languageId;
      provider.send(
        'Explain this ' + language + ' code:\n\n```' + language + '\n' + selection + '\n```'
      );
    })
  );
}

class ChatViewProvider {
  constructor(context) {
    this.context = context;
    this.messages = [];
    this.abort = null;
    this.modelMeta = {};
  }

  getModelMeta(id) {
    return this.modelMeta[id] || null;
  }

  clear() {
    this.messages = [];
    if (this.view) this.view.webview.postMessage({ type: 'clear' });
    this.pushStatus('New chat. Model: ' + cfg().get('model'));
  }

  refreshModels() {
    if (!this.view) return;
    this.loadModels();
  }

  async loadModels() {
    const client = createClient({ gatewayUrl: cfg().get('gatewayUrl'), apiKey: cfg().get('apiKey') });
    try {
      const models = await client.listModels();
      // Build a lookup of tier/context from the gateway response.
      this.modelMeta = {};
      for (const m of models) {
        this.modelMeta[m.id] = { tier: m.tier || 'unknown' };
      }
      this.post({
        type: 'models',
        models: models.map(m => ({
          id: m.id,
          tier: m.tier || 'unknown',
          label: (m.tier === 'free' ? '★ ' : '') + m.id,
        })),
        current: cfg().get('model', 'hy4-preview-f'),
      });
      this.pushStatus('Connected. ' + models.length + ' models available.');
    } catch (err) {
      const hint = err instanceof GatewayUnreachable
        ? String(err.message)
        : String(err && err.message ? err.message : err);
      this.post({ type: 'models', models: [], current: null });
      this.pushStatus('Gateway unavailable: ' + hint, true);
    }
  }

  pushStatus(text, isError) {
    this.post({ type: 'status', text, isError: !!isError });
  }

  post(msg) {
    if (this.view) this.view.webview.postMessage(msg);
  }

  resolveWebviewView(view) {
    this.view = view;
    view.webview.options = { enableScripts: true, localResourceRoots: [] };
    view.webview.html = html();

    view.webview.onDidReceiveMessage(async (msg) => {
      if (msg.type === 'ready') {
        await this.loadModels();
        return;
      }
      if (msg.type === 'send') {
        await this.send(msg.text);
        return;
      }
      if (msg.type === 'stop') {
        if (this.abort) this.abort.abort();
        return;
      }
      if (msg.type === 'setModel') {
        await cfg().update('model', msg.model, vscode.ConfigurationTarget.Global);
        this.pushStatus('Model set to: ' + msg.model);
        return;
      }
      if (msg.type === 'refresh') {
        await this.loadModels();
        return;
      }
      if (msg.type === 'clear') {
        this.clear();
      }
    });
  }

  async send(text) {
    const prompt = String(text || '').trim();
    if (!prompt) return;

    // include a selection context if the user asked about code
    this.messages.push({ role: 'user', content: prompt });
    this.post({ type: 'userMessage', text: prompt });
    this.post({ type: 'assistantStart' });

    const model = cfg().get('model', 'hy4-preview-f');
    const meta = this.modelMeta[model];
    this.post({ type: 'turnInfo', model, tier: meta ? meta.tier : 'unknown' });

    this.abort = new AbortController();
    const started = Date.now();

    try {
      const { usage } = await runTurn({
        gatewayUrl: cfg().get('gatewayUrl'),
        apiKey: cfg().get('apiKey'),
        model,
        messages: this.messages,
        maxSteps: cfg().get('maxToolSteps', 12),
        signal: this.abort.signal,
        onText: (chunk) => this.post({ type: 'text', text: chunk }),
        onReasoning: (chunk) => this.post({ type: 'reasoning', text: chunk }),
        onToolCall: (name, args) => this.post({ type: 'toolCall', name, args }),
        onToolResult: (name, result) => this.post({ type: 'toolResult', name, result }),
        onUsage: (u) => this.post({ type: 'usage', usage: u }),
        onError: (err) => this.post({ type: 'error', text: String(err && err.message || err) }),
      });

      this.post({ type: 'done', ms: Date.now() - started, usage });
    } catch (err) {
      const aborted = err && err.name === 'AbortError';
      this.post({
        type: 'error',
        text: aborted ? 'stopped' : String(err && err.message ? err.message : err),
      });
      this.post({ type: 'done', ms: Date.now() - started, usage: null });
    } finally {
      this.abort = null;
    }
  }
}

function html() {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1.0" />
<style>
  :root { --mono: var(--vscode-editor-font-family, monospace); }
  * { box-sizing: border-box; }
  body {
    margin: 0; padding: 8px;
    font-family: var(--vscode-font-family);
    font-size: var(--vscode-font-size, 13px);
    color: var(--vscode-foreground);
    background: var(--vscode-editor-background);
    display: flex; flex-direction: column; height: 100vh;
  }
  #bar { display: flex; gap: 6px; align-items: center; margin-bottom: 6px; flex-wrap: wrap; }
  select, button, textarea {
    font-family: inherit; font-size: inherit;
    background: var(--vscode-input-background);
    color: var(--vscode-input-foreground);
    border: 1px solid var(--vscode-input-border, transparent);
    border-radius: 4px; padding: 3px 6px;
  }
  select { flex: 1 1 auto; min-width: 120px; }
  button { cursor: pointer; }
  button:hover { background: var(--vscode-button-hoverBackground, #333); }
  textarea { width: 100%; min-height: 60px; resize: vertical; }
  #log { flex: 1 1 auto; overflow-y: auto; padding: 6px; border: 1px solid var(--vscode-editorWidget-border, #444); border-radius: 4px; }
  .msg { margin: 6px 0; white-space: pre-wrap; word-wrap: break-word; line-height: 1.45; }
  .user { color: var(--vscode-textLink-foreground); }
  .assistant { }
  .tool { color: var(--vscode-descriptionForeground); font-family: var(--mono); font-size: 0.92em; }
  .reasoning { color: var(--vscode-descriptionForeground); font-style: italic; opacity: 0.85; }
  .error { color: var(--vscode-errorForeground); }
  .status { color: var(--vscode-descriptionForeground); font-size: 0.9em; margin: 4px 0; }
  .usage { color: var(--vscode-descriptionForeground); font-size: 0.85em; margin-top: 4px; }
  pre { background: var(--vscode-textCodeBlock-background); padding: 8px; border-radius: 4px; overflow-x: auto; }
  code { font-family: var(--mono); }
  #actions { display: flex; gap: 6px; margin-top: 6px; }
  #send { background: var(--vscode-button-background); color: var(--vscode-button-foreground); }
</style>
</head>
<body>
  <div id="bar">
    <select id="model" title="Model"></select>
    <button id="clear" title="New chat">New</button>
    <button id="refresh" title="Reload model list">↻</button>
  </div>
  <div id="status" class="status"></div>
  <div id="log"></div>
  <textarea id="input" placeholder="Ask, or describe a change to make… (Enter to send, Shift+Enter for newline)"></textarea>
  <div id="actions">
    <button id="send">Send</button>
    <button id="stop">Stop</button>
  </div>

<script>
  const vscode = acquireVsCodeApi();
  const log = document.getElementById('log');
  const input = document.getElementById('input');
  const modelSel = document.getElementById('model');
  const statusEl = document.getElementById('status');

  let currentAssistant = null;
  let busy = false;

  function el(cls, text) {
    const d = document.createElement('div');
    d.className = cls;
    if (text !== undefined) d.textContent = text;
    return d;
  }

  function append(node) {
    log.appendChild(node);
    log.scrollTop = log.scrollHeight;
    return node;
  }

  function setStatus(text, isError) {
    statusEl.textContent = text || '';
    statusEl.style.color = isError ? 'var(--vscode-errorForeground)' : '';
  }

  function startAssistant() {
    currentAssistant = el('msg assistant', '');
    append(currentAssistant);
  }

  function addToAssistant(text, cls) {
    if (!currentAssistant) startAssistant();
    const span = document.createElement('span');
    span.className = cls || '';
    span.textContent = text;
    currentAssistant.appendChild(span);
    log.scrollTop = log.scrollHeight;
  }

  function addBlock(cls, text) {
    const node = el(cls, text);
    append(node);
    return node;
  }

  window.addEventListener('message', (event) => {
    const msg = event.data;
    switch (msg.type) {
      case 'status':
        setStatus(msg.text, msg.isError);
        break;

      case 'models': {
        modelSel.innerHTML = '';
        const list = msg.models || [];
        if (!list.length) {
          const o = document.createElement('option');
          o.textContent = '(no models — is the gateway running?)';
          modelSel.appendChild(o);
          break;
        }
        for (const m of list) {
          const o = document.createElement('option');
          o.value = m.id;
          o.textContent = m.label;
          if (m.id === msg.current) o.selected = true;
          modelSel.appendChild(o);
        }
        break;
      }

      case 'turnInfo': {
        const t = msg.tier === 'free' ? 'free' : (msg.tier === 'paid' ? 'bills credits' : 'unknown tier');
        addBlock('status', 'model: ' + msg.model + ' (' + t + ')');
        break;
      }

      case 'userMessage':
        addBlock('msg user', 'You: ' + msg.text);
        break;

      case 'assistantStart':
        startAssistant();
        busy = true;
        break;

      case 'text':
        addToAssistant(msg.text, '');
        break;

      case 'reasoning':
        addToAssistant(msg.text, 'reasoning');
        break;

      case 'toolCall':
        addBlock('tool', '▸ tool: ' + msg.name + ' ' + JSON.stringify(msg.args));
        break;

      case 'toolResult':
        addBlock('tool', '◂ ' + String(msg.result).slice(0, 500));
        break;

      case 'usage':
        if (msg.usage) {
          addBlock('usage',
            'tokens ' + (msg.usage.total_tokens ?? '?')
            + ' · credit ' + (msg.usage.credit ?? '?')
            + ' · cache hit ' + (msg.usage.prompt_cache_hit_tokens ?? '?'));
        }
        break;

      case 'error':
        addBlock('error', 'error: ' + msg.text);
        break;

      case 'done':
        busy = false;
        break;

      case 'clear':
        log.innerHTML = '';
        setStatus('');
        break;
    }
  });

  function send() {
    if (busy) return;
    const text = input.value;
    if (!text.trim()) return;
    input.value = '';
    vscode.postMessage({ type: 'send', text });
  }

  document.getElementById('send').addEventListener('click', send);
  document.getElementById('stop').addEventListener('click', () => vscode.postMessage({ type: 'stop' }));
  document.getElementById('clear').addEventListener('click', () => vscode.postMessage({ type: 'clear' }));
  document.getElementById('refresh').addEventListener('click', () => vscode.postMessage({ type: 'refresh' }));

  modelSel.addEventListener('change', () => {
    vscode.postMessage({ type: 'setModel', model: modelSel.value });
  });

  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      send();
    }
  });

  vscode.postMessage({ type: 'ready' });
</script>
</body>
</html>`;
}

function deactivate() {}

module.exports = { activate, deactivate, ChatViewProvider };
