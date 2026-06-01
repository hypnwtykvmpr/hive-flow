import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { propertyRunsFromEnv } from './property-runs.js';

const PROPERTY_RUNS = propertyRunsFromEnv(200);

const require = createRequire(import.meta.url);
const here = dirname(fileURLToPath(import.meta.url));
const agentRewake = require(resolve(here, '../../../../../.claude/helpers/agent-task-rewake.cjs'));
const drain = require(resolve(here, '../../../../../.claude/helpers/drain-notifications.cjs'));

function makeTempProject(): string {
  return mkdtempSync(join(tmpdir(), 'hive-flow-sentinel-'));
}

function writeResult(root: string, taskId: string, result: unknown): void {
  const taskDir = join(root, '.hive-flow', 'tasks');
  mkdirSync(taskDir, { recursive: true });
  writeFileSync(join(taskDir, `${taskId}.result.json`), JSON.stringify(result));
}

describe('sentinel agent task rewake', () => {
  it('extracts task ids from known Claude Code PostToolUse payload shapes', () => {
    const chars = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-'.split('');
    const taskSuffix = fc.array(fc.constantFrom(...chars), { minLength: 1, maxLength: 32 }).map((parts) => parts.join(''));
    const field = fc.constantFrom('tool_input', 'toolInput', 'tool_response', 'toolResponse', 'tool_result', 'response');

    fc.assert(
      fc.property(taskSuffix, field, fc.boolean(), (suffix, key, stringifyInner) => {
        const taskId = `task-${suffix}`;
        const inner = { success: true, taskId, status: 'running' };
        const payload = JSON.stringify({ [key]: stringifyInner ? JSON.stringify(inner) : inner });
        expect(agentRewake.extractTaskId(payload)).toBe(taskId);
      }),
      { seed: 20_611, numRuns: PROPERTY_RUNS },
    );
  });

  it('ignores malformed or unsupported task ids without throwing', () => {
    fc.assert(
      fc.property(fc.string(), (raw) => {
        const result = agentRewake.extractTaskId(raw);
        expect(result === null || /^task-[A-Za-z0-9-]+$/.test(result)).toBe(true);
      }),
      { seed: 20_612, numRuns: PROPERTY_RUNS },
    );
  });

  it('claims completion once and writes one pending notification', () => {
    const root = makeTempProject();
    try {
      const taskId = 'task-demo-123';
      writeResult(root, taskId, { success: true, result: { agentId: 'agent-a', content: 'done' } });

      const first = agentRewake.notifyCompletedTaskIfReady(root, taskId);
      const second = agentRewake.notifyCompletedTaskIfReady(root, taskId);

      expect(first.notified).toBe(true);
      expect(first.summary).toContain('[TASK COMPLETE: task-demo-123]');
      expect(second).toEqual({ notified: false, reason: 'already-notified' });

      const pending = readFileSync(join(root, '.hive-flow', 'data', 'pending-notifications.jsonl'), 'utf8')
        .trim()
        .split('\n');
      expect(pending).toHaveLength(1);
      expect(existsSync(join(root, '.hive-flow', 'data', 'task-task-demo-123.notified'))).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('drains pending notifications once and recovers previous draining files', () => {
    const root = makeTempProject();
    try {
      const dataDir = join(root, '.hive-flow', 'data');
      mkdirSync(dataDir, { recursive: true });
      const summary = '[TASK COMPLETE: task-a] agent=agent-a status=completed.';
      writeFileSync(
        join(dataDir, 'pending-notifications.jsonl'),
        `${JSON.stringify({ taskId: 'task-a', summary })}\n${JSON.stringify({ taskId: 'task-a', summary })}\n`,
      );
      writeFileSync(
        join(dataDir, 'pending-notifications.jsonl.draining-old'),
        `${JSON.stringify({ taskId: 'task-b', summary: '[TASK COMPLETE: task-b] status=completed.' })}\n`,
      );

      const output = drain.drainNotifications(root);
      const context = output.hookSpecificOutput.additionalContext;
      expect(output.hookSpecificOutput.hookEventName).toBe('UserPromptSubmit');
      expect(context.match(/task-a/g)).toHaveLength(1);
      expect(context).toContain('task-b');

      expect(drain.drainNotifications(root)).toEqual({});
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
