import { spawnSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { propertyRunsFromEnv } from './property-runs.js';
import { sessionKeyFor } from '@hive-flow/shared';

const PROPERTY_RUNS = propertyRunsFromEnv(200);

const require = createRequire(import.meta.url);
const here = dirname(fileURLToPath(import.meta.url));
const agentRewakeScript = resolve(here, '../../../../../.claude/helpers/agent-task-rewake.cjs');
const agentRewake = require(agentRewakeScript);
const drain = require(resolve(here, '../../../../../.claude/helpers/drain-notifications.cjs'));
const hiveRewakeScript = resolve(here, '../../../../../.claude/helpers/hive-completion-rewake.cjs');
const hiveRewake = require(hiveRewakeScript);
const dedup = require(resolve(here, '../../../../../.claude/helpers/dedup-marker.cjs'));
const mutableFs = require('node:fs');

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

      const first = agentRewake.notifyCompletedTaskIfReady(root, taskId, {
        sessionInput: { client_kind: 'claude-code' },
        env: {},
      });
      const second = agentRewake.notifyCompletedTaskIfReady(root, taskId, {
        sessionInput: { client_kind: 'claude-code' },
        env: {},
      });

      expect(first.notified).toBe(true);
      expect(first.summary).toContain('[TASK COMPLETE: task-demo-123]');
      expect(second).toEqual({ notified: false, reason: 'already-notified' });

      const pending = readFileSync(join(root, '.hive-flow', 'data', 'pending-notifications.jsonl'), 'utf8')
        .trim()
        .split('\n');
      expect(pending).toHaveLength(1);
      expect(JSON.parse(pending[0])).toMatchObject({ kind: 'task', taskId, targetAgent: 'claude' });
      expect(existsSync(join(root, '.hive-flow', 'data', 'task-task-demo-123.notified'))).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('mirrors agent task completion into the global wake session queue', () => {
    const root = makeTempProject();
    const home = makeTempProject();
    try {
      const taskId = 'task-global-rewake';
      writeResult(root, taskId, { success: true, result: { agentId: 'agent-b', content: 'done' } });

      const result = agentRewake.notifyCompletedTaskIfReady(root, taskId, {
        sessionInput: {
          session_id: 'codex-session-a',
          client_kind: 'codex',
        },
        env: {
          HIVE_FLOW_HOME: home,
        },
      });

      expect(result.notified).toBe(true);

      const localPending = join(root, '.hive-flow', 'data', 'pending-notifications.jsonl');
      const globalPending = join(
        home,
        'wake',
        'sessions',
        sessionKeyFor({ session_id: 'codex-session-a', client_kind: 'codex' }, {}),
        'pending-notifications.jsonl',
      );
      expect(readFileSync(localPending, 'utf8')).toContain(taskId);
      expect(readFileSync(globalPending, 'utf8')).toContain(taskId);
    } finally {
      rmSync(root, { recursive: true, force: true });
      rmSync(home, { recursive: true, force: true });
    }
  });

  it('defaults Claude hook ownership and wake session keys to Claude when client kind is absent', () => {
    const root = makeTempProject();
    const home = makeTempProject();
    try {
      const taskId = 'task-claude-default-owner';
      writeResult(root, taskId, { success: true, result: { agentId: 'agent-c', content: 'done' } });

      const result = agentRewake.notifyCompletedTaskIfReady(root, taskId, {
        sessionInput: { session_id: 'claude-session-default-owner' },
        env: { HIVE_FLOW_HOME: home },
      });

      expect(result.notified).toBe(true);

      const localPending = join(root, '.hive-flow', 'data', 'pending-notifications.jsonl');
      const globalPending = join(
        home,
        'wake',
        'sessions',
        sessionKeyFor({ session_id: 'claude-session-default-owner', client_kind: 'claude-code' }, {}),
        'pending-notifications.jsonl',
      );
      const local = readFileSync(localPending, 'utf8');
      expect(local).toContain(taskId);
      expect(local).toContain('"targetAgent":"claude"');
      expect(readFileSync(globalPending, 'utf8')).toContain(taskId);
    } finally {
      rmSync(root, { recursive: true, force: true });
      rmSync(home, { recursive: true, force: true });
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

  it('does not let Claude drain Codex-targeted repo fallback notifications', () => {
    const root = makeTempProject();
    try {
      const dataDir = join(root, '.hive-flow', 'data');
      mkdirSync(dataDir, { recursive: true });
      writeFileSync(
        join(dataDir, 'pending-notifications.jsonl'),
        [
          JSON.stringify({
            kind: 'task',
            taskId: 'task-codex-owned',
            targetAgent: 'codex',
            summary: '[TASK COMPLETE: task-codex-owned] done',
          }),
          JSON.stringify({
            kind: 'task',
            taskId: 'task-claude-owned',
            targetAgent: 'claude',
            summary: '[TASK COMPLETE: task-claude-owned] done',
          }),
        ].join('\n') + '\n',
      );

      const output = drain.drainNotifications(root, { client_kind: 'claude-code' });
      const context = output.hookSpecificOutput.additionalContext;
      expect(context).toContain('task-claude-owned');
      expect(context).not.toContain('task-codex-owned');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('lets hive completion supersede an earlier same-key check-due notification', () => {
    const summaries = drain.parseSummariesFromLines([
      JSON.stringify({
        kind: 'hive-check',
        hiveId: 'hive-supersede',
        summary: '[HIVE CHECK DUE: hive-supersede] poll',
      }),
      JSON.stringify({
        kind: 'hive',
        hiveId: 'hive-supersede',
        summary: '[HIVE COMPLETE: hive-supersede] done',
      }),
    ]);

    expect(summaries).toEqual(['- [HIVE COMPLETE: hive-supersede] done']);
  });

  it('keeps first same-key hive completion when check-due arrives after completion', () => {
    const summaries = drain.parseSummariesFromLines([
      JSON.stringify({
        kind: 'hive',
        hiveId: 'hive-reverse',
        summary: '[HIVE COMPLETE: hive-reverse] done',
      }),
      JSON.stringify({
        kind: 'hive-check',
        hiveId: 'hive-reverse',
        summary: '[HIVE CHECK DUE: hive-reverse] poll',
      }),
    ]);

    expect(summaries).toEqual(['- [HIVE COMPLETE: hive-reverse] done']);
  });

  it('lets task completion supersede an earlier same-key task check-due notification', () => {
    const summaries = drain.parseSummariesFromLines([
      JSON.stringify({
        kind: 'task-check',
        taskId: 'task-supersede',
        summary: '[TASK CHECK DUE: task-supersede] poll',
      }),
      JSON.stringify({
        kind: 'task',
        taskId: 'task-supersede',
        summary: '[TASK COMPLETE: task-supersede] done',
      }),
    ]);

    expect(summaries).toEqual(['- [TASK COMPLETE: task-supersede] done']);
  });

  it('keeps first same-key notification for same-type and missing-kind lines', () => {
    expect(drain.parseSummariesFromLines([
      JSON.stringify({
        kind: 'hive',
        hiveId: 'hive-same-kind',
        summary: '[HIVE COMPLETE: hive-same-kind] first',
      }),
      JSON.stringify({
        kind: 'hive',
        hiveId: 'hive-same-kind',
        summary: '[HIVE COMPLETE: hive-same-kind] second',
      }),
    ])).toEqual(['- [HIVE COMPLETE: hive-same-kind] first']);

    expect(drain.parseSummariesFromLines([
      JSON.stringify({
        taskId: 'task-missing-kind',
        summary: '[TASK COMPLETE: task-missing-kind] first',
      }),
      JSON.stringify({
        kind: 'task',
        taskId: 'task-missing-kind',
        summary: '[TASK COMPLETE: task-missing-kind] second',
      }),
    ])).toEqual(['- [TASK COMPLETE: task-missing-kind] first']);
  });

  it('claims hive timeout rewake once per polling interval without suppressing later completion', () => {
    const root = makeTempProject();
    try {
      const payload = JSON.stringify({ tool_input: { hiveId: 'hive-timeout-dedupe' } });
      const pollPayload = JSON.stringify({
        tool_name: 'mcp__hive-flow__hive_poll_workers',
        tool_input: { hiveId: 'hive-timeout-dedupe' },
        tool_response: { allWorkersSettled: false, runningCount: 1 },
      });
      const env = {
        ...process.env,
        CLAUDE_PROJECT_DIR: root,
        HIVE_FLOW_REWAKE_MAX_WAIT_MS: '1',
        HIVE_FLOW_REWAKE_POLL_MS: '1',
      };

      const first = spawnSync(process.execPath, [hiveRewakeScript], {
        input: payload,
        env,
        encoding: 'utf8',
      });
      const second = spawnSync(process.execPath, [hiveRewakeScript], {
        input: payload,
        env,
        encoding: 'utf8',
      });

      expect(first.status).toBe(2);
      expect(first.stderr).toContain('[HIVE CHECK DUE: hive-timeout-dedupe]');
      expect(second.status).toBe(0);
      expect(second.stderr).toBe('');

      const dataDir = join(root, '.hive-flow', 'data');
      let pending = readFileSync(join(dataDir, 'pending-notifications.jsonl'), 'utf8')
        .trim()
        .split('\n');
      expect(pending).toHaveLength(1);
      expect(JSON.parse(pending[0])).toMatchObject({
        kind: 'hive-check',
        hiveId: 'hive-timeout-dedupe',
      });
      expect(existsSync(join(dataDir, 'hive-hive-timeout-dedupe.check-due'))).toBe(true);
      expect(existsSync(join(dataDir, 'hive-hive-timeout-dedupe.acked'))).toBe(false);

      const restarted = spawnSync(process.execPath, [hiveRewakeScript], {
        input: pollPayload,
        env,
        encoding: 'utf8',
      });
      expect(restarted.status).toBe(2);
      expect(restarted.stderr).toContain('[HIVE CHECK DUE: hive-timeout-dedupe]');
      pending = readFileSync(join(dataDir, 'pending-notifications.jsonl'), 'utf8')
        .trim()
        .split('\n');
      expect(pending).toHaveLength(2);

      writeFileSync(
        join(dataDir, 'hive-hive-timeout-dedupe.done'),
        JSON.stringify({ hiveId: 'hive-timeout-dedupe', completedCount: 1, failedCount: 0 }),
      );
      const completed = spawnSync(process.execPath, [hiveRewakeScript], {
        input: payload,
        env,
        encoding: 'utf8',
      });
      expect(completed.status).toBe(2);
      expect(completed.stderr).toContain('[HIVE COMPLETE: hive-timeout-dedupe]');
      pending = readFileSync(join(dataDir, 'pending-notifications.jsonl'), 'utf8')
        .trim()
        .split('\n');
      expect(pending).toHaveLength(3);
      expect(JSON.parse(pending[2])).toMatchObject({
        kind: 'hive',
        hiveId: 'hive-timeout-dedupe',
      });
      expect(existsSync(join(dataDir, 'hive-hive-timeout-dedupe.acked'))).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('mirrors hive rewake completion into the global wake session queue', () => {
    const root = makeTempProject();
    const home = makeTempProject();
    try {
      const sessionId = 'rewake-session-a';
      const payload = JSON.stringify({
        session_id: sessionId,
        client_kind: 'claude-code',
        tool_response: {
          hiveId: 'hive-global-rewake',
          allWorkersSettled: true,
          completedCount: 1,
          failedCount: 0,
        },
      });
      const env = {
        ...process.env,
        CLAUDE_PROJECT_DIR: root,
        HIVE_FLOW_HOME: home,
        HIVE_FLOW_REWAKE_MAX_WAIT_MS: '1',
        HIVE_FLOW_REWAKE_POLL_MS: '1',
      };

      const completed = spawnSync(process.execPath, [hiveRewakeScript], {
        input: payload,
        env,
        encoding: 'utf8',
      });

      expect(completed.status).toBe(2);
      expect(completed.stderr).toContain('[HIVE COMPLETE: hive-global-rewake]');

      const localPending = join(root, '.hive-flow', 'data', 'pending-notifications.jsonl');
      const globalPending = join(
        home,
        'wake',
        'sessions',
        sessionKeyFor({ session_id: sessionId, client_kind: 'claude-code' }, {}),
        'pending-notifications.jsonl',
      );
      expect(readFileSync(localPending, 'utf8')).toContain('hive-global-rewake');
      expect(readFileSync(globalPending, 'utf8')).toContain('hive-global-rewake');
    } finally {
      rmSync(root, { recursive: true, force: true });
      rmSync(home, { recursive: true, force: true });
    }
  });

  it('does not leave an ack marker behind when pending notification append fails', () => {
    const root = makeTempProject();
    const realAppend = mutableFs.appendFileSync;
    try {
      const dataDir = join(root, '.hive-flow', 'data');
      mkdirSync(dataDir, { recursive: true });
      mutableFs.appendFileSync = () => {
        throw new Error('injected append failure');
      };

      const claimed = dedup.appendPendingWithAck(
        dataDir,
        'hive-crash-window',
        JSON.stringify({ kind: 'hive', hiveId: 'hive-crash-window' }),
        { source: 'test' },
      );

      expect(claimed).toBe(false);
      expect(existsSync(join(dataDir, 'hive-hive-crash-window.acked'))).toBe(false);
    } finally {
      mutableFs.appendFileSync = realAppend;
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('keeps pending notification lines when the ack claim loses a race', () => {
    const root = makeTempProject();
    const realAppend = mutableFs.appendFileSync;
    try {
      const dataDir = join(root, '.hive-flow', 'data');
      mkdirSync(dataDir, { recursive: true });
      const line = JSON.stringify({
        kind: 'hive',
        hiveId: 'hive-claim-race',
        summary: '[HIVE COMPLETE: hive-claim-race] done',
      });
      const concurrentLine = JSON.stringify({
        kind: 'hive',
        hiveId: 'hive-concurrent',
        summary: '[HIVE COMPLETE: hive-concurrent] done',
      });
      const ackPath = dedup.ackedPath(dataDir, 'hive-claim-race');
      let injected = false;
      mutableFs.appendFileSync = ((...args: unknown[]) => {
        Reflect.apply(realAppend, mutableFs, args);
        if (!injected) {
          injected = true;
          realAppend(join(dataDir, 'pending-notifications.jsonl'), `${concurrentLine}\n`);
          writeFileSync(ackPath, JSON.stringify({ source: 'competing-winner' }));
        }
      }) as typeof realAppend;

      const lost = dedup.appendPendingWithAck(dataDir, 'hive-claim-race', line, { source: 'test' });
      expect(lost).toBe(false);
      const pending = readFileSync(join(dataDir, 'pending-notifications.jsonl'), 'utf8')
        .trim()
        .split('\n');
      expect(pending).toHaveLength(2);
      expect(JSON.parse(pending[0])).toMatchObject({ kind: 'hive', hiveId: 'hive-claim-race' });
      expect(JSON.parse(pending[1])).toMatchObject({ kind: 'hive', hiveId: 'hive-concurrent' });
      expect(existsSync(ackPath)).toBe(true);

      mutableFs.appendFileSync = realAppend;
      const context = drain.drainNotifications(root).hookSpecificOutput.additionalContext;
      expect(context.match(/hive-claim-race/g)).toHaveLength(1);
      expect(context.match(/hive-concurrent/g)).toHaveLength(1);
    } finally {
      mutableFs.appendFileSync = realAppend;
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('does not let legacy hive completion markers suppress fresh notifications', () => {
    const root = makeTempProject();
    try {
      const dataDir = join(root, '.hive-flow', 'data');
      mkdirSync(dataDir, { recursive: true });
      const legacySuffixes = [
        'notified',
        ['rewake', 'notified'].join('-'),
        ['pending', 'notified'].join('-'),
      ];

      for (const [index, suffix] of legacySuffixes.entries()) {
        const hiveId = `legacy-${index}`;
        writeFileSync(join(dataDir, `hive-${hiveId}.${suffix}`), 'legacy');

        expect(dedup.isAlreadyAcked(dataDir, hiveId)).toBe(false);
        const ackPath = dedup.ackedPath(dataDir, hiveId);
        expect(dedup.appendPendingWithAck(
          dataDir,
          hiveId,
          JSON.stringify({ kind: 'hive', hiveId, summary: `[HIVE COMPLETE: ${hiveId}] done` }),
          { source: 'test' },
        )).toBe(true);
        const ack = readFileSync(ackPath, 'utf8');
        expect(ack).not.toContain('legacy-marker-migration');
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('keeps timeout nudges retryable when marker writes fail after append', () => {
    const root = makeTempProject();
    const realWrite = mutableFs.writeFileSync;
    try {
      const dataDir = join(root, '.hive-flow', 'data');
      mkdirSync(dataDir, { recursive: true });
      mutableFs.writeFileSync = ((...args: unknown[]) => {
        const target = String(args[0]);
        if (target.endsWith('.check-due')) throw new Error('injected marker failure');
        return Reflect.apply(realWrite, mutableFs, args);
      }) as typeof realWrite;

      const hiveLine = JSON.stringify({
        kind: 'hive-check',
        hiveId: 'hive-marker-crash',
        summary: '[HIVE CHECK DUE: hive-marker-crash] poll',
      });
      const taskLine = JSON.stringify({
        kind: 'task-check',
        taskId: 'task-marker-crash',
        summary: '[TASK CHECK DUE: task-marker-crash] poll',
      });

      expect(hiveRewake.appendTimeoutCheckOnce(dataDir, 'hive-marker-crash', hiveLine)).toBe(false);
      expect(agentRewake.appendTimeoutCheckOnce(dataDir, 'task-marker-crash', taskLine)).toBe(false);
      const pending = readFileSync(join(dataDir, 'pending-notifications.jsonl'), 'utf8')
        .trim()
        .split('\n');
      expect(pending).toHaveLength(2);
      expect(JSON.parse(pending[0])).toMatchObject({ kind: 'hive-check', hiveId: 'hive-marker-crash' });
      expect(JSON.parse(pending[1])).toMatchObject({ kind: 'task-check', taskId: 'task-marker-crash' });
      expect(existsSync(join(dataDir, 'hive-hive-marker-crash.check-due'))).toBe(false);
      expect(existsSync(join(dataDir, 'task-task-marker-crash.check-due'))).toBe(false);
    } finally {
      mutableFs.writeFileSync = realWrite;
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('claims agent-task timeout rewake once per polling interval without suppressing later completion', () => {
    const root = makeTempProject();
    try {
      const payload = JSON.stringify({ tool_response: { taskId: 'task-timeout-dedupe', status: 'running' } });
      const pollPayload = JSON.stringify({
        tool_name: 'mcp__hive-flow__agent_task_result',
        tool_input: { taskId: 'task-timeout-dedupe' },
        tool_response: { status: 'running' },
      });
      const env = {
        ...process.env,
        CLAUDE_PROJECT_DIR: root,
        HIVE_FLOW_REWAKE_MAX_WAIT_MS: '1',
        HIVE_FLOW_REWAKE_POLL_MS: '1',
      };

      const first = spawnSync(process.execPath, [agentRewakeScript], {
        input: payload,
        env,
        encoding: 'utf8',
      });
      const second = spawnSync(process.execPath, [agentRewakeScript], {
        input: payload,
        env,
        encoding: 'utf8',
      });

      expect(first.status).toBe(2);
      expect(first.stderr).toContain('[TASK CHECK DUE: task-timeout-dedupe]');
      expect(second.status).toBe(0);
      expect(second.stderr).toBe('');

      const dataDir = join(root, '.hive-flow', 'data');
      let pending = readFileSync(join(dataDir, 'pending-notifications.jsonl'), 'utf8')
        .trim()
        .split('\n');
      expect(pending).toHaveLength(1);
      expect(JSON.parse(pending[0])).toMatchObject({
        kind: 'task-check',
        taskId: 'task-timeout-dedupe',
      });
      expect(existsSync(join(dataDir, 'task-task-timeout-dedupe.check-due'))).toBe(true);
      expect(existsSync(join(dataDir, 'task-task-timeout-dedupe.notified'))).toBe(false);

      const restarted = spawnSync(process.execPath, [agentRewakeScript], {
        input: pollPayload,
        env,
        encoding: 'utf8',
      });
      expect(restarted.status).toBe(2);
      expect(restarted.stderr).toContain('[TASK CHECK DUE: task-timeout-dedupe]');
      pending = readFileSync(join(dataDir, 'pending-notifications.jsonl'), 'utf8')
        .trim()
        .split('\n');
      expect(pending).toHaveLength(2);

      writeResult(root, 'task-timeout-dedupe', { success: true, result: { agentId: 'agent-a', content: 'done' } });
      const completed = spawnSync(process.execPath, [agentRewakeScript], {
        input: payload,
        env,
        encoding: 'utf8',
      });
      expect(completed.status).toBe(2);
      expect(completed.stderr).toContain('[TASK COMPLETE: task-timeout-dedupe]');
      pending = readFileSync(join(dataDir, 'pending-notifications.jsonl'), 'utf8')
        .trim()
        .split('\n');
      expect(pending).toHaveLength(3);
      expect(JSON.parse(pending[2])).toMatchObject({ kind: 'task', taskId: 'task-timeout-dedupe' });
      expect(existsSync(join(dataDir, 'task-task-timeout-dedupe.notified'))).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
