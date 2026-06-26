import { afterAll, beforeAll, describe, expect, it } from 'vitest';
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
    bridge = await import(`${pathToFileURL(bridgePath).href}?mc=${Date.now()}-${Math.random()}`);
  } finally {
    restoreEnv();
    restoreProcessListeners('SIGTERM', sigtermListeners);
    restoreProcessListeners('uncaughtException', uncaughtExceptionListeners);
  }
});

afterAll(() => {
  restoreEnv();
});

function oldEstimateTokensFromText(text) {
  return typeof text === 'string' ? Math.ceil(text.length / 4) : 0;
}

function paddedEstimateTokensFromText(text) {
  return typeof text === 'string' ? Math.ceil((text.length / 4) * 1.3) : 0;
}

function textMessageTokens(content, estimator = bridge.estimateTokensFromText) {
  return estimator(content) + 10;
}

function contentForEstimate(content) {
  if (typeof content === 'string') return content;
  if (content == null) return '';
  return JSON.stringify(content);
}

function expectedWarningThreshold(maxTokens) {
  return Math.max(
    Math.floor(maxTokens * 0.5),
    Math.min(Math.floor(maxTokens * 0.85), maxTokens - 40000),
  );
}

function totalTokens(messages, estimator = bridge.estimateTokensFromText) {
  return messages.reduce((sum, msg) => sum + textMessageTokens(contentForEstimate(msg.content), estimator), 0);
}

function toolHistory(count, contentFactory = (index) => `payload-${index}`) {
  const messages = [
    { role: 'system', content: 'system' },
    { role: 'user', content: 'task' },
  ];
  for (let index = 0; index < count; index += 1) {
    const id = `call_${index}`;
    messages.push({
      role: 'assistant',
      content: `calling ${index}`,
      toolCalls: [{ id, type: 'function', function: { name: 'read_file', arguments: '{}' } }],
    });
    messages.push({
      role: 'tool',
      toolCallId: id,
      name: 'read_file',
      content: contentFactory(index),
    });
  }
  messages.push({ role: 'user', content: 'latest' });
  return messages;
}

function toolMessages(messages) {
  return messages.filter((msg) => msg.role === 'tool');
}

function assertNoDanglingToolPairs(messages) {
  const liveCalls = new Set();
  for (const msg of messages) {
    const calls = Array.isArray(msg.toolCalls)
      ? msg.toolCalls
      : Array.isArray(msg.tool_calls)
        ? msg.tool_calls
        : [];
    for (const call of calls) {
      if (call?.id) liveCalls.add(call.id);
    }
  }

  for (const msg of messages) {
    if (msg.role !== 'tool') continue;
    const id = typeof msg.toolCallId === 'string'
      ? msg.toolCallId
      : typeof msg.tool_call_id === 'string'
        ? msg.tool_call_id
        : null;
    expect(liveCalls.has(id)).toBe(true);
  }
}

describe('Slice A microcompaction budget heuristic', () => {
  it('pads chars/4 token estimates by 1.3 without changing non-string handling', () => {
    expect(bridge.estimateTokensFromText(null)).toBe(0);
    expect(bridge.estimateTokensFromText({ value: 'not text' })).toBe(0);
    expect(bridge.estimateTokensFromText('')).toBe(0);
    expect(bridge.estimateTokensFromText('abcd')).toBe(2);
    expect(bridge.estimateTokensFromText('x'.repeat(40_000))).toBe(13_000);
  });

  it('trims a dense history that old chars/4 would leave under the warning threshold', () => {
    const denseContent = 'x'.repeat(320);
    const messages = [
      { role: 'system', content: '' },
      { role: 'user', content: 'task' },
      { role: 'assistant', content: denseContent },
      { role: 'user', content: 'done' },
    ];
    const limits = { maxTokens: 500, maxEntries: 20, warningThreshold: 125 };

    expect(totalTokens(messages, oldEstimateTokensFromText)).toBeLessThanOrEqual(limits.warningThreshold);
    expect(totalTokens(messages, paddedEstimateTokensFromText)).toBeGreaterThan(limits.warningThreshold);

    const trimmed = bridge.trimMessages(JSON.parse(JSON.stringify(messages)), limits);

    expect(trimmed).toEqual([
      { role: 'system', content: '' },
      { role: 'user', content: 'task' },
      { role: 'user', content: 'done' },
    ]);
    expect(totalTokens(trimmed)).toBeLessThanOrEqual(limits.warningThreshold);
  });

  it('keeps the existing single-reserve warningThreshold formula unchanged', () => {
    const cases = [
      { provider: 'openrouter', maxTokens: 128_000 },
      { provider: 'cursor-cli', maxTokens: 200_000 },
      { provider: 'codex-cli', maxTokens: 400_000 },
      { provider: 'deepseek', maxTokens: 1_000_000 },
      { provider: 'anthropic-cli', maxTokens: 1_000_000 },
    ];

    for (const { provider, maxTokens } of cases) {
      const limits = bridge.getProviderLimits(provider);
      expect(limits.warningThreshold, `${provider} warningThreshold`).toBe(expectedWarningThreshold(maxTokens));
    }
  });

  it('keeps the 1M model effective trigger above a comfortable 60 percent context', () => {
    const limits = bridge.getProviderLimits('deepseek');
    const comfortableRealTokens = 600_000;
    const paddedEstimate = comfortableRealTokens * 1.3;

    expect(limits.warningThreshold).toBe(850_000);
    expect(paddedEstimate).toBeLessThan(limits.warningThreshold);
  });
});

describe('Slice B microcompaction old tool-result eviction', () => {
  it('clears only old tool-result content and keeps the last three tool results verbatim', () => {
    const limits = { maxTokens: 100_000, maxEntries: 100, warningThreshold: 90_000 };
    const messages = toolHistory(5);

    const prepared = bridge.prepareForProvider(JSON.parse(JSON.stringify(messages)), limits);
    const tools = toolMessages(prepared);

    expect(tools).toHaveLength(5);
    expect(tools[0]).toMatchObject({
      toolCallId: 'call_0',
      name: 'read_file',
      content: bridge.EVICTED_TOOL_RESULT_MARKER,
    });
    expect(tools[1]).toMatchObject({
      toolCallId: 'call_1',
      name: 'read_file',
      content: bridge.EVICTED_TOOL_RESULT_MARKER,
    });
    expect(tools.slice(2).map((msg) => msg.content)).toEqual(['payload-2', 'payload-3', 'payload-4']);
    expect(tools[0].content).toContain('re-run the relevant tool or query');
    expect(tools[0].content).not.toContain('agent_task_result');
    expect(tools[0].content).not.toContain('full payload');
  });

  it('clears array-content old tool results to the same honest marker string', () => {
    const messages = toolHistory(4, (index) => (index === 0
      ? [{ type: 'text', text: 'array payload' }]
      : `payload-${index}`));

    const evicted = bridge.evictOldToolResults(JSON.parse(JSON.stringify(messages)));
    const tools = toolMessages(evicted);

    expect(tools).toHaveLength(4);
    expect(tools[0].content).toBe(bridge.EVICTED_TOOL_RESULT_MARKER);
    expect(tools[1].content).toBe('payload-1');
    expect(tools[2].content).toBe('payload-2');
    expect(tools[3].content).toBe('payload-3');
  });

  it('is idempotent and keeps compaction metadata non-enumerable', () => {
    const limits = { maxTokens: 100_000, maxEntries: 100, warningThreshold: 90_000 };
    const messages = toolHistory(6);

    const first = bridge.prepareForProvider(JSON.parse(JSON.stringify(messages)), limits);
    const second = bridge.prepareForProvider(JSON.parse(JSON.stringify(first)), limits);

    expect(second).toEqual(first);
    expect(Object.prototype.propertyIsEnumerable.call(first, '_compactionMeta')).toBe(false);
    expect(first._compactionMeta).toMatchObject({
      evictedToolResults: 3,
      keptRecentToolResults: 3,
    });
    expect(JSON.stringify(first)).not.toContain('_compactionMeta');
  });

  it('does not mutate already-small histories or already-evicted marker content', () => {
    const small = toolHistory(3);
    expect(bridge.evictOldToolResults(JSON.parse(JSON.stringify(small)))).toEqual(small);

    const alreadyEvicted = toolHistory(4);
    alreadyEvicted[3].content = bridge.EVICTED_TOOL_RESULT_MARKER;

    const evicted = bridge.evictOldToolResults(JSON.parse(JSON.stringify(alreadyEvicted)));

    expect(evicted).toEqual(alreadyEvicted);
  });
});

describe('Slice C microcompaction emergency truncation', () => {
  it('loops over protected messages until the result is under the hard token limit', () => {
    const large = 'x'.repeat(8_000);
    const messages = [
      { role: 'system', content: `system ${large}` },
      { role: 'user', content: `first ${large}` },
      { role: 'user', content: `latest ${large}` },
    ];
    const limits = { maxTokens: 1_000, maxEntries: 20, warningThreshold: 900 };

    const trimmed = bridge.trimMessages(JSON.parse(JSON.stringify(messages)), limits);
    const retrimmed = bridge.trimMessages(JSON.parse(JSON.stringify(trimmed)), limits);

    expect(totalTokens(trimmed)).toBeLessThanOrEqual(limits.maxTokens);
    expect(retrimmed).toEqual(trimmed);
    expect(trimmed).toHaveLength(3);
    expect(trimmed[0].role).toBe('system');
    expect(trimmed[1].content).toContain('[EMERGENCY TRUNCATION: content exceeded 1000 token limit.');
    expect(trimmed[2].role).toBe('user');
    expect(JSON.stringify(trimmed)).not.toContain('agent_task_result');
  });

  it('truncates protected array text content without returning over-limit', () => {
    const messages = [
      { role: 'system', content: 'system' },
      { role: 'user', content: [{ type: 'text', text: 'α'.repeat(7_000) }] },
    ];
    const limits = { maxTokens: 900, maxEntries: 10, warningThreshold: 800 };

    const trimmed = bridge.trimMessages(JSON.parse(JSON.stringify(messages)), limits);

    expect(totalTokens(trimmed)).toBeLessThanOrEqual(limits.maxTokens);
    expect(trimmed[1].content[0].text).toContain('[EMERGENCY TRUNCATION: content exceeded 900 token limit]');
    expect(JSON.stringify(trimmed)).not.toContain('agent_task_result');
  });
});

describe('Slice D microcompaction structured result truncation', () => {
  it('does not splice large single-line JSON into an invalid JSON fragment', () => {
    const content = JSON.stringify({
      key: 'v'.repeat(100_000),
      nested: { a: 1 },
    });
    const limits = { maxTokens: 4_000, maxEntries: 20 };

    const truncated = bridge.truncateToolResult(content, 'read_file', limits);
    const parsed = JSON.parse(truncated);

    expect(parsed).toMatchObject({
      truncated: true,
      message: bridge.STRUCTURED_RESULT_TRUNCATED_MARKER,
      toolName: 'read_file',
    });
    expect(parsed.preview).toBeTypeOf('string');
    expect(parsed.preview.startsWith('{"key":"')).toBe(true);
    expect(parsed.message).not.toContain('agent_task_result');
    expect(truncated.startsWith('{')).toBe(true);
    expect(truncated.trimEnd().endsWith('}')).toBe(true);
  });

  it('passes small JSON through unchanged', () => {
    const content = JSON.stringify({ ok: true });
    const limits = { maxTokens: 4_000, maxEntries: 20 };

    expect(bridge.truncateToolResult(content, 'read_file', limits)).toBe(content);
  });

  it('wraps pretty-printed oversized JSON instead of line-splicing it', () => {
    const content = JSON.stringify({
      rows: Array.from({ length: 80 }, (_, index) => ({
        index,
        value: 'x'.repeat(180),
      })),
    }, null, 2);
    const limits = { maxTokens: 4_000, maxEntries: 20 };

    const parsed = JSON.parse(bridge.truncateToolResult(content, 'read_file', limits));

    expect(parsed.truncated).toBe(true);
    expect(parsed.message).toBe(bridge.STRUCTURED_RESULT_TRUNCATED_MARKER);
    expect(parsed.preview.startsWith('{\n  "rows"')).toBe(true);
  });

  it('keeps non-JSON line-based truncation behavior for text blobs', () => {
    const content = Array.from({ length: 80 }, (_, index) => `line-${index} ${'x'.repeat(180)}`).join('\n');
    const limits = { maxTokens: 4_000, maxEntries: 20 };

    const truncated = bridge.truncateToolResult(content, 'read_file', limits);

    expect(truncated).toContain('[TRUNCATED]');
    expect(truncated).toContain('line-0');
    expect(truncated).toContain('line-79');
    expect(() => JSON.parse(truncated)).toThrow();
  });
});

describe('Slice E microcompaction persisted history and final result disclosure', () => {
  it('caps persisted conversation history by dropping whole logical units', () => {
    const history = toolHistory(6);

    const compacted = bridge.compactPersistedConversationHistory(history, { maxEntries: 6 });
    const serialized = JSON.stringify(compacted);

    expect(compacted.length).toBeLessThanOrEqual(6);
    expect(compacted[0]).toEqual(history[0]);
    expect(compacted[1]).toEqual(history[1]);
    expect(compacted.at(-1)).toEqual(history.at(-1));
    expect(serialized).not.toContain('call_0');
    expect(serialized).not.toContain('payload-0');
    expect(serialized).toContain('call_5');
    expect(serialized).toContain('payload-5');
    assertNoDanglingToolPairs(compacted);
  });

  it('cleans persisted orphan tool results and incomplete assistant calls', () => {
    const history = [
      { role: 'user', content: 'first' },
      {
        role: 'assistant',
        content: 'I tried a tool',
        toolCalls: [{ id: 'missing', type: 'function', function: { name: 'read_file', arguments: '{}' } }],
      },
      { role: 'tool', toolCallId: 'orphan', name: 'read_file', content: 'orphan payload' },
    ];

    const compacted = bridge.compactPersistedConversationHistory(history, { maxEntries: 20 });

    expect(compacted).toEqual([
      { role: 'user', content: 'first' },
      { role: 'assistant', content: 'I tried a tool' },
    ]);
    assertNoDanglingToolPairs(compacted);
  });

  it('adds final-result disclosure fields for queen collection and agent_task_result recovery', () => {
    const fullContent = 'z'.repeat(12_000);
    const lastResult = bridge.buildProviderLastResult(
      {
        content: fullContent,
        model: 'gpt-5.5',
        usage: { totalTokens: 123 },
        cost: 0.42,
      },
      { model: 'fallback-model' },
      { iterations: 1, tools: ['read_file'] },
      '/tmp/task-abc123.result.json',
    );

    expect(lastResult.content).toHaveLength(10_240);
    expect(lastResult.summary).toHaveLength(200);
    expect(lastResult.truncated).toBe(true);
    expect(lastResult.originalLength).toBe(fullContent.length);
    expect(lastResult.taskId).toBe('task-abc123');
    expect(lastResult.retrievalHint).toBe(
      'Result truncated (12000 chars). Call agent_task_result({taskId:"task-abc123"}) for full final payload.',
    );
    expect(lastResult.model).toBe('gpt-5.5');
    expect(lastResult.usage.totalTokens).toBe(123);
    expect(lastResult.toolUse.tools).toEqual(['read_file']);
  });
});
