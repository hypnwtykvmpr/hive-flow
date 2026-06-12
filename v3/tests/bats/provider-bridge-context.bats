#!/usr/bin/env bats

setup() {
  REPO_ROOT="$(cd "$BATS_TEST_DIRNAME/../../.." && pwd)"
}

@test "provider bridge context trim honors exported model-window limits" {
  script="$BATS_TEST_TMPDIR/provider-bridge-context.mjs"
  cat > "$script" <<'NODE'
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const root = process.argv[2];
const bridge = await import(pathToFileURL(join(root, 'v3/@hive-flow/providers/scripts/provider-agent-bridge.mjs')).href);

function toolCallsOf(msg) {
  if (Array.isArray(msg.toolCalls)) return msg.toolCalls;
  if (Array.isArray(msg.tool_calls)) return msg.tool_calls;
  return [];
}

function toolCallIdOf(msg) {
  if (typeof msg.toolCallId === 'string') return msg.toolCallId;
  if (typeof msg.tool_call_id === 'string') return msg.tool_call_id;
  return null;
}

function estimateMessageTokens(msg) {
  const content = typeof msg.content === 'string'
    ? msg.content
    : msg.content == null
      ? ''
      : JSON.stringify(msg.content);
  let tokenCount = bridge.estimateTokensFromText(content);
  const toolCalls = toolCallsOf(msg);
  if (toolCalls.length > 0) tokenCount += bridge.estimateTokensFromText(JSON.stringify(toolCalls));
  if (typeof msg.name === 'string') tokenCount += bridge.estimateTokensFromText(msg.name);
  const toolCallId = toolCallIdOf(msg);
  if (toolCallId) tokenCount += bridge.estimateTokensFromText(toolCallId);
  return tokenCount + 10;
}

function estimateMessagesTokens(messages) {
  return messages.reduce((sum, msg) => sum + estimateMessageTokens(msg), 0);
}

function assertNoDanglingToolPairs(messages) {
  const calls = new Set();
  const results = new Set();
  for (const msg of messages) {
    if (msg.role === 'assistant') {
      for (const toolCall of toolCallsOf(msg)) {
        if (toolCall?.id) calls.add(toolCall.id);
      }
    }
    if (msg.role === 'tool') {
      const id = toolCallIdOf(msg);
      if (!id || !calls.has(id)) throw new Error(`orphaned tool result: ${id || '<missing>'}`);
      results.add(id);
    }
  }
  for (const id of calls) {
    if (!results.has(id)) throw new Error(`orphaned assistant tool call: ${id}`);
  }
}

const messages = [
  { role: 'system', content: 'Preserve system guidance.' },
  { role: 'user', content: 'Original task.' },
];

for (let index = 0; index < 16; index += 1) {
  const id = `call_${index}`;
  messages.push({
    role: 'assistant',
    content: `read oversized context chunk ${index}`,
    toolCalls: [{ id, type: 'function', function: { name: 'read_file', arguments: '{}' } }],
  });
  messages.push({
    role: 'tool',
    name: 'read_file',
    toolCallId: id,
    content: 'oversized context payload '.repeat(260),
  });
}
messages.push({ role: 'user', content: 'Latest user task.' });

const providerLimits = bridge.getProviderLimits('openrouter');
const limits = {
  ...providerLimits,
  maxTokens: 360,
  maxEntries: 4,
  warningThreshold: 260,
};
const trimmed = bridge.trimMessages(JSON.parse(JSON.stringify(messages)), limits);
const tokens = estimateMessagesTokens(trimmed);

if (tokens > limits.maxTokens) throw new Error(`tokens ${tokens} exceeded ${limits.maxTokens}`);
if (trimmed.length > limits.maxEntries + 2) throw new Error(`entries ${trimmed.length} exceeded ${limits.maxEntries + 2}`);
if (JSON.stringify(trimmed[0]) !== JSON.stringify(messages[0])) throw new Error('system message not preserved');
if (JSON.stringify(trimmed[trimmed.length - 1]) !== JSON.stringify(messages[messages.length - 1])) {
  throw new Error('latest user message not preserved');
}
assertNoDanglingToolPairs(trimmed);

console.log(JSON.stringify({ ok: true, tokens, entries: trimmed.length }));
NODE

  run node "$script" "$REPO_ROOT"

  [ "$status" -eq 0 ]
  [[ "$output" == *'"ok":true'* ]]
}

@test "provider bridge prepareForProvider removes abort-orphan tool calls" {
  script="$BATS_TEST_TMPDIR/provider-bridge-normalize.mjs"
  cat > "$script" <<'NODE'
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const root = process.argv[2];
const bridge = await import(pathToFileURL(join(root, 'v3/@hive-flow/providers/scripts/provider-agent-bridge.mjs')).href);

function toolCallsOf(msg) {
  if (Array.isArray(msg.toolCalls)) return msg.toolCalls;
  if (Array.isArray(msg.tool_calls)) return msg.tool_calls;
  return [];
}

function toolCallIdOf(msg) {
  if (typeof msg.toolCallId === 'string') return msg.toolCallId;
  if (typeof msg.tool_call_id === 'string') return msg.tool_call_id;
  return null;
}

function assertProviderLegalToolHistory(messages) {
  for (let index = 0; index < messages.length; index += 1) {
    const msg = messages[index];
    if (msg.role === 'tool') throw new Error(`orphan tool result ${toolCallIdOf(msg) || '<missing>'}`);
    const calls = toolCallsOf(msg);
    if (msg.role !== 'assistant' || calls.length === 0) continue;
    for (const call of calls) {
      index += 1;
      const toolMsg = messages[index];
      if (toolMsg?.role !== 'tool' || toolCallIdOf(toolMsg) !== call.id) {
        throw new Error(`missing adjacent result for ${call.id}`);
      }
    }
  }
}

const messages = [
  { role: 'system', content: 'system' },
  { role: 'user', content: 'start' },
  { role: 'assistant', content: '', toolCalls: [{ id: 'call_abort', type: 'function', function: { name: 'read_file', arguments: '{}' } }] },
  { role: 'user', content: 'resume after abort' },
  { role: 'assistant', content: 'done', toolCalls: [{ id: 'call_done', type: 'function', function: { name: 'grep', arguments: '{}' } }] },
  { role: 'tool', toolCallId: 'call_done', name: 'grep', content: 'done payload' },
];

const limits = { maxTokens: 2000, maxEntries: 20, warningThreshold: 1500 };
const prepared = bridge.prepareForProvider(JSON.parse(JSON.stringify(messages)), limits);
assertProviderLegalToolHistory(prepared);

if (JSON.stringify(prepared).includes('call_abort')) throw new Error('abort orphan survived');
if (!JSON.stringify(prepared).includes('call_done')) throw new Error('completed pair was dropped');

console.log(JSON.stringify({ ok: true, entries: prepared.length }));
NODE

  run node "$script" "$REPO_ROOT"

  [ "$status" -eq 0 ]
  [[ "$output" == *'"ok":true'* ]]
}
