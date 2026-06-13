import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import {
  appendTaskJournalEvent,
  classifyJournalError,
  redactEventMeta,
  replayTaskJournalEvents,
  serializeTaskJournalEvent,
  taskJournalPath,
} from '../scripts/agent-task-journal.mjs';

function withTempDir(fn) {
  const dir = mkdtempSync(join(tmpdir(), 'hf-task-journal-'));
  try {
    return fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe('agent task journal', () => {
  it('whitelists scalar metadata and strips non-observability fields', () => {
    expect(redactEventMeta({
      toolName: 'read_file',
      durationMs: 12,
      success: true,
      prompt: 'do not store prompt text',
      output: 'do not store tool output',
      nested: { no: 'objects' },
      apiKey: 'sk-test-should-not-survive',
    })).toEqual({
      toolName: 'read_file',
      durationMs: 12,
      success: true,
    });
  });

  it('classifies provider errors into coarse safe classes only', () => {
    expect(classifyJournalError(Object.assign(new Error('Unauthorized'), { status: 401 }))).toBe('auth');
    expect(classifyJournalError(Object.assign(new Error('Too many requests'), { status: 429 }))).toBe('rate');
    expect(classifyJournalError(new Error('quota exhausted'))).toBe('quota');
    expect(classifyJournalError(new Error('context token limit exceeded'))).toBe('overflow');
    expect(classifyJournalError(new Error('weird'))).toBe('other');
  });

  it('appendTaskJournalEvent is fail-open on unwritable task paths', () => withTempDir((dir) => {
    const tasksPath = join(dir, 'tasks-as-file');
    writeFileSync(tasksPath, 'not a directory', 'utf8');

    expect(appendTaskJournalEvent({
      tasksDir: tasksPath,
      taskId: 'task-fail-open',
      event: 'dispatch',
      agentId: 'agent-a',
    })).toBe(false);
  }));

  it('writes replayable jsonl and refuses a second terminal event', () => withTempDir((dir) => {
    const tasksDir = join(dir, 'tasks');
    const base = { tasksDir, taskId: 'task-replay', agentId: 'agent-a', provider: 'openrouter' };

    expect(appendTaskJournalEvent({ ...base, event: 'dispatch' })).toBe(true);
    expect(appendTaskJournalEvent({ ...base, event: 'tool_exec_start', meta: { toolName: 'read_file', iteration: 1 } })).toBe(true);
    expect(appendTaskJournalEvent({ ...base, event: 'tool_exec_end', meta: { toolName: 'read_file', iteration: 1, success: true } })).toBe(true);
    expect(appendTaskJournalEvent({ ...base, event: 'result_written', meta: { success: true } })).toBe(true);
    expect(appendTaskJournalEvent({ ...base, event: 'terminate' })).toBe(false);

    const replay = replayTaskJournalEvents(readFileSync(taskJournalPath(tasksDir, 'task-replay'), 'utf8'));
    expect(replay.valid).toBe(true);
    expect(replay.terminalCount).toBe(1);
    expect(replay.events.map((event) => event.event)).toEqual([
      'dispatch',
      'tool_exec_start',
      'tool_exec_end',
      'result_written',
    ]);
  }));

  it('never serializes secret-like values from whitelisted scalar metadata', () => {
    const secretLike = fc.oneof(
      fc.constant('sk-' + 'a'.repeat(32)),
      fc.constant('or-' + 'b'.repeat(32)),
      fc.constant('ghp_' + 'c'.repeat(32)),
      fc.constant('OPENROUTER_API_KEY=sk-' + 'd'.repeat(24)),
      fc.constant('A'.repeat(44)),
    );

    fc.assert(
      fc.property(secretLike, (secret) => {
        const serialized = serializeTaskJournalEvent({
          tasksDir: '/tmp/not-used',
          taskId: 'task-redaction',
          event: 'provider_error',
          agentId: 'agent-a',
          provider: 'openrouter',
          meta: {
            status: secret,
            reason: secret,
            toolName: secret,
          },
        });
        expect(serialized).not.toContain(secret);
      }),
      { numRuns: 200 },
    );
  });

  it('preserves monotonic source-order replay for a two-tool transcript', () => {
    const events = [
      { ts: '2026-06-13T00:00:00.000Z', event: 'dispatch' },
      { ts: '2026-06-13T00:00:01.000Z', event: 'tool_exec_start', meta: { toolName: 'read_file' } },
      { ts: '2026-06-13T00:00:02.000Z', event: 'tool_exec_start', meta: { toolName: 'grep' } },
      { ts: '2026-06-13T00:00:03.000Z', event: 'tool_exec_end', meta: { toolName: 'grep' } },
      { ts: '2026-06-13T00:00:04.000Z', event: 'tool_exec_end', meta: { toolName: 'read_file' } },
      { ts: '2026-06-13T00:00:05.000Z', event: 'result_written' },
    ];

    const replay = replayTaskJournalEvents(events);
    expect(replay.valid).toBe(true);
    expect(replay.events.map((event) => event.event)).toEqual(events.map((event) => event.event));
    expect(replay.events.filter((event) => event.event === 'result_written')).toHaveLength(1);
  });
});
