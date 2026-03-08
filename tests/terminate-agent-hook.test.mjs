import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, '..');
const SCRIPT = join(REPO_ROOT, '.claude/helpers/terminate-agent.cjs');

function runHook(cwd, payload) {
  const result = spawnSync(process.execPath, [SCRIPT], {
    cwd,
    input: JSON.stringify(payload),
    encoding: 'utf8',
    env: {
      ...process.env,
      CLAUDE_PROJECT_DIR: cwd,
    },
  });

  return {
    status: result.status,
    stdout: result.stdout || '',
    stderr: result.stderr || '',
  };
}

function runHookRaw(cwd, rawInput) {
  const result = spawnSync(process.execPath, [SCRIPT], {
    cwd,
    input: rawInput,
    encoding: 'utf8',
    env: {
      ...process.env,
      CLAUDE_PROJECT_DIR: cwd,
    },
  });

  return {
    status: result.status,
    stdout: result.stdout || '',
    stderr: result.stderr || '',
  };
}

function withTempRepo() {
  const dir = mkdtempSync(join(tmpdir(), 'terminate-agent-hook-'));
  return dir;
}

describe('terminate-agent hook', () => {
  it('passes through normal prompts and does not create marker files', () => {
    const cwd = withTempRepo();
    try {
      const result = runHook(cwd, { prompt: 'can you explain /terminate-agent behavior?' });
      assert.equal(result.status, 0);
      assert.equal(result.stderr, '');
      assert.equal(result.stdout, '');
      assert.equal(existsSync(join(cwd, '.hive-flow', 'sessions', 'terminated.json')), false);
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it('does not trigger on sentinel text embedded in longer prompt', () => {
    const cwd = withTempRepo();
    try {
      const result = runHook(cwd, { prompt: 'debug log contains [TERMINATE_AGENT_NOW] token' });
      assert.equal(result.status, 0);
      assert.equal(result.stderr, '');
      assert.equal(result.stdout, '');
      assert.equal(existsSync(join(cwd, '.hive-flow', 'sessions', 'terminated.json')), false);
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it('triggers on exact sentinel prompt', () => {
    const cwd = withTempRepo();
    try {
      const result = runHook(cwd, { prompt: '[TERMINATE_AGENT_NOW]' });
      assert.equal(result.status, 0);
      assert.equal(result.stderr, '');
      const json = JSON.parse(result.stdout);
      assert.equal(json.decision, 'block');
      assert.match(json.stopReason || '', /\[AGENT_GENERATION:\d+\]/);
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it('handles raw stdin fallback parsing for /terminate-agent', () => {
    const cwd = withTempRepo();
    try {
      const result = runHookRaw(cwd, '/terminate-agent');
      assert.equal(result.status, 0);
      assert.equal(result.stderr, '');
      const json = JSON.parse(result.stdout);
      assert.equal(json.decision, 'block');
      assert.match(json.stopReason || '', /\[TERMINATED\]/);
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it('increments generation from pre-existing session state', () => {
    const cwd = withTempRepo();
    try {
      const sessionsDir = join(cwd, '.hive-flow', 'sessions');
      mkdirSync(sessionsDir, { recursive: true });
      writeFileSync(join(sessionsDir, 'current.json'), JSON.stringify({ logicalAgentGeneration: 41 }, null, 2));

      const result = runHook(cwd, { prompt: '/terminate-agent' });
      assert.equal(result.status, 0);
      assert.equal(result.stderr, '');

      const marker = JSON.parse(readFileSync(join(sessionsDir, 'terminated.json'), 'utf8'));
      assert.equal(marker.generation, 42);
      const json = JSON.parse(result.stdout);
      assert.match(json.stopReason || '', /\[AGENT_GENERATION:42\]/);
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it('ignores malformed marker JSON gracefully', () => {
    const cwd = withTempRepo();
    try {
      const sessionsDir = join(cwd, '.hive-flow', 'sessions');
      mkdirSync(sessionsDir, { recursive: true });
      writeFileSync(join(sessionsDir, 'terminated.json'), '{invalid-json');

      const result = runHook(cwd, { prompt: 'normal prompt after corruption' });
      assert.equal(result.status, 0);
      assert.equal(result.stderr, '');
      assert.equal(result.stdout, '');
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it('stays silent when marker exists but handoff was already consumed', () => {
    const cwd = withTempRepo();
    try {
      const sessionsDir = join(cwd, '.hive-flow', 'sessions');
      mkdirSync(sessionsDir, { recursive: true });
      writeFileSync(join(sessionsDir, 'terminated.json'), JSON.stringify({
        generation: 7,
        pendingUserAck: false,
        pendingPromptInjection: false,
      }));

      const result = runHook(cwd, { prompt: 'normal prompt' });
      assert.equal(result.status, 0);
      assert.equal(result.stderr, '');
      assert.equal(result.stdout, '');
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it('remains stable when writes fail (sessions path is a file)', () => {
    const cwd = withTempRepo();
    try {
      const hiveDir = join(cwd, '.hive-flow');
      mkdirSync(hiveDir, { recursive: true });
      writeFileSync(join(hiveDir, 'sessions'), 'not-a-directory');

      const result = runHook(cwd, { prompt: '/terminate-agent' });
      assert.equal(result.status, 0);
      assert.equal(result.stderr, '');
      assert.notEqual(result.stdout, '');
      const json = JSON.parse(result.stdout);
      assert.equal(json.decision, 'block');
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it('blocks terminate, emits visible generation ack, then injects one-time handoff context', () => {
    const cwd = withTempRepo();
    try {
      const first = runHook(cwd, { prompt: '/terminate-agent' });
      assert.equal(first.status, 0);
      assert.equal(first.stderr, '');
      assert.notEqual(first.stdout, '');

      const firstJson = JSON.parse(first.stdout);
      assert.equal(firstJson.decision, 'block');
      assert.equal(firstJson.continue, false);
      assert.equal(firstJson.suppressOutput, true);
      assert.match(firstJson.stopReason || '', /\[TERMINATED\]/);
      assert.match(firstJson.stopReason || '', /\[AGENT_GENERATION:\d+\]/);

      const markerPath = join(cwd, '.hive-flow', 'sessions', 'terminated.json');
      assert.equal(existsSync(markerPath), true);

      const markerBefore = JSON.parse(readFileSync(markerPath, 'utf8'));
      assert.equal(markerBefore.pendingUserAck, true);
      assert.equal(markerBefore.pendingPromptInjection, true);

      const second = runHook(cwd, { prompt: 'first prompt after terminate' });
      assert.equal(second.status, 0);
      assert.equal(second.stderr, '');
      assert.notEqual(second.stdout, '');

      const secondJson = JSON.parse(second.stdout);
      assert.equal(secondJson.decision, 'block');
      assert.equal(secondJson.continue, false);
      assert.equal(secondJson.suppressOutput, true);
      assert.match(secondJson.stopReason || '', /\[TERMINATED\]/);
      assert.match(secondJson.stopReason || '', /\[AGENT_GENERATION:\d+\]/);

      const markerAfterAck = JSON.parse(readFileSync(markerPath, 'utf8'));
      assert.equal(markerAfterAck.pendingUserAck, false);
      assert.equal(markerAfterAck.pendingPromptInjection, true);

      const third = runHook(cwd, { prompt: 'continue with the fix' });
      assert.equal(third.status, 0);
      assert.equal(third.stderr, '');
      assert.notEqual(third.stdout, '');

      const thirdJson = JSON.parse(third.stdout);
      assert.equal(thirdJson.hookSpecificOutput?.hookEventName, 'UserPromptSubmit');
      assert.match(thirdJson.hookSpecificOutput?.additionalContext || '', /\[TERMINATED\]/);
      assert.match(thirdJson.hookSpecificOutput?.additionalContext || '', /\[AGENT_GENERATION:\d+\]/);

      const markerAfterInject = JSON.parse(readFileSync(markerPath, 'utf8'));
      assert.equal(markerAfterInject.pendingPromptInjection, false);
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });
});
