'use strict';
/**
 * Markup for the right-hand agent panel.
 *
 * Design notes:
 *  - The panel is a single conversation column with a compact composer.
 *  - While a turn runs, a status strip shows what is happening right now
 *    (thinking / running a tool / waiting for approval / writing), because a
 *    silent panel is indistinguishable from a hung one.
 *  - Send and Stop are a state machine, not decoration: Send is unavailable while
 *    a turn is in flight, Stop is available only then.
 *  - Everything uses VS Code theme variables so light and dark both work.
 */

function buildHtml() {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1.0" />
<style>
  * { box-sizing: border-box; }
  html, body { height: 100%; }
  body {
    margin: 0;
    font-family: var(--vscode-font-family);
    font-size: var(--vscode-font-size, 13px);
    color: var(--vscode-foreground);
    background: var(--vscode-sideBar-background, var(--vscode-editor-background));
    display: flex; flex-direction: column; height: 100vh;
    line-height: 1.5;
  }

  /* ---------------- top bars ---------------- */
  .bar {
    display: flex; align-items: center; gap: 4px;
    padding: 5px 8px; flex: 0 0 auto;
    border-bottom: 1px solid var(--vscode-panel-border, rgba(128,128,128,.22));
  }
  .bar.controls { gap: 6px; }
  .bar select { flex: 1 1 0; min-width: 0; }
  #credit {
    flex: 0 0 auto; white-space: nowrap;
    color: var(--vscode-descriptionForeground); font-size: .82em;
  }

  select, button, textarea, input { font-family: inherit; font-size: inherit; }
  select {
    background: var(--vscode-dropdown-background);
    color: var(--vscode-dropdown-foreground);
    border: 1px solid transparent;
    border-radius: 5px; padding: 2px 4px; max-width: 100%;
  }
  select:focus { outline: 1px solid var(--vscode-focusBorder); }
  select:disabled { opacity: .5; }

  .iconbtn {
    background: transparent; color: var(--vscode-icon-foreground, var(--vscode-foreground));
    border: none; border-radius: 5px; padding: 1px 5px; cursor: pointer;
    font-size: 1.05em; line-height: 1.3;
  }
  .iconbtn:hover { background: var(--vscode-toolbar-hoverBackground, rgba(128,128,128,.18)); }

  button.action {
    background: transparent; color: var(--vscode-foreground);
    border: 1px solid var(--vscode-panel-border, rgba(128,128,128,.35));
    border-radius: 5px; padding: 2px 10px; cursor: pointer; white-space: nowrap;
  }
  button.action:hover:not(:disabled) { background: var(--vscode-toolbar-hoverBackground, rgba(128,128,128,.18)); }
  button.action:disabled { opacity: .4; cursor: default; }
  button.primary {
    background: var(--vscode-button-background); color: var(--vscode-button-foreground);
    border-color: transparent;
  }
  button.primary:hover:not(:disabled) { background: var(--vscode-button-hoverBackground); }

  /* ---------------- conversation ---------------- */
  #thread { flex: 1 1 auto; overflow-y: auto; padding: 10px 10px 2px; }
  #thread::-webkit-scrollbar { width: 9px; }
  #thread::-webkit-scrollbar-thumb {
    background: var(--vscode-scrollbarSlider-background); border-radius: 5px;
  }
  #thread::-webkit-scrollbar-thumb:hover { background: var(--vscode-scrollbarSlider-hoverBackground); }

  .empty {
    color: var(--vscode-descriptionForeground);
    font-size: .92em; padding: 8px 2px;
  }

  .turn { margin: 0 0 12px; }
  .turn.user { display: flex; justify-content: flex-end; }
  .turn.user .bubble {
    background: var(--vscode-input-background);
    border: 1px solid var(--vscode-input-border, rgba(128,128,128,.22));
    border-radius: 9px 9px 3px 9px;
    padding: 5px 10px; max-width: 94%;
    white-space: pre-wrap; word-wrap: break-word;
  }

  .assistant { word-wrap: break-word; }
  .assistant p { margin: 0 0 7px; }
  .assistant p:last-child { margin-bottom: 0; }
  .assistant code {
    font-family: var(--vscode-editor-font-family, monospace);
    font-size: .93em;
    background: var(--vscode-textCodeBlock-background, rgba(128,128,128,.14));
    padding: 1px 4px; border-radius: 3px;
  }
  .assistant pre {
    font-family: var(--vscode-editor-font-family, monospace);
    font-size: .9em; line-height: 1.45;
    background: var(--vscode-textCodeBlock-background, rgba(128,128,128,.1));
    border: 1px solid var(--vscode-panel-border, rgba(128,128,128,.2));
    border-radius: 6px; padding: 8px 10px; margin: 6px 0;
    overflow-x: auto;
  }

  /* ---------------- reasoning ---------------- */
  details.reasoning { margin: 0 0 7px; }
  details.reasoning > summary {
    cursor: pointer; list-style: none; user-select: none;
    color: var(--vscode-descriptionForeground); font-size: .88em;
    display: flex; align-items: center; gap: 5px;
  }
  details.reasoning > summary::-webkit-details-marker { display: none; }
  details.reasoning > summary::before { content: '▸'; opacity: .7; }
  details.reasoning[open] > summary::before { content: '▾'; }
  details.reasoning .body {
    color: var(--vscode-descriptionForeground);
    border-left: 2px solid var(--vscode-panel-border, rgba(128,128,128,.3));
    margin: 4px 0 0 3px; padding: 2px 0 2px 9px;
    white-space: pre-wrap; font-size: .9em;
  }

  /* ---------------- tool steps ---------------- */
  details.step {
    margin: 0 0 5px; border-radius: 6px;
    border: 1px solid var(--vscode-panel-border, rgba(128,128,128,.22));
    background: var(--vscode-editorWidget-background, rgba(128,128,128,.05));
    overflow: hidden;
  }
  details.step > summary {
    cursor: pointer; list-style: none; user-select: none;
    display: flex; align-items: center; gap: 6px;
    padding: 3px 8px;
    font-family: var(--vscode-editor-font-family, monospace); font-size: .88em;
  }
  details.step > summary::-webkit-details-marker { display: none; }
  details.step > summary:hover { background: var(--vscode-toolbar-hoverBackground, rgba(128,128,128,.12)); }
  details.step .ico { opacity: .75; flex: 0 0 auto; }
  details.step .name { flex: 0 0 auto; }
  details.step .arg {
    flex: 1 1 auto; min-width: 0;
    color: var(--vscode-descriptionForeground);
    overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
  }
  details.step .state { flex: 0 0 auto; font-size: .95em; }
  details.step .state.run { color: var(--vscode-charts-yellow, #d7a12c); }
  details.step .state.ok { color: var(--vscode-charts-green, #3fb950); }
  details.step .state.bad { color: var(--vscode-charts-red, #f85149); }
  details.step pre {
    margin: 0; padding: 7px 9px;
    border-top: 1px solid var(--vscode-panel-border, rgba(128,128,128,.2));
    font-family: var(--vscode-editor-font-family, monospace); font-size: .87em;
    white-space: pre-wrap; word-break: break-word;
    max-height: 300px; overflow: auto;
    color: var(--vscode-descriptionForeground);
  }

  /* ---------------- file change ---------------- */
  .diff {
    display: flex; align-items: baseline; gap: 6px;
    font-family: var(--vscode-editor-font-family, monospace); font-size: .87em;
    color: var(--vscode-descriptionForeground); margin: 0 0 5px; padding-left: 2px;
  }
  .diff .file {
    color: var(--vscode-textLink-foreground); cursor: pointer;
    text-decoration: underline; text-underline-offset: 2px;
    overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
  }
  .diff .add { color: var(--vscode-charts-green, #3fb950); }
  .diff .del { color: var(--vscode-charts-red, #f85149); }

  /* ---------------- permission ---------------- */
  .permission {
    margin: 7px 0; border-radius: 7px; overflow: hidden;
    border: 1px solid var(--vscode-inputValidation-warningBorder, #b89500);
    background: var(--vscode-inputValidation-warningBackground, rgba(184,149,0,.08));
  }
  .permission .head {
    display: flex; align-items: center; gap: 6px;
    padding: 5px 9px; font-weight: 600; font-size: .92em;
  }
  .permission .sub {
    padding: 0 9px; color: var(--vscode-descriptionForeground); font-size: .88em;
  }
  .permission pre {
    margin: 5px 9px; padding: 6px 8px; border-radius: 5px;
    background: var(--vscode-textCodeBlock-background, rgba(0,0,0,.18));
    font-family: var(--vscode-editor-font-family, monospace); font-size: .87em;
    white-space: pre-wrap; word-break: break-word;
    max-height: 180px; overflow: auto;
  }
  .permission .actions { display: flex; gap: 6px; padding: 2px 9px 8px; flex-wrap: wrap; }
  .permission .actions button { font-size: .9em; }

  /* ---------------- notices ---------------- */
  .error {
    margin: 6px 0; padding: 6px 9px; border-radius: 6px;
    color: var(--vscode-errorForeground);
    background: var(--vscode-inputValidation-errorBackground, rgba(248,81,73,.1));
    border: 1px solid var(--vscode-inputValidation-errorBorder, rgba(248,81,73,.35));
    white-space: pre-wrap; font-size: .92em;
  }
  .meta {
    color: var(--vscode-descriptionForeground);
    font-size: .84em; margin: 5px 0 0; padding-left: 1px;
  }
  .notice {
    margin: 7px 0; padding: 6px 9px; border-radius: 6px;
    font-size: .9em;
    color: var(--vscode-inputValidation-warningForeground, var(--vscode-foreground));
    background: var(--vscode-inputValidation-warningBackground, rgba(184,149,0,.1));
    border: 1px solid var(--vscode-inputValidation-warningBorder, rgba(184,149,0,.4));
  }

  /* ---------------- status strip ---------------- */
  #status {
    flex: 0 0 auto; display: none;
    align-items: center; gap: 7px;
    padding: 4px 10px;
    color: var(--vscode-descriptionForeground); font-size: .88em;
    border-top: 1px solid var(--vscode-panel-border, rgba(128,128,128,.18));
    background: var(--vscode-editorWidget-background, rgba(128,128,128,.05));
  }
  #status.on { display: flex; }
  #status .label {
    flex: 1 1 auto; min-width: 0;
    overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
  }
  #status.waiting { color: var(--vscode-inputValidation-warningForeground, #b89500); }

  .spinner {
    flex: 0 0 auto; width: 11px; height: 11px; border-radius: 50%;
    border: 1.5px solid currentColor; border-top-color: transparent;
    animation: spin .7s linear infinite;
  }
  @keyframes spin { to { transform: rotate(360deg); } }
  @media (prefers-reduced-motion: reduce) {
    .spinner { animation-duration: 2s; }
  }

  /* ---------------- composer ---------------- */
  footer { flex: 0 0 auto; padding: 7px 10px 9px; }
  #input {
    width: 100%; min-height: 56px; max-height: 200px; resize: vertical;
    background: var(--vscode-input-background); color: var(--vscode-input-foreground);
    border: 1px solid var(--vscode-input-border, rgba(128,128,128,.35));
    border-radius: 7px; padding: 6px 9px; display: block;
  }
  #input:focus { outline: none; border-color: var(--vscode-focusBorder); }
  #input:disabled { opacity: .6; }
  .row { display: flex; align-items: center; gap: 8px; margin-top: 6px; }
  .row .spacer { flex: 1 1 auto; }
  label.toggle {
    display: flex; align-items: center; gap: 4px; cursor: pointer;
    color: var(--vscode-descriptionForeground); font-size: .85em; user-select: none;
  }
  label.toggle input { margin: 0; }
</style>
</head>
<body>
  <div class="bar">
    <select id="sessions" title="Recent chats"></select>
    <button class="iconbtn" id="delSession" title="Delete this chat">✕</button>
    <button class="iconbtn" id="newChat" title="New chat">＋</button>
  </div>

  <div class="bar controls">
    <select id="model" title="Model"></select>
    <select id="effort" title="Reasoning depth"></select>
    <span id="credit" title="Credits spent this session"></span>
  </div>

  <div id="thread"></div>

  <div id="status">
    <span class="spinner" id="spinner"></span>
    <span class="label" id="statusLabel"></span>
  </div>

  <footer>
    <textarea id="input" placeholder="Ask, or describe the change you want made…"></textarea>
    <div class="row">
      <label class="toggle" title="Write files without asking">
        <input type="checkbox" id="autoWrite" /> auto-write
      </label>
      <label class="toggle" title="Run commands without asking">
        <input type="checkbox" id="autoExec" /> auto-run
      </label>
      <span class="spacer"></span>
      <button class="action" id="stop" disabled>Stop</button>
      <button class="action primary" id="send">Send</button>
    </div>
  </footer>

<script>
  const vscode = acquireVsCodeApi();
  const thread = document.getElementById('thread');
  const input = document.getElementById('input');
  const modelSel = document.getElementById('model');
  const effortSel = document.getElementById('effort');
  const sessionsSel = document.getElementById('sessions');
  const autoWrite = document.getElementById('autoWrite');
  const autoExec = document.getElementById('autoExec');
  const sendBtn = document.getElementById('send');
  const stopBtn = document.getElementById('stop');
  const statusEl = document.getElementById('status');
  const statusLabel = document.getElementById('statusLabel');
  const spinner = document.getElementById('spinner');
  const creditEl = document.getElementById('credit');

  /* ------------------------------------------------------------------
     Turn state machine.
       idle      : nothing running — Send enabled, Stop disabled
       thinking  : model is reasoning — Send disabled, Stop enabled
       tool      : a tool is executing — Send disabled, Stop enabled
       writing   : model text is streaming — Send disabled, Stop enabled
       waiting   : blocked on the user's approval — Send disabled, Stop enabled
     ------------------------------------------------------------------ */
  let state = 'idle';
  let current = null;        // assistant text container being streamed
  let reasoning = null;      // its reasoning <details>
  let reasoningBody = null;
  let startedAt = 0;
  let ticker = null;
  const steps = new Map();

  function setState(next, detail) {
    state = next;
    const busy = next !== 'idle';

    sendBtn.disabled = busy;
    stopBtn.disabled = !busy;
    input.disabled = false;                   // typing ahead is allowed; only
                                              // sending is blocked
    modelSel.disabled = busy;
    effortSel.disabled = busy;
    sessionsSel.disabled = busy;

    if (busy) {
      statusEl.classList.add('on');
      statusEl.classList.toggle('waiting', next === 'waiting');
      spinner.style.display = next === 'waiting' ? 'none' : '';
      statusLabel.textContent = labelFor(next, detail);
      if (!ticker) {
        ticker = setInterval(() => {
          if (state !== 'idle') statusLabel.textContent = labelFor(state, lastDetail);
        }, 1000);
      }
    } else {
      statusEl.classList.remove('on', 'waiting');
      if (ticker) { clearInterval(ticker); ticker = null; }
    }
  }

  let lastDetail = null;
  function labelFor(s, detail) {
    lastDetail = detail !== undefined ? detail : lastDetail;
    const secs = startedAt ? Math.round((Date.now() - startedAt) / 1000) : 0;
    const suffix = secs >= 3 ? '  (' + secs + 's)' : '';
    switch (s) {
      case 'thinking': return 'Thinking…' + suffix;
      case 'writing':  return 'Writing…' + suffix;
      case 'tool':     return 'Running ' + (lastDetail || 'tool') + '…' + suffix;
      case 'waiting':  return 'Waiting for your approval';
      default:         return '';
    }
  }

  /* ---------------- rendering helpers ---------------- */
  const nearBottom = () => thread.scrollHeight - thread.scrollTop - thread.clientHeight < 80;
  function scroll(force) { if (force || nearBottom()) thread.scrollTop = thread.scrollHeight; }

  function el(tag, cls, text) {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text !== undefined) n.textContent = text;
    return n;
  }
  function add(node) { thread.appendChild(node); scroll(); return node; }

  function clearEmpty() {
    const e = thread.querySelector('.empty');
    if (e) e.remove();
  }

  function showEmpty() {
    if (thread.children.length) return;
    add(el('div', 'empty', 'Ask for a change, or describe what you want investigated.'));
  }

  /* Split text into prose and fenced code blocks, then render inline code. */
  function renderMarkdown(target, text) {
    target.textContent = '';
    const fences = String(text).split(/\`\`\`/);
    fences.forEach((chunk, i) => {
      if (i % 2 === 1) {
        const pre = el('pre');
        pre.textContent = chunk.replace(/^[a-zA-Z0-9+#-]*\\n/, '');
        target.appendChild(pre);
        return;
      }
      if (!chunk) return;
      chunk.split('\\n').forEach((line) => {
        const p = el('p');
        line.split(/\`([^\`]+)\`/).forEach((seg, k) => {
          if (k % 2 === 1) p.appendChild(el('code', null, seg));
          else if (seg) p.appendChild(document.createTextNode(seg));
        });
        target.appendChild(p);
      });
    });
  }

  function assistantBlock() {
    clearEmpty();
    const turn = el('div', 'turn');
    const body = el('div', 'assistant');
    turn.appendChild(body);
    add(turn);
    return body;
  }

  function appendText(text) {
    if (!current) current = assistantBlock();
    current.dataset.raw = (current.dataset.raw || '') + text;
    renderMarkdown(current, current.dataset.raw);
    scroll();
  }

  function appendReasoning(text) {
    if (!reasoning) {
      const turn = el('div', 'turn');
      const d = el('details', 'reasoning');
      d.appendChild(el('summary', null, 'Reasoning'));
      const b = el('div', 'body');
      d.appendChild(b);
      turn.appendChild(d);
      add(turn);
      reasoning = d; reasoningBody = b;
    }
    reasoningBody.textContent += text;
    scroll();
  }

  /* ---------------- tool steps ---------------- */
  const TOOL_ICON = {
    read_file: '📄', write_file: '✎', apply_edit: '✎', list_dir: '📁',
    search_files: '🔍', search_content: '🔍', run_terminal: '▶',
    get_diagnostics: '⚠', open_file: '↗',
  };

  function startStep(id, name, args) {
    clearEmpty();
    const turn = el('div', 'turn');
    const d = el('details', 'step');
    const s = el('summary');
    s.appendChild(el('span', 'ico', TOOL_ICON[name] || '•'));
    s.appendChild(el('span', 'name', name));
    const arg = JSON.stringify(args || {});
    s.appendChild(el('span', 'arg', arg === '{}' ? '' : arg.slice(1, -1)));
    const st = el('span', 'state run', '⋯');
    s.appendChild(st);
    d.appendChild(s);
    const body = el('pre', null, '');
    d.appendChild(body);
    turn.appendChild(d);
    add(turn);
    steps.set(id, { d, st, body });
    scroll();
  }

  function endStep(id, name, result, ok) {
    const text = String(result);
    const denied = /^denied by the user/.test(text);
    let s = steps.get(id);

    if (!s) {
      // A refusal can arrive without a preceding start event.
      const turn = el('div', 'turn');
      const d = el('details', 'step');
      const sum = el('summary');
      sum.appendChild(el('span', 'ico', TOOL_ICON[name] || '•'));
      sum.appendChild(el('span', 'name', name));
      sum.appendChild(el('span', 'arg', ''));
      sum.appendChild(el('span', 'state ' + (denied ? 'bad' : 'ok'), denied ? '✕' : '✓'));
      d.appendChild(sum);
      d.appendChild(el('pre', null, text.slice(0, 4000)));
      turn.appendChild(d);
      add(turn);
      return;
    }

    s.st.className = 'state ' + (denied ? 'bad' : 'ok');
    s.st.textContent = denied ? '✕' : '✓';
    s.body.textContent = text.length > 4000 ? text.slice(0, 4000) + '\\n… [truncated]' : text;
    scroll();
  }

  function addDiff(d) {
    const row = el('div', 'diff');
    row.appendChild(el('span', null, d.isNew ? 'created' : 'modified'));
    const f = el('span', 'file', d.path);
    f.title = 'Open ' + d.path;
    f.addEventListener('click', () => vscode.postMessage({ type: 'openFile', path: d.path }));
    row.appendChild(f);
    if (!d.isNew) row.appendChild(el('span', 'del', '−' + d.removed));
    row.appendChild(el('span', 'add', '+' + d.added));
    add(row);
  }

  /* ---------------- permission ---------------- */
  function askPermission(id, kind, detail) {
    setState('waiting');
    const box = el('div', 'permission');
    const head = el('div', 'head');
    head.appendChild(el('span', null, kind === 'exec' ? '⚠  Run a command?' : '⚠  Modify a file?'));
    box.appendChild(head);

    if (detail && (detail.summary || detail.path)) {
      box.appendChild(el('div', 'sub', [detail.summary, detail.path].filter(Boolean).join('  ·  ')));
    }
    if (detail && detail.preview) box.appendChild(el('pre', null, detail.preview));

    const actions = el('div', 'actions');
    const answer = (value) => {
      vscode.postMessage({ type: 'permissionAnswer', id, answer: value });
      actions.remove();
      head.textContent = value === 'deny' ? '✕  Denied' : '✓  Allowed';
      if (state === 'waiting') setState('tool', detail && detail.tool);
    };
    const once = el('button', 'action primary', 'Allow once');
    once.addEventListener('click', () => answer('once'));
    const always = el('button', 'action', 'Allow for session');
    always.addEventListener('click', () => answer('always'));
    const deny = el('button', 'action', 'Deny');
    deny.addEventListener('click', () => answer('deny'));
    actions.append(once, always, deny);
    box.appendChild(actions);
    add(box);
    scroll(true);

    // First button focused so the prompt is keyboard-reachable.
    once.focus();
  }

  /* ---------------- incoming messages ---------------- */
  window.addEventListener('message', (ev) => {
    const m = ev.data;
    switch (m.type) {
      case 'init':
        autoWrite.checked = !!m.autoWrite;
        autoExec.checked = !!m.autoExec;
        effortSel.innerHTML = '';
        (m.efforts || []).forEach((lvl) => {
          const o = document.createElement('option');
          o.value = lvl;
          o.textContent = lvl === 'off' ? 'reasoning: off' : lvl;
          if (lvl === m.effort) o.selected = true;
          effortSel.appendChild(o);
        });
        vscode.postMessage({ type: 'needModels' });
        setState('idle');
        showEmpty();
        break;

      case 'models':
        modelSel.innerHTML = '';
        (m.models || []).forEach((x) => {
          const o = document.createElement('option');
          o.value = x.id || x;
          o.textContent = x.label || x.id || x;
          if ((x.id || x) === m.current) o.selected = true;
          modelSel.appendChild(o);
        });
        if (!modelSel.options.length) {
          modelSel.appendChild(el('option', null, '(no models)'));
        }
        break;

      case 'sessions':
        sessionsSel.innerHTML = '';
        (m.sessions || []).forEach((s) => {
          const o = document.createElement('option');
          o.value = s.id;
          o.textContent = s.title + (s.turns > 1 ? '  ·  ' + s.turns : '');
          o.title = s.updatedAt ? new Date(s.updatedAt).toLocaleString() : '';
          if (s.id === m.active) o.selected = true;
          sessionsSel.appendChild(o);
        });
        break;

      case 'userMessage': {
        clearEmpty();
        const turn = el('div', 'turn user');
        turn.appendChild(el('div', 'bubble', m.text));
        add(turn);
        break;
      }

      case 'assistantStart':
        current = null; reasoning = null; reasoningBody = null;
        startedAt = Date.now();
        setState('thinking');
        break;

      case 'text':
        setState('writing');
        appendText(m.text);
        break;

      case 'reasoning':
        if (state !== 'writing') setState('thinking');
        appendReasoning(m.text);
        break;

      case 'toolStart':
        setState('tool', m.name);
        startStep(m.id, m.name, m.args);
        break;

      case 'toolEnd':
        endStep(m.id, m.name, m.result);
        if (state === 'tool') setState('thinking');
        break;

      case 'diff': addDiff(m); break;
      case 'permission': askPermission(m.id, m.kind, m.detail); break;

      case 'usage':
        if (m.sessionCredit !== undefined) creditEl.textContent = 'Σ ' + m.sessionCredit;
        break;

      case 'error':
        clearEmpty();
        add(el('div', 'error', m.text));
        break;

      case 'notice':
        clearEmpty();
        add(el('div', 'notice', m.text));
        break;

      case 'replayAssistant':
        current = assistantBlock();
        current.dataset.raw = m.text;
        renderMarkdown(current, m.text);
        break;

      case 'historyEnd':
        current = null; reasoning = null; reasoningBody = null;
        setState('idle');
        scroll(true);
        break;

      case 'assistantEnd':
        current = null; reasoning = null; reasoningBody = null;
        if (m.steps) add(el('div', 'meta', m.steps + ' tool step' + (m.steps === 1 ? '' : 's')
          + ' · ' + (m.ms / 1000).toFixed(1) + 's'));
        setState('idle');
        scroll();
        break;

      case 'cleared':
        thread.innerHTML = '';
        creditEl.textContent = '';
        setState('idle');
        showEmpty();
        break;
    }
  });

  /* ---------------- composer ---------------- */
  function send() {
    if (state !== 'idle') return;               // never send while a turn runs
    const text = input.value;
    if (!text.trim()) return;
    input.value = '';
    vscode.postMessage({ type: 'send', text });
  }

  sendBtn.addEventListener('click', send);
  stopBtn.addEventListener('click', () => { if (state !== 'idle') vscode.postMessage({ type: 'stop' }); });
  document.getElementById('newChat').addEventListener('click', () => vscode.postMessage({ type: 'newChat' }));
  document.getElementById('delSession').addEventListener('click', () => {
    if (sessionsSel.value) vscode.postMessage({ type: 'deleteSession', id: sessionsSel.value });
  });
  sessionsSel.addEventListener('change', () => vscode.postMessage({ type: 'selectSession', id: sessionsSel.value }));
  modelSel.addEventListener('change', () => vscode.postMessage({ type: 'setModel', model: modelSel.value }));
  effortSel.addEventListener('change', () => vscode.postMessage({ type: 'setEffort', effort: effortSel.value }));
  autoWrite.addEventListener('change', () => vscode.postMessage({ type: 'setAuto', kind: 'write', value: autoWrite.checked }));
  autoExec.addEventListener('change', () => vscode.postMessage({ type: 'setAuto', kind: 'exec', value: autoExec.checked }));

  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); }
  });

  vscode.postMessage({ type: 'ready' });
</script>
</body>
</html>`;
}

module.exports = { buildHtml };
