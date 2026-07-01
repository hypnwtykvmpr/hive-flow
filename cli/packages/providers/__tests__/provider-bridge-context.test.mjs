import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import fc from 'fast-check';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const bridgePath = resolve(here, '../scripts/provider-agent-bridge.mjs');

const previousEnv = {
  HIVE_FLOW_DEV_OVERRIDE_TOKEN: process.env.HIVE_FLOW_DEV_OVERRIDE_TOKEN,
  HIVE_FLOW_DEV_OVERRIDE: process.env.HIVE_FLOW_DEV_OVERRIDE,
};

let bridge;

function restoreEnv() {
  for (const [key, value] of Object.entries(previousEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
}

function restoreProcessListeners(event, preserved) {
  const keep = new Set(preserved);
  for (const listener of process.listeners(event)) {
    if (!keep.has(listener)) process.off(event, listener);
  }
}

beforeAll(async () => {
  const sigtermListeners = process.listeners('SIGTERM');
  const uncaughtExceptionListeners = process.listeners('uncaughtException');
  try {
    bridge = await import(`${pathToFileURL(bridgePath).href}?context=${Date.now()}-${Math.random()}`);
  } finally {
    restoreEnv();
    restoreProcessListeners('SIGTERM', sigtermListeners);
    restoreProcessListeners('uncaughtException', uncaughtExceptionListeners);
  }
});

afterAll(() => {
  restoreEnv();
});

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

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

function estimateMessageTokensForTest(msg) {
  const content = typeof msg.content === 'string'
    ? msg.content
    : msg.content == null
      ? ''
      : JSON.stringify(msg.content);

  let tokenCount = bridge.estimateTokensFromText(content);
  const toolCalls = toolCallsOf(msg);
  if (toolCalls.length > 0) {
    tokenCount += bridge.estimateTokensFromText(JSON.stringify(toolCalls));
  }
  if (msg.name && typeof msg.name === 'string') {
    tokenCount += bridge.estimateTokensFromText(msg.name);
  }
  const toolCallId = toolCallIdOf(msg);
  if (toolCallId) {
    tokenCount += bridge.estimateTokensFromText(toolCallId);
  }
  return tokenCount + 10;
}

function estimateMessagesTokensForTest(messages) {
  return messages.reduce((sum, msg) => sum + estimateMessageTokensForTest(msg), 0);
}

function effectiveMaxEntries(limits) {
  return typeof limits.maxEntries === 'number' ? limits.maxEntries + 2 : Number.POSITIVE_INFINITY;
}

function assertNoDanglingToolPairs(messages) {
  const seenAssistantCallIds = new Set();
  const retainedToolResultIds = new Set();

  for (const msg of messages) {
    if (msg.role === 'assistant') {
      for (const toolCall of toolCallsOf(msg)) {
        if (toolCall?.id) seenAssistantCallIds.add(toolCall.id);
      }
      continue;
    }

    if (msg.role === 'tool') {
      const toolCallId = toolCallIdOf(msg);
      expect(toolCallId).toBeTruthy();
      expect(seenAssistantCallIds.has(toolCallId)).toBe(true);
      retainedToolResultIds.add(toolCallId);
    }
  }

  for (const toolCallId of seenAssistantCallIds) {
    expect(retainedToolResultIds.has(toolCallId)).toBe(true);
  }
}

function assertProviderLegalToolHistory(messages) {
  for (let index = 0; index < messages.length; index += 1) {
    const msg = messages[index];
    if (msg.role === 'tool') {
      throw new Error(`orphaned tool result at index ${index}: ${toolCallIdOf(msg) || '<missing>'}`);
    }

    const toolCalls = toolCallsOf(msg);
    if (msg.role !== 'assistant' || toolCalls.length === 0) continue;

    for (const toolCall of toolCalls) {
      index += 1;
      const toolMsg = messages[index];
      if (toolMsg?.role !== 'tool' || toolCallIdOf(toolMsg) !== toolCall.id) {
        throw new Error(`missing adjacent tool result for ${toolCall.id}`);
      }
    }
  }
}

function compactMessageForProperty(msg) {
  if (msg.role === 'assistant' && toolCallsOf(msg).length > 0) {
    return `assistant:${toolCallsOf(msg).map((toolCall) => toolCall.id).join(',')}`;
  }
  if (msg.role === 'tool') {
    return `tool:${toolCallIdOf(msg)}`;
  }
  return `${msg.role}:${String(msg.content).slice(0, 80)}`;
}

const textChars = ' abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789._-/\n';
const textCharArb = fc.constantFrom(...textChars.split(''));
const textArb = (maxLength) => fc.array(textCharArb, { minLength: 0, maxLength }).map((chars) => chars.join(''));
const smallTextArb = textArb(60);
const variedPayloadArb = textArb(2600);

const turnSpecArb = fc.record({
  user: smallTextArb,
  assistant: variedPayloadArb,
  tool: variedPayloadArb,
  kind: fc.constantFrom('plain', 'tool-camel', 'tool-snake'),
});

const limitsArb = fc.record({
  maxTokens: fc.integer({ min: 600, max: 5000 }),
  maxEntries: fc.integer({ min: 4, max: 20 }),
}).map((limits) => ({
  ...limits,
  warningThreshold: Math.max(1, Math.floor(limits.maxTokens * 0.75)),
}));

const messagesArb = fc.record({
  system: fc.option(smallTextArb, { nil: undefined }),
  turns: fc.array(turnSpecArb, { minLength: 0, maxLength: 18 }),
  latest: smallTextArb,
}).map(({ system, turns, latest }) => {
  const messages = [];
  if (system !== undefined) messages.push({ role: 'system', content: system });

  turns.forEach((turn, index) => {
    messages.push({ role: 'user', content: turn.user });
    if (turn.kind === 'plain') {
      messages.push({ role: 'assistant', content: turn.assistant });
      return;
    }

    const id = `call_${index}`;
    const toolCall = { id, type: 'function', function: { name: 'read_file', arguments: '{}' } };
    if (turn.kind === 'tool-camel') {
      messages.push({ role: 'assistant', content: turn.assistant, toolCalls: [toolCall] });
      messages.push({ role: 'tool', name: 'read_file', toolCallId: id, content: turn.tool });
      return;
    }

    messages.push({ role: 'assistant', content: turn.assistant, tool_calls: [toolCall] });
    messages.push({ role: 'tool', name: 'read_file', tool_call_id: id, content: turn.tool });
  });

  messages.push({ role: 'user', content: latest });
  return messages;
});

const abortTurnArb = fc.record({
  user: smallTextArb,
  assistant: smallTextArb,
  tool: variedPayloadArb,
  kind: fc.constantFrom(
    'plain',
    'complete-camel',
    'complete-snake',
    'abort-camel',
    'abort-snake',
    'partial',
    'orphan-result',
    'invalid-call',
  ),
});

const abortHistoryArb = fc.record({
  system: fc.option(smallTextArb, { nil: undefined }),
  turns: fc.array(abortTurnArb, { minLength: 0, maxLength: 18 }),
  latest: smallTextArb,
}).map(({ system, turns, latest }) => {
  const messages = [];
  if (system !== undefined) messages.push({ role: 'system', content: system });

  turns.forEach((turn, index) => {
    const id = `call_${index}`;
    const otherId = `call_${index}_other`;
    messages.push({ role: 'user', content: turn.user });

    if (turn.kind === 'plain') {
      messages.push({ role: 'assistant', content: turn.assistant });
      return;
    }

    if (turn.kind === 'orphan-result') {
      messages.push({ role: 'tool', name: 'read_file', toolCallId: id, content: turn.tool });
      return;
    }

    if (turn.kind === 'invalid-call') {
      messages.push({
        role: 'assistant',
        content: turn.assistant,
        toolCalls: [{ type: 'function', function: { name: 'read_file', arguments: '{}' } }],
      });
      return;
    }

    const toolCall = { id, type: 'function', function: { name: 'read_file', arguments: '{}' } };
    if (turn.kind === 'complete-camel') {
      messages.push({ role: 'assistant', content: turn.assistant, toolCalls: [toolCall] });
      messages.push({ role: 'tool', name: 'read_file', toolCallId: id, content: turn.tool });
      return;
    }

    if (turn.kind === 'complete-snake') {
      messages.push({ role: 'assistant', content: turn.assistant, tool_calls: [toolCall] });
      messages.push({ role: 'tool', name: 'read_file', tool_call_id: id, content: turn.tool });
      return;
    }

    if (turn.kind === 'partial') {
      messages.push({
        role: 'assistant',
        content: turn.assistant,
        toolCalls: [
          { id: otherId, type: 'function', function: { name: 'grep', arguments: '{}' } },
          toolCall,
        ],
      });
      messages.push({ role: 'tool', name: 'read_file', toolCallId: id, content: turn.tool });
      return;
    }

    if (turn.kind === 'abort-snake') {
      messages.push({ role: 'assistant', content: turn.assistant, tool_calls: [toolCall] });
      return;
    }

    messages.push({ role: 'assistant', content: turn.assistant, toolCalls: [toolCall] });
  });

  messages.push({ role: 'user', content: latest });
  return messages;
});

describe('provider bridge context helpers', () => {
  it('resolves provider and model-specific limits from the real bridge', () => {
    expect(bridge.getProviderLimits('deepseek')).toMatchObject({ maxTokens: 1_000_000, maxEntries: 100 });
    expect(bridge.getProviderLimits('openrouter')).toMatchObject({ maxTokens: 128_000, maxEntries: 30 });
    expect(bridge.getProviderLimits('openrouter', '')).toMatchObject({ maxTokens: 128_000, maxEntries: 30 });
    expect(bridge.getProviderLimits('openrouter', 'xiaomi/mimo-v2.5-pro')).toMatchObject({
      maxTokens: 1_048_576,
      maxEntries: 100,
    });
    expect(bridge.getProviderLimits('openrouter', 'x-ai/grok-4.3')).toMatchObject({
      maxTokens: 1_000_000,
      maxEntries: 100,
    });
    expect(bridge.getProviderLimits('openrouter', 'minimax/minimax-m3')).toMatchObject({
      maxTokens: 1_048_576,
      maxEntries: 100,
    });
    expect(bridge.getProviderLimits('openrouter', 'qwen/qwen3.7-plus')).toMatchObject({
      maxTokens: 1_000_000,
      maxEntries: 100,
    });
    expect(bridge.getProviderLimits('lm-studio')).toMatchObject({ maxTokens: 32_000, maxEntries: 30 });
    expect(bridge.getProviderLimits('codex-cli')).toMatchObject({ maxTokens: 400_000, maxEntries: 50 });
    expect(bridge.getProviderLimits('unknown-provider', 'unknown-model')).toMatchObject({
      maxTokens: 128_000,
      maxEntries: 50,
    });
  });

  it('estimates tokens defensively and monotonically from text length', () => {
    expect(bridge.estimateTokensFromText('')).toBe(0);
    expect(bridge.estimateTokensFromText('   ')).toBe(1);
    expect(bridge.estimateTokensFromText(null)).toBe(0);
    expect(bridge.estimateTokensFromText({ value: 'not text' })).toBe(0);
    expect(bridge.estimateTokensFromText('abcd')).toBe(2);
    expect(bridge.estimateTokensFromText('abcde')).toBe(2);
    expect(bridge.estimateTokensFromText('x'.repeat(40_000))).toBe(13_000);
    expect(bridge.estimateTokensFromText('x'.repeat(4_000))).toBeGreaterThan(
      bridge.estimateTokensFromText('x'.repeat(400)),
    );
  });

  it('leaves already-fitting history unchanged', () => {
    const messages = [
      { role: 'system', content: 'Follow instructions.' },
      { role: 'user', content: 'Initial task.' },
      { role: 'assistant', content: 'Acknowledged.' },
      { role: 'user', content: 'Latest task.' },
    ];

    const trimmed = bridge.trimMessages(clone(messages), {
      maxTokens: 1000,
      maxEntries: 10,
      warningThreshold: 900,
    });

    expect(trimmed).toEqual(messages);
  });

  it('trims oversized history under token and entry limits without orphaning tool pairs', () => {
    const messages = [
      { role: 'system', content: 'Keep the durable instruction.' },
      { role: 'user', content: 'Original task.' },
    ];
    for (let index = 0; index < 12; index += 1) {
      const id = `call_${index}`;
      messages.push({ role: 'assistant', content: `Inspect file ${index}`, toolCalls: [{
        id,
        type: 'function',
        function: { name: 'read_file', arguments: '{}' },
      }] });
      messages.push({ role: 'tool', name: 'read_file', toolCallId: id, content: 'payload '.repeat(350) });
    }
    messages.push({ role: 'user', content: 'Latest task must remain.' });

    const limits = { maxTokens: 320, maxEntries: 4, warningThreshold: 240 };
    const trimmed = bridge.trimMessages(clone(messages), limits);

    expect(estimateMessagesTokensForTest(trimmed)).toBeLessThanOrEqual(limits.maxTokens);
    expect(trimmed.length).toBeLessThanOrEqual(effectiveMaxEntries(limits));
    expect(trimmed[0]).toEqual(messages[0]);
    expect(trimmed.at(-1)).toEqual(messages.at(-1));
    assertNoDanglingToolPairs(trimmed);
  });

  it('preserves trimMessages invariants across generated provider histories', () => {
    fc.assert(
      fc.property(messagesArb, limitsArb, (messages, limits) => {
        const trimmed = bridge.trimMessages(clone(messages), limits);
        const retrimmed = bridge.trimMessages(clone(trimmed), limits);

        expect(estimateMessagesTokensForTest(trimmed), compactMessageForProperty(trimmed.at(-1))).toBeLessThanOrEqual(
          limits.maxTokens,
        );
        expect(trimmed.length).toBeLessThanOrEqual(effectiveMaxEntries(limits));

        if (messages[0]?.role === 'system') {
          expect(trimmed[0]).toEqual(messages[0]);
        }

        const latestUser = [...messages].reverse().find((msg) => msg.role === 'user');
        expect(trimmed.some((msg) => msg.role === 'user' && msg.content === latestUser.content)).toBe(true);

        assertNoDanglingToolPairs(trimmed);
        expect(retrimmed).toEqual(trimmed);
      }),
      { numRuns: 200, seed: 20260612 },
    );
  });

  it('normalizes abort-induced orphan tool calls before provider send', () => {
    const messages = [
      { role: 'system', content: 'system' },
      { role: 'user', content: 'first' },
      {
        role: 'assistant',
        content: '',
        toolCalls: [{ id: 'call_abort', type: 'function', function: { name: 'read_file', arguments: '{}' } }],
      },
      { role: 'user', content: 'new task after abort' },
    ];

    const normalized = bridge.normalizeForProvider(clone(messages));

    expect(normalized).toEqual([
      { role: 'system', content: 'system' },
      { role: 'user', content: 'first' },
      { role: 'user', content: 'new task after abort' },
    ]);
    assertProviderLegalToolHistory(normalized);
  });

  it('normalizes partial tool-call units to completed calls in assistant-call order', () => {
    const messages = [
      { role: 'user', content: 'Inspect files.' },
      {
        role: 'assistant',
        content: 'I will inspect.',
        toolCalls: [
          { id: 'call_missing', type: 'function', function: { name: 'grep', arguments: '{}' } },
          { id: 'call_done', type: 'function', function: { name: 'read_file', arguments: '{}' } },
        ],
      },
      { role: 'tool', toolCallId: 'call_done', name: 'read_file', content: 'done payload' },
      { role: 'tool', toolCallId: 'call_orphan', name: 'grep', content: 'orphan payload' },
      { role: 'user', content: 'Continue.' },
    ];

    const normalized = bridge.normalizeForProvider(clone(messages));

    expect(normalized).toEqual([
      { role: 'user', content: 'Inspect files.' },
      {
        role: 'assistant',
        content: 'I will inspect.',
        toolCalls: [
          { id: 'call_done', type: 'function', function: { name: 'read_file', arguments: '{}' } },
        ],
      },
      { role: 'tool', toolCallId: 'call_done', name: 'read_file', content: 'done payload' },
      { role: 'user', content: 'Continue.' },
    ]);
    assertProviderLegalToolHistory(normalized);
  });

  it('prepares generated abort/cancel histories into provider-legal bounded histories', () => {
    fc.assert(
      fc.property(abortHistoryArb, limitsArb, (messages, limits) => {
        const normalized = bridge.normalizeForProvider(clone(messages));
        const renormalized = bridge.normalizeForProvider(clone(normalized));
        const prepared = bridge.prepareForProvider(clone(messages), limits);
        const manuallyPrepared = bridge.trimMessages(
          bridge.normalizeForProvider(bridge.evictOldToolResults(clone(messages))),
          limits,
        );

        expect(renormalized).toEqual(normalized);
        expect(prepared).toEqual(manuallyPrepared);
        assertProviderLegalToolHistory(normalized);
        assertProviderLegalToolHistory(prepared);
        expect(estimateMessagesTokensForTest(prepared), compactMessageForProperty(prepared.at(-1))).toBeLessThanOrEqual(
          limits.maxTokens,
        );
        expect(prepared.length).toBeLessThanOrEqual(effectiveMaxEntries(limits));
      }),
      { numRuns: 300, seed: 20260612 },
    );
  });
});
