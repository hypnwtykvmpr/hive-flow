import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AuditLogEntry, GateResult, HookInput, InlineJuryResult, PermissionConfig, RiskLevel } from '../types.js';

interface GateRun {
  result: GateResult;
  entries: AuditLogEntry[];
}

interface Harness {
  evaluate: (hookInput: HookInput, config: Partial<PermissionConfig>) => Promise<GateResult>;
  mergeWithDefaults: (config: Partial<PermissionConfig>) => PermissionConfig;
  evaluateInlineJury: ReturnType<typeof vi.fn>;
  evaluateLLMJury: ReturnType<typeof vi.fn>;
  recordVerdict: ReturnType<typeof vi.fn>;
  normalizeCommand: ReturnType<typeof vi.fn>;
}

const tempRoots: string[] = [];

afterEach(() => {
  vi.resetModules();
  vi.restoreAllMocks();
  vi.doUnmock('../jury-evaluator.js');
  vi.doUnmock('../llm-jury.js');
  vi.doUnmock('../vote-learner.js');
  for (const root of tempRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

function makeTempRoot(name: string): string {
  const root = mkdtempSync(join(tmpdir(), `${name}-`));
  tempRoots.push(root);
  return root;
}

function ambiguous(fallbackVerdict: 'APPROVED' | 'DENIED', maxRisk: RiskLevel): InlineJuryResult {
  return {
    verdict: 'AMBIGUOUS',
    votes: {},
    reason: `inline jury ambiguous; fallback ${fallbackVerdict}`,
    fallbackVerdict,
    maxRisk,
  } as InlineJuryResult;
}

function approved(): InlineJuryResult {
  return {
    verdict: 'APPROVED',
    votes: {},
    reason: 'inline approved',
  } as InlineJuryResult;
}

function bashInput(command: string, sessionId = 'llm-jury-seam-session'): HookInput {
  return {
    tool_name: 'Bash',
    tool_input: { command },
    cwd: '/project',
    session_id: sessionId,
  };
}

function malformedInput(sessionId = 'llm-jury-malformed-session'): HookInput {
  return {
    tool_name: '',
    tool_input: {},
    cwd: '/project',
    session_id: sessionId,
  };
}

async function loadHarness(options: {
  inlineResult?: InlineJuryResult;
  mockLLM?: boolean;
} = {}): Promise<Harness> {
  const evaluateInlineJury = vi.fn(() => options.inlineResult ?? ambiguous('APPROVED', 'low'));
  const evaluateLLMJury = vi.fn();
  const recordVerdict = vi.fn();
  const normalizeCommand = vi.fn((cmd: string) => `normalized:${cmd}`);
  const checkLearnedPattern = vi.fn(() => null);

  vi.doMock('../jury-evaluator.js', () => ({ evaluateInlineJury }));
  vi.doMock('../vote-learner.js', () => ({ checkLearnedPattern, normalizeCommand, recordVerdict }));
  if (options.mockLLM !== false) {
    vi.doMock('../llm-jury.js', () => ({ evaluateLLMJury }));
  } else {
    vi.doUnmock('../llm-jury.js');
  }

  const [{ evaluate }, { mergeWithDefaults }] = await Promise.all([
    import('../gate.js'),
    import('../default-config.js'),
  ]);

  return { evaluate, mergeWithDefaults, evaluateInlineJury, evaluateLLMJury, recordVerdict, normalizeCommand };
}

async function evaluateWithLog(
  harness: Harness,
  input: HookInput,
  root: string,
  config: Partial<PermissionConfig> = {},
): Promise<GateRun> {
  const logFile = join(root, 'permission-log.jsonl');
  const result = await harness.evaluate(input, harness.mergeWithDefaults({
    always_allow_bash_patterns: [],
    always_deny_bash_patterns: [],
    jury_escalation_bash_patterns: [],
    log_file: logFile,
    llm_jury_budget_dir: join(root, 'budget'),
    llm_jury_budget_max_calls: 12,
    llm_jury_budget_window_ms: 300_000,
    ...config,
  } as Partial<PermissionConfig>));
  const entries = readFileSync(logFile, 'utf8')
    .trim()
    .split('\n')
    .filter(Boolean)
    .map(line => JSON.parse(line) as AuditLogEntry);
  return { result, entries };
}

function lastLayer(run: GateRun): string | undefined {
  return run.entries.at(-1)?.layer;
}

describe('Stage-2 LLM jury seam', () => {
  it('does not teach the vote learner for inline-only approvals', async () => {
    const root = makeTempRoot('llm-jury-inline-approved');
    const harness = await loadHarness({ inlineResult: approved() });

    const run = await evaluateWithLog(harness, bashInput('custom --inline-approved'), root);

    expect(run.result.decision).toBe('allow');
    expect(lastLayer(run)).toBe('inline-jury');
    expect(harness.evaluateLLMJury).not.toHaveBeenCalled();
    expect(harness.recordVerdict).not.toHaveBeenCalled();
  });

  it('routes ambiguous inline approval through LLM approval and teaches the vote learner', async () => {
    const root = makeTempRoot('llm-jury-approve');
    const harness = await loadHarness({ inlineResult: ambiguous('APPROVED', 'low') });
    harness.evaluateLLMJury.mockResolvedValue({
      verdict: 'APPROVED',
      votes: [],
      reason: 'LLM jury approved the benign command',
      totalLatencyMs: 7,
    });

    const run = await evaluateWithLog(harness, bashInput('custom --maybe'), root);

    expect(run.result.decision).toBe('allow');
    expect(lastLayer(run)).toBe('llm-jury');
    expect(harness.evaluateLLMJury).toHaveBeenCalledTimes(1);
    expect(harness.recordVerdict).toHaveBeenCalledWith('Bash', 'normalized:custom --maybe', 'allow');
  });

  it('routes ambiguous inline denial through LLM denial', async () => {
    const root = makeTempRoot('llm-jury-deny');
    const harness = await loadHarness({ inlineResult: ambiguous('DENIED', 'high') });
    harness.evaluateLLMJury.mockResolvedValue({
      verdict: 'DENIED',
      votes: [],
      reason: 'LLM jury denied the risky command',
      totalLatencyMs: 5,
    });

    const run = await evaluateWithLog(harness, bashInput('custom --risky'), root);

    expect(run.result.decision).toBe('deny');
    expect(lastLayer(run)).toBe('llm-jury');
    expect(harness.evaluateLLMJury).toHaveBeenCalledTimes(1);
    expect(harness.recordVerdict).not.toHaveBeenCalled();
  });

  it('falls back without calling the LLM once the per-session budget is exhausted', async () => {
    const root = makeTempRoot('llm-jury-budget');
    const harness = await loadHarness({ inlineResult: ambiguous('APPROVED', 'low') });
    harness.evaluateLLMJury.mockResolvedValue({
      verdict: 'APPROVED',
      votes: [],
      reason: 'first ambiguous call approved',
      totalLatencyMs: 2,
    });
    const config = {
      llm_jury_budget_dir: join(root, 'budget'),
      llm_jury_budget_max_calls: 1,
    } as Partial<PermissionConfig>;

    await evaluateWithLog(harness, bashInput('custom --first', 'budget-session'), root, config);
    harness.evaluateLLMJury.mockClear();
    harness.recordVerdict.mockClear();
    harness.evaluateInlineJury.mockReturnValue(ambiguous('DENIED', 'high'));

    const run = await evaluateWithLog(harness, bashInput('custom --second', 'budget-session'), root, config);

    expect(run.result.decision).toBe('deny');
    expect(lastLayer(run)).toBe('inline-jury');
    expect(harness.evaluateLLMJury).not.toHaveBeenCalled();
    expect(harness.recordVerdict).not.toHaveBeenCalled();
  });

  it('denies malformed no-subject input without entering the LLM path', async () => {
    const root = makeTempRoot('llm-jury-malformed');
    const harness = await loadHarness({ inlineResult: ambiguous('APPROVED', 'low') });
    harness.evaluateLLMJury.mockResolvedValue({
      verdict: 'APPROVED',
      votes: [],
      reason: 'should not be called',
      totalLatencyMs: 1,
    });

    const run = await evaluateWithLog(harness, malformedInput(), root);

    expect(run.result.decision).toBe('deny');
    expect(harness.evaluateLLMJury).not.toHaveBeenCalled();
    expect(harness.recordVerdict).not.toHaveBeenCalled();
  });

  it('falls back to the inline risk default when the provider is unavailable', async () => {
    const root = makeTempRoot('llm-jury-null');
    const harness = await loadHarness({ inlineResult: ambiguous('APPROVED', 'low') });
    harness.evaluateLLMJury.mockResolvedValue(null);

    const run = await evaluateWithLog(harness, bashInput('custom --provider-null'), root);

    expect(run.result.decision).toBe('allow');
    expect(lastLayer(run)).toBe('inline-jury');
    expect(harness.evaluateLLMJury).toHaveBeenCalledTimes(1);
  });

  it('falls back immediately on timeout verdicts instead of treating them as LLM decisions', async () => {
    const root = makeTempRoot('llm-jury-timeout');
    const harness = await loadHarness({ inlineResult: ambiguous('APPROVED', 'low') });
    harness.evaluateLLMJury.mockResolvedValue({
      verdict: 'TIMEOUT_DENY',
      votes: [],
      reason: 'timed out',
      totalLatencyMs: 12_000,
    });
    const startedAt = Date.now();

    const run = await evaluateWithLog(harness, bashInput('custom --timeout'), root);

    expect(Date.now() - startedAt).toBeLessThan(250);
    expect(run.result.decision).toBe('allow');
    expect(lastLayer(run)).toBe('inline-jury');
  });

  it('preserves current ambiguous fallback behavior when the real provider module is unavailable', async () => {
    const root = makeTempRoot('llm-jury-real-null');
    const harness = await loadHarness({ inlineResult: ambiguous('APPROVED', 'low'), mockLLM: false });

    const lowRun = await evaluateWithLog(harness, bashInput('custom --real-provider-null-low', 'real-null-low'), root);
    harness.evaluateInlineJury.mockReturnValue(ambiguous('DENIED', 'high'));
    const highRun = await evaluateWithLog(harness, bashInput('custom --real-provider-null-high', 'real-null-high'), root);

    expect(lowRun.result.decision).toBe('allow');
    expect(lastLayer(lowRun)).toBe('inline-jury');
    expect(highRun.result.decision).toBe('deny');
    expect(lastLayer(highRun)).toBe('inline-jury');
  });
});
