'use strict';
/**
 * VS Code Chat integration.
 *
 * Registers a chat participant so WorkBuddy appears in the Chat view as
 * `@workbuddy`. It reuses the same agent loop and gateway client as the sidebar,
 * so tools, billing visibility and model handling stay identical.
 */

const vscode = require('vscode');

const PARTICIPANT_ID = 'workbuddyAgent.chat';
const MAX_HISTORY_TURNS = 20;

function cfg() {
  return vscode.workspace.getConfiguration('workbuddyAgent');
}

/** Flatten one history turn into plain text. */
function turnText(turn) {
  if (!turn) return '';
  // ChatRequestTurn
  if (typeof turn.prompt === 'string') return turn.prompt;
  // ChatResponseTurn: response is an array of parts
  if (Array.isArray(turn.response)) {
    return turn.response
      .map((part) => (part && typeof part.value === 'string' ? part.value : ''))
      .filter(Boolean)
      .join('\n');
  }
  return '';
}

/**
 * Convert VS Code chat history into OpenAI-style messages.
 *
 * The turn kind must be decided by shape, not by `participant`: a user turn that
 * was addressed to this participant also carries our id, so checking the id would
 * misclassify every user question as our own answer. A `ChatResponseTurn` is the
 * one with a `response` array.
 */
function historyToMessages(history) {
  const out = [];
  const recent = (history || []).slice(-MAX_HISTORY_TURNS);
  for (const turn of recent) {
    const text = turnText(turn).trim();
    if (!text) continue;
    const isResponse = Array.isArray(turn && turn.response);
    out.push({ role: isResponse ? 'assistant' : 'user', content: text });
  }
  // Drop a trailing user turn: the current request carries that text already.
  while (out.length && out[out.length - 1].role === 'user') out.pop();
  return out;
}

/**
 * Bridge a VS Code CancellationToken to an AbortSignal.
 *
 * The gateway client speaks AbortSignal (that is what the sidebar passes), but a
 * ChatRequestHandler receives a CancellationToken, which has no
 * addEventListener/aborted. Handing the token straight through fails with
 * "signal.addEventListener is not a function".
 */
function tokenToSignal(token) {
  const controller = new AbortController();
  if (!token) return controller.signal;
  if (token.isCancellationRequested === true) {
    controller.abort();
    return controller.signal;
  }
  if (typeof token.onCancellationRequested === 'function') {
    const sub = token.onCancellationRequested(() => controller.abort());
    if (sub && typeof sub.dispose === 'function') {
      controller.signal.addEventListener(
        'abort',
        () => { try { sub.dispose(); } catch { /* ignore */ } },
        { once: true }
      );
    }
  }
  return controller.signal;
}

/**
 * @param deps { runTurn, resolveApiKey, getGatewayUrl }
 */
function registerChatParticipant(context, deps) {
  if (!vscode.chat || typeof vscode.chat.createChatParticipant !== 'function') {
    return null; // Chat API unavailable on this VS Code build
  }

  const handler = async (request, chatContext, response, token) => {
    const model = cfg().get('model', 'hy4-preview-f');
    const gatewayUrl = deps.getGatewayUrl();

    // Slash commands
    if (request.command === 'model') {
      const wanted = String(request.prompt || '').trim();
      if (!wanted) {
        response.markdown('Current model: `' + model + '`. Use `/model <id>` to change it.');
        return;
      }
      await cfg().update('model', wanted, vscode.ConfigurationTarget.Global);
      response.markdown('Model set to `' + wanted + '`.');
      return;
    }

    const messages = historyToMessages(chatContext.history);
    messages.push({ role: 'user', content: request.prompt });

    response.progress('WorkBuddy · ' + model);

    let answered = false;
    try {
      await deps.runTurn({
        gatewayUrl,
        apiKey: deps.resolveApiKey(),
        model,
        messages,
        maxSteps: cfg().get('maxToolSteps', 50),
        signal: tokenToSignal(token),
        onText: (chunk) => { answered = true; response.markdown(chunk); },
        onReasoning: () => { /* the chat view has no reasoning channel; skip */ },
        onToolCall: (name, args) => {
          response.progress('tool: ' + name + ' ' + JSON.stringify(args).slice(0, 80));
        },
        onToolResult: () => { /* surfaced by the next assistant message */ },
        onUsage: (usage) => {
          if (usage) {
            response.progress('credit ' + (usage.credit ?? '?')
              + ' · tokens ' + (usage.total_tokens ?? '?'));
          }
        },
        onError: (err) => {
          response.markdown('\n\n**Error:** ' + String(err && err.message || err));
        },
      });
    } catch (err) {
      const msg = String(err && err.message ? err.message : err);
      response.markdown('**Gateway error.** ' + msg.split('\n').join('  \n'));
      return;
    }

    if (!answered) {
      response.markdown('_(no content returned)_');
    }
  };

  const participant = vscode.chat.createChatParticipant(PARTICIPANT_ID, handler);
  participant.iconPath = new vscode.ThemeIcon('hubot');
  context.subscriptions.push(participant);
  return participant;
}

module.exports = { registerChatParticipant, PARTICIPANT_ID, historyToMessages };
