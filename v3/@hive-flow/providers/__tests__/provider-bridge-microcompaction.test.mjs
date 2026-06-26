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

function expectedWarningThreshold(maxTokens) {
  return Math.max(
    Math.floor(maxTokens * 0.5),
    Math.min(Math.floor(maxTokens * 0.85), maxTokens - 40000),
  );
}

function totalTokens(messages, estimator = bridge.estimateTokensFromText) {
  return messages.reduce((sum, msg) => sum + textMessageTokens(String(msg.content ?? ''), estimator), 0);
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
