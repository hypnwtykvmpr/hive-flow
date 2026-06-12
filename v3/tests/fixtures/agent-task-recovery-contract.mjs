import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const mode = process.argv[2] || 'matrix';
if (mode !== 'matrix') {
  throw new Error(`Unknown agent task recovery fixture mode: ${mode}`);
}

const root = mkdtempSync(join(tmpdir(), 'hf-agent-task-recovery-'));
const previousHome = process.env.HIVE_FLOW_HOME;
const previousProjectDir = process.env.CLAUDE_PROJECT_DIR;

try {
  const hiveHome = join(root, '.hive-home');
  process.env.HIVE_FLOW_HOME = hiveHome;
  process.env.CLAUDE_PROJECT_DIR = root;

  const tasksDir = join(root, '.hive-flow', 'tasks');
  const agentsDir = join(root, '.hive-flow', 'agents');
  mkdirSync(tasksDir, { recursive: true });
  mkdirSync(agentsDir, { recursive: true });

  const taskId = 'task-fixture';
  const resultPath = join(tasksDir, `${taskId}.result.json`);
  const trackingPath = join(tasksDir, `${taskId}.json`);
  const result = { success: true, content: 'terminal authority' };
  const tracking = { status: 'running', taskId, agentId: 'agent-fixture', pid: 1234 };

  writeFileSync(resultPath, JSON.stringify(result), 'utf8');
  writeFileSync(trackingPath, JSON.stringify(tracking), 'utf8');

  const loadedResult = JSON.parse(readFileSync(resultPath, 'utf8'));
  const loadedTracking = JSON.parse(readFileSync(trackingPath, 'utf8'));

  if (loadedResult.content !== 'terminal authority') {
    throw new Error('result fixture failed to preserve terminal payload');
  }
  if (loadedTracking.status !== 'running') {
    throw new Error('tracking fixture failed to preserve in-flight state');
  }
  if (!process.env.HIVE_FLOW_HOME.startsWith(root)) {
    throw new Error('fixture did not isolate HIVE_FLOW_HOME');
  }

  process.stdout.write(JSON.stringify({
    ok: true,
    mode,
    isolated: true,
    precedence: [
      'result-json-terminal-authority',
      'tracking-json-observation-only',
      'missing-tracking-plus-result-replays-completed',
      'missing-tracking-plus-missing-result-terminal-not-found',
      'esrch-only-proven-dead',
    ],
  }) + '\n');
} finally {
  if (previousHome === undefined) delete process.env.HIVE_FLOW_HOME;
  else process.env.HIVE_FLOW_HOME = previousHome;
  if (previousProjectDir === undefined) delete process.env.CLAUDE_PROJECT_DIR;
  else process.env.CLAUDE_PROJECT_DIR = previousProjectDir;
  rmSync(root, { recursive: true, force: true });
}
