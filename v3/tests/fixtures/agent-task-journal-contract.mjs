import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  appendTaskJournalEvent,
  replayTaskJournalEvents,
  taskJournalPath,
} from '../../@hive-flow/providers/scripts/agent-task-journal.mjs';

const root = mkdtempSync(join(tmpdir(), 'hf-agent-task-journal-'));
const previousHome = process.env.HIVE_FLOW_HOME;
const previousProjectDir = process.env.CLAUDE_PROJECT_DIR;

try {
  process.env.HIVE_FLOW_HOME = join(root, '.hive-home');
  process.env.CLAUDE_PROJECT_DIR = root;

  const tasksDir = join(root, '.hive-flow', 'tasks');
  mkdirSync(tasksDir, { recursive: true });

  const base = {
    tasksDir,
    taskId: 'task-journal-fixture',
    agentId: 'agent-journal-fixture',
    provider: 'openrouter',
    model: 'test/model',
  };

  const writes = [
    appendTaskJournalEvent({ ...base, event: 'dispatch', meta: { timeoutMs: 10000 } }),
    appendTaskJournalEvent({ ...base, event: 'bridge_start', pid: process.pid }),
    appendTaskJournalEvent({ ...base, event: 'provider_request_start', meta: { iteration: 1, status: 'OPENROUTER_API_KEY=sk-secret-secret-secret' } }),
    appendTaskJournalEvent({ ...base, event: 'tool_exec_start', meta: { toolName: 'read_file', iteration: 1 } }),
    appendTaskJournalEvent({ ...base, event: 'tool_exec_end', meta: { toolName: 'read_file', iteration: 1, success: true } }),
    appendTaskJournalEvent({ ...base, event: 'result_written', meta: { success: true } }),
  ];

  if (writes.some((ok) => ok !== true)) {
    throw new Error(`journal writes failed: ${JSON.stringify(writes)}`);
  }

  const raw = readFileSync(taskJournalPath(tasksDir, base.taskId), 'utf8');
  if (raw.includes('sk-secret-secret-secret') || raw.includes('OPENROUTER_API_KEY=')) {
    throw new Error('secret-like value survived journal serialization');
  }

  const replay = replayTaskJournalEvents(raw);
  if (!replay.valid || replay.terminalCount !== 1) {
    throw new Error(`journal replay invalid: ${JSON.stringify(replay)}`);
  }

  process.stdout.write(JSON.stringify({
    ok: true,
    events: replay.events.length,
    terminalCount: replay.terminalCount,
    isolated: process.env.HIVE_FLOW_HOME.startsWith(root),
  }) + '\n');
} finally {
  if (previousHome === undefined) delete process.env.HIVE_FLOW_HOME;
  else process.env.HIVE_FLOW_HOME = previousHome;
  if (previousProjectDir === undefined) delete process.env.CLAUDE_PROJECT_DIR;
  else process.env.CLAUDE_PROJECT_DIR = previousProjectDir;
  rmSync(root, { recursive: true, force: true });
}
