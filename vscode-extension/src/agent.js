'use strict';
/**
 * The agent loop: send the conversation, stream the reply, execute any tool
 * calls, feed the results back, and repeat until the model stops asking.
 */

const { createClient, GatewayUnreachable } = require('./client');
const { TOOLS, execute } = require('./tools');

const SYSTEM_PROMPT = [
  'You are a coding agent working inside VS Code on the user\'s workspace.',
  '',
  'Work like a careful engineer:',
  '1. Explore before you change anything. Use search_files and search_content to find the',
  '   relevant files, then read them. Do not guess at file contents or project layout.',
  '2. For a multi-step task, say briefly what you intend to do, then do it.',
  '3. Prefer apply_edit over write_file. Rewrite a whole file only when that is genuinely',
  '   simpler, and never reformat or restructure code you were not asked to touch.',
  '4. After changing code, check your work: run the build or tests with run_terminal, or read',
  '   get_diagnostics. If something fails, fix it rather than reporting it as done.',
  '5. Keep going until the task is actually complete. Do not stop after one step to ask whether',
  '   to continue, and do not ask the user for information you can obtain with a tool.',
  '',
  'Writing files and running commands may prompt the user for permission. If a request is',
  'denied, do not repeat it: find another approach or explain what is blocked.',
  '',
  'When you finish, state concisely what you changed and anything the user should verify.',
].join('\n');

/**
 * Reasoning effort vocabulary, matching DSH's `reasoningEfforts` mapping.
 *
 * "off" means "do not request reasoning", and the wire form of that is to omit
 * reasoning_effort entirely — sending the literal string "off" is rejected by the
 * DeepSeek V4 family with 400 / 11150 invalid_reasoning_effort. Every other level
 * is passed through as-is; unsupported ones are dropped by the gateway.
 * An undefined effort means the caller did not choose one, which is also "omit".
 */
const EFFORT_LEVELS = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh'];

function normalizeEffort(value) {
  const v = typeof value === 'string' ? value.trim().toLowerCase() : '';
  return EFFORT_LEVELS.includes(v) ? v : '';
}

/**
 * @param params {
 *   gatewayUrl, apiKey, model, messages,
 *   onText, onReasoning, onToolCall, onToolResult, onUsage, onError, onDiff,
 *   signal, maxSteps, maxTokens, broker, reasoningEffort
 * }
 */
async function runTurn(params) {
  const client = createClient({ gatewayUrl: params.gatewayUrl, apiKey: params.apiKey });
  const model = params.model;
  const maxSteps = Number(params.maxSteps) > 0 ? Number(params.maxSteps) : 50;
  const effort = normalizeEffort(params.reasoningEffort);

  const messages = [
    { role: 'system', content: SYSTEM_PROMPT },
    ...params.messages,
  ];

  let steps = 0;
  let totalUsage = null;
  let limitReached = false;

  for (;;) {
    if (steps >= maxSteps) {
      limitReached = true;
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
      // Only attach reasoning_effort when a real level was requested.
      if (effort && effort !== 'off') body.reasoning_effort = effort;
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
        result = await execute(call.name, parsed, params.broker, { onDiff: params.onDiff });
      } catch (e) {
        result = 'tool error: ' + (e && e.message ? e.message : String(e));
      }
      params.onToolResult && params.onToolResult(call.name, result);

      messages.push({ role: 'tool', tool_call_id: call.id, content: String(result) });
    }
  }

  return { usage: totalUsage, steps, limitReached };
}

module.exports = { runTurn, SYSTEM_PROMPT, EFFORT_LEVELS, normalizeEffort };
