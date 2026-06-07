import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

export const DEFAULT_LLM_JURY_BUDGET_MAX_CALLS = 12;
export const DEFAULT_LLM_JURY_BUDGET_WINDOW_MS = 5 * 60 * 1000;

interface BudgetState {
  windowStart: number;
  count: number;
}

export interface LLMJuryBudgetOptions {
  maxCalls?: number;
  windowMs?: number;
  budgetDir?: string;
  nowMs?: number;
}

function sanitizeSessionId(sessionId: string): string {
  const safe = sessionId.replace(/[^a-zA-Z0-9._-]+/g, '_').slice(0, 120);
  return safe || 'unknown-session';
}

function budgetPath(sessionId: string, budgetDir?: string): string {
  const root = budgetDir || join(homedir(), '.hive-flow', 'permission-guard');
  return join(root, `llm-jury-budget-${sanitizeSessionId(sessionId)}.json`);
}

function readState(path: string, nowMs: number): BudgetState {
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as Partial<BudgetState>;
    return {
      windowStart: typeof parsed.windowStart === 'number' ? parsed.windowStart : nowMs,
      count: typeof parsed.count === 'number' ? parsed.count : 0,
    };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return { windowStart: nowMs, count: 0 };
    }
    throw error;
  }
}

function writeState(path: string, state: BudgetState): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmpPath = `${path}.${process.pid}.${Date.now()}.tmp`;
  writeFileSync(tmpPath, JSON.stringify(state), 'utf8');
  renameSync(tmpPath, path);
}

/**
 * Consume one LLM jury budget unit for a Claude session.
 *
 * The permission gate runs as a fresh process for every hook call, so this is
 * intentionally file-backed. Accounting failure is treated as over-budget:
 * the gate falls back to deterministic inline behavior and spends no LLM call.
 */
export function tryConsumeLLMJuryBudget(sessionId: string, options: LLMJuryBudgetOptions = {}): boolean {
  const maxCalls = options.maxCalls ?? DEFAULT_LLM_JURY_BUDGET_MAX_CALLS;
  const windowMs = options.windowMs ?? DEFAULT_LLM_JURY_BUDGET_WINDOW_MS;
  if (maxCalls <= 0 || windowMs <= 0) return false;

  try {
    const nowMs = options.nowMs ?? Date.now();
    const path = budgetPath(sessionId, options.budgetDir);
    let state = readState(path, nowMs);
    if (nowMs - state.windowStart >= windowMs) {
      state = { windowStart: nowMs, count: 0 };
    }
    if (state.count >= maxCalls) return false;
    writeState(path, { windowStart: state.windowStart, count: state.count + 1 });
    return true;
  } catch {
    return false;
  }
}
