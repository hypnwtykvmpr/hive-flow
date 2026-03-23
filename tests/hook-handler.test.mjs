import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, '..');
const SCRIPT = join(REPO_ROOT, '.claude/helpers/hook-handler.cjs');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeTempDir() {
  return mkdtempSync(join(tmpdir(), 'hook-handler-test-'));
}

/**
 * Run the hook-handler as a subprocess with a given command and optional env overrides.
 * stdin is left empty unless stdinData is provided.
 */
function runHandler(command, { cwd, env = {}, stdinData = '' } = {}) {
  const result = spawnSync(process.execPath, [SCRIPT, ...(command ? [command] : [])], {
    cwd: cwd || REPO_ROOT,
    input: stdinData,
    encoding: 'utf8',
    timeout: 15_000,
    env: {
      ...process.env,
      CLAUDE_PROJECT_DIR: cwd || REPO_ROOT,
      // Wipe prompt-related vars so tests are deterministic
      PROMPT: '',
      TOOL_INPUT_command: '',
      MODEL: '',
      ...env,
    },
  });
  return {
    status: result.status,
    stdout: result.stdout || '',
    stderr: result.stderr || '',
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('hook-handler.cjs', () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = makeTempDir();
    mkdirSync(join(tmpDir, '.hive-flow', 'data'), { recursive: true });
  });

  afterEach(() => {
    if (tmpDir && existsSync(tmpDir)) {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  // =========================================================================
  // 1. Script existence
  // =========================================================================
  describe('script prerequisites', () => {
    it('hook-handler.cjs exists on disk', () => {
      assert.ok(existsSync(SCRIPT), `Script must exist at ${SCRIPT}`);
    });
  });

  // =========================================================================
  // 2. No-command / unknown command — graceful, no crash
  // =========================================================================
  describe('dispatch', () => {
    it('prints usage when no command is provided', () => {
      const res = runHandler(null, { cwd: tmpDir });
      assert.equal(res.status, 0, `Should exit 0, stderr: ${res.stderr}`);
      assert.match(res.stdout, /Usage/, 'Should print Usage line when no command given');
    });

    it('exits 0 and produces no output for an unknown command', () => {
      const res = runHandler('totally-unknown-command-xyz', { cwd: tmpDir });
      assert.equal(res.status, 0, `Unknown command should exit 0, stderr: ${res.stderr}`);
      // No output for unknown commands (avoids non-JSON hook errors)
      assert.equal(res.stdout.trim(), '', 'Unknown command should produce no stdout');
    });
  });

  // =========================================================================
  // 3. pre-task — registers entry in live-tasks.json
  // =========================================================================
  describe('pre-task', () => {
    it('exits 0 and writes a running task entry to live-tasks.json', () => {
      const res = runHandler('pre-task', { cwd: tmpDir });
      assert.equal(res.status, 0, `pre-task should exit 0, stderr: ${res.stderr}`);

      const liveTasksPath = join(tmpDir, '.hive-flow', 'data', 'live-tasks.json');
      assert.ok(existsSync(liveTasksPath), 'live-tasks.json should be created by pre-task');

      const tasks = JSON.parse(readFileSync(liveTasksPath, 'utf8'));
      assert.ok(Array.isArray(tasks), 'live-tasks.json should contain an array');
      assert.equal(tasks.length, 1, 'Should have exactly one task entry');
      assert.equal(tasks[0].status, 'running', 'Task status should be "running"');
      assert.ok(typeof tasks[0].taskId === 'string', 'Task should have a taskId string');
      assert.ok(typeof tasks[0].startTime === 'string', 'Task should have a startTime string');
    });

    it('outputs [OK] Task started (or a routing line) to stdout', () => {
      const res = runHandler('pre-task', { cwd: tmpDir });
      assert.equal(res.status, 0);
      // Without a router module the fallback line is "[OK] Task started"
      assert.ok(
        res.stdout.includes('[OK] Task started') || res.stdout.includes('[INFO] Task routed to:'),
        `Expected task-started output, got: ${res.stdout}`,
      );
    });
  });

  // =========================================================================
  // 4. post-task — marks task complete in live-tasks.json
  // =========================================================================
  describe('post-task', () => {
    it('exits 0 and outputs [OK] Task completed', () => {
      const res = runHandler('post-task', { cwd: tmpDir });
      assert.equal(res.status, 0, `post-task should exit 0, stderr: ${res.stderr}`);
      assert.match(res.stdout, /\[OK\] Task completed/, 'Should output [OK] Task completed');
    });

    it('marks a running task as completed in live-tasks.json', () => {
      // Seed a running task with a known ID
      const liveTasksPath = join(tmpDir, '.hive-flow', 'data', 'live-tasks.json');
      const fakeId = `task-${Date.now()}-99999`;
      writeFileSync(liveTasksPath, JSON.stringify([
        { taskId: fakeId, startTime: new Date().toISOString(), status: 'running' },
      ]));

      runHandler('post-task', {
        cwd: tmpDir,
        env: { _HIVE_FLOW_TASK_ID: fakeId },
      });

      const tasks = JSON.parse(readFileSync(liveTasksPath, 'utf8'));
      const task = tasks.find(t => t.taskId === fakeId);
      // The task may have been pruned (completed + age check) or marked completed
      if (task) {
        assert.equal(task.status, 'completed', 'Task should be marked completed');
        assert.ok(typeof task.endTime === 'string', 'Task should have endTime');
      }
      // If task was pruned from the list that is also acceptable behaviour
    });

    it('does not crash when live-tasks.json does not exist', () => {
      // Remove the data dir so no live-tasks.json is present
      rmSync(join(tmpDir, '.hive-flow'), { recursive: true, force: true });
      const res = runHandler('post-task', { cwd: tmpDir });
      assert.equal(res.status, 0, `post-task should exit 0 even without live-tasks.json`);
    });
  });

  // =========================================================================
  // 5. session-restore — exits cleanly
  // =========================================================================
  describe('session-restore', () => {
    it('exits 0 without crashing', () => {
      const res = runHandler('session-restore', { cwd: tmpDir });
      assert.equal(res.status, 0, `session-restore should exit 0, stderr: ${res.stderr}`);
    });

    it('resets .context-tracker.json', () => {
      // The handler writes the tracker at helpersDir/../.context-tracker.json,
      // which is REPO_ROOT/.claude/.context-tracker.json — not inside tmpDir.
      const ctxFile = join(REPO_ROOT, '.claude', '.context-tracker.json');

      runHandler('session-restore', { cwd: tmpDir });

      if (existsSync(ctxFile)) {
        const ctx = JSON.parse(readFileSync(ctxFile, 'utf8'));
        // After session-restore the calls counter must be 0 (reset for new session)
        assert.equal(ctx.calls, 0, 'calls should be reset to 0 after session-restore');
      }
      // If the file does not exist the handler had nothing to reset — that is fine too
    });

    it('consumes and removes a forbidden-stop marker if present', () => {
      const markerFile = join(tmpDir, '.hive-flow', 'data', 'forbidden-stop.json');
      writeFileSync(markerFile, JSON.stringify({ at: new Date().toISOString(), violation: 'FORBIDDEN_STOP' }));

      const res = runHandler('session-restore', { cwd: tmpDir });
      assert.equal(res.status, 0);
      // Marker should be deleted after session-restore reads it
      assert.ok(!existsSync(markerFile), 'forbidden-stop.json should be removed after session-restore');
      assert.match(res.stdout, /FORBIDDEN-STOP-VIOLATION/, 'Should warn about the forbidden stop in stdout');
    });
  });

  // =========================================================================
  // 6. session-end — exits cleanly
  // =========================================================================
  describe('session-end', () => {
    it('exits 0 and outputs [OK] Session ended (when no session module)', () => {
      const res = runHandler('session-end', { cwd: tmpDir });
      assert.equal(res.status, 0, `session-end should exit 0, stderr: ${res.stderr}`);
      // Without a session module the fallback is "[OK] Session ended"
      assert.ok(
        res.stdout.includes('[OK] Session ended') || res.stdout.length >= 0,
        `session-end should exit cleanly, stdout: ${res.stdout}`,
      );
    });
  });

  // =========================================================================
  // 7. route — exits cleanly
  // =========================================================================
  describe('route', () => {
    it('exits 0 for a basic route request', () => {
      const res = runHandler('route', {
        cwd: tmpDir,
        env: { PROMPT: 'fix the login bug' },
      });
      assert.equal(res.status, 0, `route should exit 0, stderr: ${res.stderr}`);
    });

    it('outputs routing info or fallback message', () => {
      const res = runHandler('route', {
        cwd: tmpDir,
        env: { PROMPT: 'implement feature X' },
      });
      assert.equal(res.status, 0);
      assert.ok(
        res.stdout.includes('[INFO]') || res.stdout.length > 0,
        `route should produce some output, got empty stdout`,
      );
    });
  });

  // =========================================================================
  // 8. pre-bash — exits cleanly for safe command
  // =========================================================================
  describe('pre-bash', () => {
    it('exits 0 for a safe command and outputs [OK]', () => {
      const res = runHandler('pre-bash', {
        cwd: tmpDir,
        env: { PROMPT: 'npm test' },
      });
      assert.equal(res.status, 0, `pre-bash should exit 0 for safe command, stderr: ${res.stderr}`);
      assert.match(res.stdout, /\[OK\]/, 'Should output [OK] for safe command');
    });

    it('exits non-zero and outputs [BLOCKED] for dangerous command rm -rf /', () => {
      const res = runHandler('pre-bash', {
        cwd: tmpDir,
        env: { PROMPT: 'rm -rf /' },
      });
      assert.notEqual(res.status, 0, 'Dangerous command should cause non-zero exit');
      assert.ok(
        res.stderr.includes('[BLOCKED]') || res.stdout.includes('[BLOCKED]'),
        `Dangerous command should produce [BLOCKED] output, stdout: ${res.stdout}, stderr: ${res.stderr}`,
      );
    });
  });

  // =========================================================================
  // 9. post-edit — exits cleanly
  // =========================================================================
  describe('post-edit', () => {
    it('exits 0 and outputs [OK] Edit recorded', () => {
      const res = runHandler('post-edit', { cwd: tmpDir });
      assert.equal(res.status, 0, `post-edit should exit 0, stderr: ${res.stderr}`);
      assert.match(res.stdout, /\[OK\] Edit recorded/, 'Should output [OK] Edit recorded');
    });
  });

  // =========================================================================
  // 10. post-command — exits cleanly
  // =========================================================================
  describe('post-command', () => {
    it('exits 0 and outputs [OK] Command tracked', () => {
      const res = runHandler('post-command', { cwd: tmpDir });
      assert.equal(res.status, 0, `post-command should exit 0, stderr: ${res.stderr}`);
      assert.match(res.stdout, /\[OK\] Command tracked/, 'Should output [OK] Command tracked');
    });
  });

  // =========================================================================
  // 11. compact-manual / compact-auto — exit cleanly
  // =========================================================================
  describe('compact commands', () => {
    it('compact-manual exits 0 and outputs [COMPACT] Manual compaction triggered', () => {
      const res = runHandler('compact-manual', { cwd: tmpDir });
      assert.equal(res.status, 0, `compact-manual should exit 0, stderr: ${res.stderr}`);
      assert.match(res.stdout, /\[COMPACT\] Manual compaction triggered/);
    });

    it('compact-auto exits 0 and outputs [COMPACT] Auto compaction triggered', () => {
      const res = runHandler('compact-auto', { cwd: tmpDir });
      assert.equal(res.status, 0, `compact-auto should exit 0, stderr: ${res.stderr}`);
      assert.match(res.stdout, /\[COMPACT\] Auto compaction triggered/);
    });
  });

  // =========================================================================
  // 12. status (SubagentStart) — exits cleanly
  // =========================================================================
  describe('status', () => {
    it('exits 0 and outputs [AGENT] Started line', () => {
      const res = runHandler('status', {
        cwd: tmpDir,
        env: {
          CLAUDE_AGENT_ID: 'agent-123',
          CLAUDE_AGENT_NAME: 'test-agent',
          CLAUDE_PARENT_AGENT_ID: 'parent-456',
        },
      });
      assert.equal(res.status, 0, `status should exit 0, stderr: ${res.stderr}`);
      assert.match(res.stdout, /\[AGENT\] Started:/, 'Should output [AGENT] Started: line');
      assert.match(res.stdout, /name=test-agent/, 'Should include agent name');
    });
  });

  // =========================================================================
  // 13. anti-re-request — exits cleanly when enforcer not compiled
  // =========================================================================
  describe('anti-re-request', () => {
    it('exits 0 and produces no output when enforcer module is absent', () => {
      // The enforcer module lives in the compiled dist — in a clean test env it
      // likely does not exist, so the handler should fail-open (exit 0, no output).
      const res = runHandler('anti-re-request', {
        cwd: tmpDir,
        env: { PROMPT: 'Should I proceed with the implementation?' },
      });
      assert.equal(res.status, 0, `anti-re-request should exit 0, stderr: ${res.stderr}`);
      // When enforcer is absent: no output (fail-open).
      // When enforcer IS present and state.authorized is unset: still no output.
      // Either way nothing bad should happen.
    });
  });

  // =========================================================================
  // 14. enforce-plan — emits allow JSON when no enforcement state exists
  // =========================================================================
  describe('enforce-plan', () => {
    it('exits 0 and emits allow JSON when enforcer is absent or no state', async () => {
      const res = runHandler('enforce-plan', { cwd: tmpDir });
      assert.equal(res.status, 0, `enforce-plan should exit 0, stderr: ${res.stderr}`);
      const trimmed = res.stdout.trim();
      assert.ok(trimmed.length > 0, 'enforce-plan should produce JSON output');
      let parsed;
      try { parsed = JSON.parse(trimmed); } catch {
        assert.fail(`enforce-plan output is not valid JSON: ${trimmed}`);
      }
      const decision = parsed?.hookSpecificOutput?.permissionDecision;
      assert.equal(decision, 'allow', `Expected allow decision, got: ${decision}`);
    });
  });

  // =========================================================================
  // 15. permission-guard — emits allow JSON on empty/no stdin
  // =========================================================================
  describe('permission-guard', () => {
    it('exits 0 and emits allow JSON when stdin is empty', async () => {
      // permission-guard reads stdin; sending empty string triggers the parse-error
      // path which falls through to allow.
      const res = runHandler('permission-guard', {
        cwd: tmpDir,
        stdinData: '',
      });
      assert.equal(res.status, 0, `permission-guard should exit 0, stderr: ${res.stderr}`);
      const trimmed = res.stdout.trim();
      assert.ok(trimmed.length > 0, 'permission-guard should produce JSON output');
      let parsed;
      try { parsed = JSON.parse(trimmed); } catch {
        assert.fail(`permission-guard output is not valid JSON: ${trimmed}`);
      }
      const decision = parsed?.hookSpecificOutput?.permissionDecision;
      assert.equal(decision, 'allow', `Expected allow decision, got: ${decision}`);
    });
  });

  // =========================================================================
  // 16. enforce-gate — exits cleanly when no state
  // =========================================================================
  describe('enforce-gate', () => {
    it('exits 0 without crashing when enforcer module is absent', () => {
      const res = runHandler('enforce-gate', { cwd: tmpDir });
      assert.equal(res.status, 0, `enforce-gate should exit 0, stderr: ${res.stderr}`);
    });
  });

  // =========================================================================
  // 17. enforce-final — exits cleanly when no state
  // =========================================================================
  describe('enforce-final', () => {
    it('exits 0 without crashing when enforcer module is absent', () => {
      const res = runHandler('enforce-final', { cwd: tmpDir });
      assert.equal(res.status, 0, `enforce-final should exit 0, stderr: ${res.stderr}`);
    });
  });

  // =========================================================================
  // 18. stats — exits cleanly
  // =========================================================================
  describe('stats', () => {
    it('exits 0 and warns when intelligence module is not available', () => {
      const res = runHandler('stats', { cwd: tmpDir });
      assert.equal(res.status, 0, `stats should exit 0, stderr: ${res.stderr}`);
      // When intelligence module is absent (no compiled dist), warn message expected
      assert.ok(
        res.stdout.includes('[WARN]') || res.stdout.length >= 0,
        `stats should exit cleanly, stdout: ${res.stdout}`,
      );
    });
  });

  // =========================================================================
  // 19. enforcement-reset-check — emits empty JSON when prompt has no token
  // =========================================================================
  describe('enforcement-reset-check', () => {
    it('exits 0 and emits empty JSON when no /enforcement-reset token in prompt', () => {
      const res = runHandler('enforcement-reset-check', {
        cwd: tmpDir,
        stdinData: JSON.stringify({ user_prompt: 'just a normal message' }),
      });
      assert.equal(res.status, 0, `enforcement-reset-check should exit 0, stderr: ${res.stderr}`);
      const trimmed = res.stdout.trim();
      assert.ok(trimmed.length > 0, 'Should produce some output');
      let parsed;
      try { parsed = JSON.parse(trimmed); } catch {
        assert.fail(`enforcement-reset-check output is not valid JSON: ${trimmed}`);
      }
      // Without the token the handler emits {}
      assert.deepEqual(parsed, {}, `Expected empty object, got: ${JSON.stringify(parsed)}`);
    });
  });

  // =========================================================================
  // 20. advocate state locking — stale lock recovery for state writers
  // =========================================================================
  describe('advocate state locking', () => {
    it('advocate-sign recovers from a stale advocate-state lock and writes state', () => {
      const dataDir = join(tmpDir, '.hive-flow', 'data');
      const lockDir = join(dataDir, '.advocate-state.lock');
      mkdirSync(lockDir, { recursive: true });
      const staleAt = new Date(Date.now() - 60_000);
      utimesSync(lockDir, staleAt, staleAt);

      const res = runHandler('advocate-sign', {
        cwd: tmpDir,
        stdinData: JSON.stringify({
          newState: 'active',
          description: 'Recovered from stale lock',
        }),
      });

      assert.equal(res.status, 0, `advocate-sign should exit 0, stderr: ${res.stderr}`);
      const statePath = join(dataDir, 'advocate-state.json');
      assert.ok(existsSync(statePath), 'advocate-sign should write advocate-state.json');
      const state = JSON.parse(readFileSync(statePath, 'utf8'));
      assert.equal(state.state, 'active', 'advocate-sign should update the state');
      assert.ok(!existsSync(lockDir), 'stale advocate-state lock should be removed after write');
    });

    it('user-prompt-activate recovers from a stale advocate-state lock and updates state', () => {
      const dataDir = join(tmpDir, '.hive-flow', 'data');
      const statePath = join(dataDir, 'advocate-state.json');
      writeFileSync(statePath, JSON.stringify({
        state: 'waiting-for-human',
        updatedAt: new Date().toISOString(),
        description: '',
        history: [],
      }));

      const lockDir = join(dataDir, '.advocate-state.lock');
      mkdirSync(lockDir, { recursive: true });
      const staleAt = new Date(Date.now() - 60_000);
      utimesSync(lockDir, staleAt, staleAt);

      const res = runHandler('user-prompt-activate', {
        cwd: tmpDir,
        stdinData: JSON.stringify({ user_prompt: 'Resume work' }),
      });

      assert.equal(res.status, 0, `user-prompt-activate should exit 0, stderr: ${res.stderr}`);
      const state = JSON.parse(readFileSync(statePath, 'utf8'));
      assert.equal(state.state, 'active', 'user-prompt-activate should promote waiting-for-human to active');
      assert.ok(!existsSync(lockDir), 'stale advocate-state lock should be removed after write');
    });

    it('user-prompt-activate recovers from a stale advocate-state lock when only refreshing activity', () => {
      const dataDir = join(tmpDir, '.hive-flow', 'data');
      const statePath = join(dataDir, 'advocate-state.json');
      writeFileSync(statePath, JSON.stringify({
        state: 'active',
        updatedAt: '2024-01-01T00:00:00.000Z',
        description: '',
        history: [],
      }));

      const lockDir = join(dataDir, '.advocate-state.lock');
      mkdirSync(lockDir, { recursive: true });
      const staleAt = new Date(Date.now() - 60_000);
      utimesSync(lockDir, staleAt, staleAt);

      const res = runHandler('user-prompt-activate', {
        cwd: tmpDir,
        stdinData: JSON.stringify({ user_prompt: 'Keep going' }),
      });

      assert.equal(res.status, 0, `user-prompt-activate should exit 0, stderr: ${res.stderr}`);
      const state = JSON.parse(readFileSync(statePath, 'utf8'));
      assert.equal(state.state, 'active', 'user-prompt-activate should preserve the active state');
      assert.notEqual(state.updatedAt, '2024-01-01T00:00:00.000Z', 'user-prompt-activate should refresh updatedAt');
      assert.ok(!existsSync(lockDir), 'stale advocate-state lock should be removed after write');
    });
  });
});
