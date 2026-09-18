'use strict';
/**
 * The agent loop: send the conversation, stream the reply, execute any tool
 * calls, feed the results back, and repeat until the model stops asking.
 */

const { createClient, GatewayUnreachable } = require('./client');
const { TOOLS, execute } = require('./tools');

const SYSTEM_PROMPT = [
  'You are a coding agent inside VS Code, powered by a WorkBuddy account through a local gateway.',
  'You have tools that operate on the user\'s workspace. Use them when they help.',
  'Rules:',
  '- Prefer reading before writing; never guess file contents.',
  '- Write the smallest change that solves the problem; do not restructure unrelated code.',
  '- Destructive actions (writing files, running commands) ask the user first; respect a denial and do not retry the same action.',
  '- When you finish, state what you changed in a couple of sentences.',
].join('\n');

/**
 * @param params {
 *   gatewayUrl, apiKey, model, messages,
 *   onText, onReasoning, onToolCall, onToolResult, onUsage, onError,
 *   signal, maxSteps
 * }
 */
async function runTurn(params) {
  const client = createClient({ gatewayUrl: params.gatewayUrl, apiKey: params.apiKey });
  const model = params.model;
  const maxSteps = Number(params.maxSteps) > 0 ? Number(params.maxSteps) : 12;

  const messages = [
    { role: 'system', content: SYSTEM_PROMPT },
    ...params.messages,
  ];

  let steps = 0;
  let totalUsage = null;

  for (;;) {
    if (steps >= maxSteps) {
      params.onText && params.onText('\n\n[stopped: reached the tool step limit of ' + maxSteps + ']');
      break;
    }
    steps++;

    // Accumulators for one upstream turn.
    const acc = {
      content: '',
      reasoning: '',
      toolCalls: new Map(),
      finishReason: null,
    };

    const flush = (delta) => {
      if (typeof delta.content === 'string' && delta.content.length) {
        acc.content += delta.content;
        params.onText && params.onText(delta.content);
      }
      if (typeof delta.reasoning_content === 'string' && delta.reasoning_content.length) {
        acc.reasoning += delta.reasoning_content;
        params.onReasoning && params.onReasoning(delta.reasoning_content);
      }
      for (const tc of delta.tool_calls || []) {
        const i = tc.index === undefined ? 0 : tc.index;
        const slot = acc.toolCalls.get(i) || { id: null, name: '', args: '' };
        if (tc.id) slot.id = tc.id;
        const fn = tc.function || {};
        if (fn.name) slot.name += fn.name;
        if (fn.arguments) slot.args += fn.arguments;
        acc.toolCalls.set(i, slot);
      }
    };

    try {
      // Reasoning models spend the output budget on reasoning first, so a small
      // cap returns an empty answer with finish_reason "length". Give them room.
      const body = {
        model,
        messages,
        tools: TOOLS,
        tool_choice: 'auto',
        stream_options: { include_usage: true },
        max_tokens: params.maxTokens > 0 ? Number(params.maxTokens) : 8192,
      };
      const usage = await client.streamChat(
        body,
        (payload) => {
          if (payload.error) {
            params.onError && params.onError(new Error(JSON.stringify(payload.error)));
            return;
          }
          const choice = (payload.choices || [])[0];
          if (!choice) return;
          if (choice.finish_reason) acc.finishReason = choice.finish_reason;
          flush(choice.delta || {});
        },
        params.signal
      );
      if (usage) { totalUsage = usage; params.onUsage && params.onUsage(usage); }
    } catch (err) {
      if (err instanceof GatewayUnreachable || err.status) throw err;
      if (err && err.name === 'AbortError') throw err;
      throw err;
    }

    if (!acc.toolCalls.size) {
      // A reasoning model that burned the whole budget on reasoning produces no
      // content at all. Say so instead of silently returning an empty answer.
      if (!acc.content && acc.reasoning && acc.finishReason === 'length') {
        params.onText && params.onText(
          '\n[the model spent the whole output budget on reasoning; raise the token budget '
          + 'or switch to a non-reasoning model]'
        );
      }
      break;
    }

    // Execute tool calls, then continue the loop with their results.
    messages.push({
      role: 'assistant',
      content: acc.content || null,
      tool_calls: [...acc.toolCalls.entries()].sort((a, b) => a[0] - b[0]).map(([, v]) => ({
        id: v.id,
        type: 'function',
        function: { name: v.name, arguments: v.args || '{}' },
      })),
    });

    for (const [, call] of [...acc.toolCalls.entries()].sort((a, b) => a[0] - b[0])) {
      let parsed = {};
      try { parsed = call.args ? JSON.parse(call.args) : {}; } catch { parsed = {}; }

      params.onToolCall && params.onToolCall(call.name, parsed);
      let result;
      try {
        result = await execute(call.name, parsed);
      } catch (e) {
        result = 'tool error: ' + (e && e.message ? e.message : String(e));
      }
      params.onToolResult && params.onToolResult(call.name, result);

      messages.push({ role: 'tool', tool_call_id: call.id, content: String(result) });
    }
  }

  return { usage: totalUsage };
}

module.exports = { runTurn, SYSTEM_PROMPT };
