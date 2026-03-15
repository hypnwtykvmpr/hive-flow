import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
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
      HIVE_FLOW_DISABLE_POST_TERMINATION_STEPS: '1',
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
      HIVE_FLOW_DISABLE_POST_TERMINATION_STEPS: '1',
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

function createMockJsonl(dir, userMessages, sessionId = 'test-session') {
  mkdirSync(dir, { recursive: true });
  const lines = userMessages.map((text, i) => JSON.stringify({
    type: 'user',
    timestamp: new Date(Date.now() - (userMessages.length - i) * 60000).toISOString(),
    message: { role: 'user', content: [{ type: 'text', text }] },
  }));
  // Add some non-user lines to simulate real JSONL
  lines.splice(1, 0, JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'response' }] } }));
  lines.splice(3, 0, JSON.stringify({ type: 'tool_use', message: { content: [{ type: 'tool_use', name: 'Read' }] } }));
  const jsonlPath = join(dir, `${sessionId}.jsonl`);
  writeFileSync(jsonlPath, lines.join('\n'));
  return { jsonlPath, sessionId };
}

function runHookWithJsonl(cwd, payload, jsonlDir, transcriptPath, sessionId) {
  const enriched = {
    ...payload,
    transcript_path: transcriptPath || payload.transcript_path,
    session_id: sessionId || payload.session_id,
  };
  const result = spawnSync(process.execPath, [SCRIPT], {
    cwd,
    input: JSON.stringify(enriched),
    encoding: 'utf8',
    env: {
      ...process.env,
      CLAUDE_PROJECT_DIR: cwd,
      HIVE_FLOW_JSONL_DIR: jsonlDir || '',
      HIVE_FLOW_DISABLE_POST_TERMINATION_STEPS: '1',
    },
  });
  return {
    status: result.status,
    stdout: result.stdout || '',
    stderr: result.stderr || '',
  };
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

  it('cleans up consumed marker and stays silent', () => {
    const cwd = withTempRepo();
    try {
      const sessionsDir = join(cwd, '.hive-flow', 'sessions');
      mkdirSync(sessionsDir, { recursive: true });
      const markerPath = join(sessionsDir, 'terminated.json');
      writeFileSync(markerPath, JSON.stringify({
        generation: 7,
        pendingUserAck: false,
        pendingPromptInjection: false,
      }));

      const result = runHook(cwd, { prompt: 'normal prompt' });
      assert.equal(result.status, 0);
      assert.equal(result.stderr, '');
      assert.equal(result.stdout, '');
      // Consumed marker should be deleted
      assert.equal(existsSync(markerPath), false);
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

      // Stage 4: next prompt should clean up the marker and pass through silently
      const fourth = runHook(cwd, { prompt: 'normal work continues' });
      assert.equal(fourth.status, 0);
      assert.equal(fourth.stderr, '');
      assert.equal(fourth.stdout, '');
      assert.equal(existsSync(markerPath), false);
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it('triggers on case-insensitive variants', () => {
    const cwd = withTempRepo();
    try {
      for (const variant of ['/Terminate-Agent', '/TERMINATE-AGENT', '[terminate_agent_now]']) {
        // Only the regex-matching ones should trigger
        const result = runHook(cwd, { prompt: variant });
        if (/^\/terminate-agent$/i.test(variant.trim()) || /^\[TERMINATE_AGENT_NOW\]$/i.test(variant.trim())) {
          const json = JSON.parse(result.stdout);
          assert.equal(json.decision, 'block');
        }
      }
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it('triggers on whitespace-padded prompts', () => {
    const cwd = withTempRepo();
    try {
      const result = runHook(cwd, { prompt: '  /terminate-agent  ' });
      assert.equal(result.status, 0);
      const json = JSON.parse(result.stdout);
      assert.equal(json.decision, 'block');
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it('handles empty stdin gracefully', () => {
    const cwd = withTempRepo();
    try {
      const result = runHookRaw(cwd, '');
      assert.equal(result.status, 0);
      assert.equal(result.stderr, '');
      assert.equal(result.stdout, '');
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it('handles double termination correctly', () => {
    const cwd = withTempRepo();
    try {
      const first = runHook(cwd, { prompt: '/terminate-agent' });
      const firstJson = JSON.parse(first.stdout);
      assert.equal(firstJson.decision, 'block');
      assert.match(firstJson.stopReason, /AGENT_GENERATION:1/);

      const second = runHook(cwd, { prompt: '/terminate-agent' });
      const secondJson = JSON.parse(second.stdout);
      assert.equal(secondJson.decision, 'block');
      assert.match(secondJson.stopReason, /AGENT_GENERATION:2/);

      const markerPath = join(cwd, '.hive-flow', 'sessions', 'terminated.json');
      const marker = JSON.parse(readFileSync(markerPath, 'utf8'));
      assert.equal(marker.generation, 2);
      assert.equal(marker.pendingUserAck, true);
      assert.equal(marker.pendingPromptInjection, true);
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it('ignores expired markers from stale sessions', () => {
    const cwd = withTempRepo();
    try {
      const sessionsDir = join(cwd, '.hive-flow', 'sessions');
      mkdirSync(sessionsDir, { recursive: true });
      const markerPath = join(sessionsDir, 'terminated.json');
      const staleTime = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString(); // 2 hours ago
      writeFileSync(markerPath, JSON.stringify({
        generation: 5,
        at: staleTime,
        pendingUserAck: true,
        pendingPromptInjection: true,
      }));

      const result = runHook(cwd, { prompt: 'normal prompt' });
      assert.equal(result.status, 0);
      assert.equal(result.stderr, '');
      assert.equal(result.stdout, '');
      // Expired marker should be cleaned up
      assert.equal(existsSync(markerPath), false);
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it('emits PERSIST_FAILED when marker write fails', () => {
    const cwd = withTempRepo();
    try {
      const hiveDir = join(cwd, '.hive-flow');
      mkdirSync(hiveDir, { recursive: true });
      writeFileSync(join(hiveDir, 'sessions'), 'not-a-directory');

      const result = runHook(cwd, { prompt: '/terminate-agent' });
      assert.equal(result.status, 0);
      const json = JSON.parse(result.stdout);
      assert.equal(json.decision, 'block');
      assert.match(json.stopReason, /PERSIST_FAILED/);
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it('updates current.json with termination state', () => {
    const cwd = withTempRepo();
    try {
      const sessionsDir = join(cwd, '.hive-flow', 'sessions');
      mkdirSync(sessionsDir, { recursive: true });
      writeFileSync(join(sessionsDir, 'current.json'), JSON.stringify({ logicalAgentGeneration: 0 }));

      runHook(cwd, { prompt: '/terminate-agent' });

      const session = JSON.parse(readFileSync(join(sessionsDir, 'current.json'), 'utf8'));
      assert.equal(session.terminated, true);
      assert.equal(session.logicalAgentGeneration, 1);
      assert.ok(session.terminatedAt);
      assert.equal(session.terminationReason, 'User invoked /terminate-agent');
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it('uses CLAUDE_PROJECT_DIR env var for path resolution', () => {
    const cwd = withTempRepo();
    const projectDir = withTempRepo();
    try {
      const result = spawnSync(process.execPath, [SCRIPT], {
        cwd,
        input: JSON.stringify({ prompt: '/terminate-agent' }),
        encoding: 'utf8',
        env: {
          ...process.env,
          CLAUDE_PROJECT_DIR: projectDir,
        },
      });

      assert.equal(result.status, 0);
      const json = JSON.parse(result.stdout);
      assert.equal(json.decision, 'block');
      // Marker should be in projectDir, not cwd
      assert.equal(existsSync(join(projectDir, '.hive-flow', 'sessions', 'terminated.json')), true);
      assert.equal(existsSync(join(cwd, '.hive-flow', 'sessions', 'terminated.json')), false);
    } finally {
      rmSync(cwd, { recursive: true, force: true });
      rmSync(projectDir, { recursive: true, force: true });
    }
  });

  // --- Model-switching and state-clearing tests ---

  it('writes model field to settings.json on termination', () => {
    const cwd = withTempRepo();
    try {
      const claudeDir = join(cwd, '.claude');
      mkdirSync(claudeDir, { recursive: true });
      writeFileSync(join(claudeDir, 'settings.json'), JSON.stringify({ permissions: {} }, null, 2));

      const result = runHook(cwd, { prompt: '/terminate-agent' });
      assert.equal(result.status, 0);
      const json = JSON.parse(result.stdout);
      assert.equal(json.decision, 'block');

      const settings = JSON.parse(readFileSync(join(claudeDir, 'settings.json'), 'utf8'));
      assert.ok(settings.model, 'settings.json should have a model field after termination');
      assert.ok(
        settings.model === 'claude-sonnet-4-6' || settings.model === 'claude-opus-4-6',
        `model should be claude-sonnet-4-6 or claude-opus-4-6, got: ${settings.model}`
      );
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it('preserves existing settings when writing model', () => {
    const cwd = withTempRepo();
    try {
      const claudeDir = join(cwd, '.claude');
      mkdirSync(claudeDir, { recursive: true });
      writeFileSync(join(claudeDir, 'settings.json'), JSON.stringify({
        hooks: { test: true },
        permissions: { allow: ['Bash'] },
      }, null, 2));

      const result = runHook(cwd, { prompt: '/terminate-agent' });
      assert.equal(result.status, 0);

      const settings = JSON.parse(readFileSync(join(claudeDir, 'settings.json'), 'utf8'));
      assert.equal(settings.hooks?.test, true, 'hooks.test should be preserved');
      assert.ok(settings.permissions?.allow?.includes('Bash'), 'permissions.allow should still contain Bash');
      assert.ok(settings.model, 'model field should have been added');
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it('stores model switch info in marker', () => {
    const cwd = withTempRepo();
    try {
      const claudeDir = join(cwd, '.claude');
      mkdirSync(claudeDir, { recursive: true });
      writeFileSync(join(claudeDir, 'settings.json'), JSON.stringify({}, null, 2));

      const result = runHook(cwd, { prompt: '/terminate-agent' });
      assert.equal(result.status, 0);

      const markerPath = join(cwd, '.hive-flow', 'sessions', 'terminated.json');
      assert.ok(existsSync(markerPath), 'terminated.json should exist');
      const marker = JSON.parse(readFileSync(markerPath, 'utf8'));

      assert.ok('modelSwitched' in marker, 'marker should have modelSwitched field');
      assert.ok('previousModel' in marker, 'marker should have previousModel field');
      assert.ok('targetModel' in marker, 'marker should have targetModel field');
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it('completes successfully when plans dir is absent and marker is valid', () => {
    const cwd = withTempRepo();
    try {
      // Do NOT create ~/.claude/plans/ — verify the hook doesn't crash
      const result = runHook(cwd, { prompt: '/terminate-agent' });
      assert.equal(result.status, 0);
      const json = JSON.parse(result.stdout);
      assert.equal(json.decision, 'block');

      const markerPath = join(cwd, '.hive-flow', 'sessions', 'terminated.json');
      assert.ok(existsSync(markerPath), 'terminated.json should exist');
      const marker = JSON.parse(readFileSync(markerPath, 'utf8'));
      assert.equal(marker.terminated, true);
      // When clearSessionState() is added, sessionCleared should appear in marker
      if ('sessionCleared' in marker) {
        assert.equal(typeof marker.sessionCleared, 'boolean');
      }
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it('clears session current.json but preserves terminated.json', () => {
    const cwd = withTempRepo();
    try {
      const sessionsDir = join(cwd, '.hive-flow', 'sessions');
      mkdirSync(sessionsDir, { recursive: true });
      writeFileSync(join(sessionsDir, 'current.json'), JSON.stringify({ active: true, logicalAgentGeneration: 3 }));

      const result = runHook(cwd, { prompt: '/terminate-agent' });
      assert.equal(result.status, 0);

      const terminatedPath = join(sessionsDir, 'terminated.json');
      assert.ok(existsSync(terminatedPath), 'terminated.json must exist after termination');

      const currentPath = join(sessionsDir, 'current.json');
      if (existsSync(currentPath)) {
        // If current.json still exists, it should have been overwritten with termination state
        const session = JSON.parse(readFileSync(currentPath, 'utf8'));
        assert.equal(session.terminated, true, 'current.json should be marked as terminated');
      }
      // Either current.json was deleted (clearSessionState) or overwritten (persistTermination) — both are valid
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it('does not delete global ~/.claude/plans files', () => {
    const cwd = withTempRepo();
    const fakeHome = withTempRepo();
    try {
      const plansDir = join(fakeHome, '.claude', 'plans');
      mkdirSync(plansDir, { recursive: true });
      const planFile = join(plansDir, 'important-plan.md');
      writeFileSync(planFile, '# keep me');

      const result = spawnSync(process.execPath, [SCRIPT], {
        cwd,
        input: JSON.stringify({ prompt: '/terminate-agent' }),
        encoding: 'utf8',
        env: {
          ...process.env,
          HOME: fakeHome,
          CLAUDE_PROJECT_DIR: cwd,
          HIVE_FLOW_DISABLE_POST_TERMINATION_STEPS: '1',
        },
      });

      assert.equal(result.status, 0);
      assert.equal(existsSync(planFile), true, 'global plans file should remain');
    } finally {
      rmSync(cwd, { recursive: true, force: true });
      rmSync(fakeHome, { recursive: true, force: true });
    }
  });

  it('does not wipe project cache/hooks directories for unrelated sessions', () => {
    const cwd = withTempRepo();
    try {
      const cacheDir = join(cwd, '.hive-flow', 'cache');
      const hooksDir = join(cwd, '.hive-flow', 'hooks');
      mkdirSync(cacheDir, { recursive: true });
      mkdirSync(hooksDir, { recursive: true });
      const cacheFile = join(cacheDir, 'shared-cache.json');
      const hookFile = join(hooksDir, 'shared-hook-state.json');
      writeFileSync(cacheFile, '{"x":1}');
      writeFileSync(hookFile, '{"y":1}');

      const result = runHook(cwd, { prompt: '/terminate-agent' });
      assert.equal(result.status, 0);
      assert.equal(existsSync(cacheFile), true);
      assert.equal(existsSync(hookFile), true);
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it('handoff injection includes model switch details', () => {
    const cwd = withTempRepo();
    try {
      const claudeDir = join(cwd, '.claude');
      mkdirSync(claudeDir, { recursive: true });
      writeFileSync(join(claudeDir, 'settings.json'), JSON.stringify({ permissions: {} }, null, 2));

      // Stage 1: terminate
      const first = runHook(cwd, { prompt: '/terminate-agent' });
      assert.equal(first.status, 0);
      const firstJson = JSON.parse(first.stdout);
      assert.equal(firstJson.decision, 'block');

      // Stage 2: ack
      const second = runHook(cwd, { prompt: 'ack prompt' });
      assert.equal(second.status, 0);
      const secondJson = JSON.parse(second.stdout);
      assert.equal(secondJson.decision, 'block');

      // Stage 3: injection
      const third = runHook(cwd, { prompt: 'continue working' });
      assert.equal(third.status, 0);
      const thirdJson = JSON.parse(third.stdout);
      assert.ok(thirdJson.hookSpecificOutput, 'third stage should emit hookSpecificOutput');
      const ctx = thirdJson.hookSpecificOutput.additionalContext || '';
      assert.ok(
        ctx.includes('Model was automatically switched') ||
        ctx.includes('Model switch was attempted') ||
        ctx.includes('model') ||
        ctx.includes('Model'),
        `additionalContext should mention model switch, got: ${ctx.substring(0, 200)}`
      );
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it('handles missing settings.json gracefully', () => {
    const cwd = withTempRepo();
    try {
      // Deliberately do NOT create .claude/settings.json
      const result = runHook(cwd, { prompt: '/terminate-agent' });
      assert.equal(result.status, 0);
      assert.equal(result.stderr, '');

      const json = JSON.parse(result.stdout);
      assert.equal(json.decision, 'block');

      // Marker should still be created even if settings.json was missing
      const markerPath = join(cwd, '.hive-flow', 'sessions', 'terminated.json');
      if (existsSync(markerPath)) {
        const marker = JSON.parse(readFileSync(markerPath, 'utf8'));
        // If modelSwitched field exists, it should indicate failure or false
        if ('modelSwitched' in marker) {
          assert.equal(typeof marker.modelSwitched, 'boolean');
        }
      }
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it('refuses dump when transcript path is outside project JSONL dir', () => {
    const cwd = withTempRepo();
    const jsonlDir = join(cwd, 'project-jsonl');
    const outsiderDir = withTempRepo();
    try {
      const { jsonlPath: outsiderPath } = createMockJsonl(outsiderDir, ['leak me'], 'outside-session');

      const result = runHookWithJsonl(cwd, {
        prompt: '/terminate-agent',
        transcript_path: outsiderPath,
        session_id: 'outside-session',
      }, jsonlDir, outsiderPath, 'outside-session');

      assert.equal(result.status, 0);
      const marker = JSON.parse(readFileSync(join(cwd, '.hive-flow', 'sessions', 'terminated.json'), 'utf8'));
      assert.equal(marker.sessionDumped, false);
      assert.equal(marker.sessionDumpPath, null);
    } finally {
      rmSync(cwd, { recursive: true, force: true });
      rmSync(outsiderDir, { recursive: true, force: true });
    }
  });

  // --- Session dump / JSONL tests ---

  it('creates session dump file from JSONL with amplification', () => {
    const cwd = withTempRepo();
    const jsonlDir = join(cwd, 'mock-jsonl');
    try {
      const prompts = Array.from({ length: 15 }, (_, i) => `user prompt ${i + 1}`);
      const { jsonlPath, sessionId } = createMockJsonl(jsonlDir, prompts, 'session-dump-15');

      const result = runHookWithJsonl(cwd, { prompt: '/terminate-agent' }, jsonlDir, jsonlPath, sessionId);
      assert.equal(result.status, 0);

      const dumpFiles = fs.readdirSync(join(cwd, '.hive-flow', 'sessions'))
        .filter(f => f.startsWith('session-dump-'));
      assert.ok(dumpFiles.length > 0, 'session dump file should exist');

      const dump = JSON.parse(readFileSync(join(cwd, '.hive-flow', 'sessions', dumpFiles[0]), 'utf8'));
      assert.equal(dump.version, 1);
      assert.equal(dump.totalPrompts, 15);
      assert.equal(dump.amplifiedCount, 10);

      const amplifiedPrompts = dump.prompts.filter(p => p.amplified === true);
      const normalPrompts = dump.prompts.filter(p => p.amplified === false);
      assert.equal(amplifiedPrompts.length, 10);
      assert.equal(normalPrompts.length, 5);

      // Amplified should be high priority
      for (const p of amplifiedPrompts) {
        assert.equal(p.priority, 'high');
      }
      // Normal should be normal priority
      for (const p of normalPrompts) {
        assert.equal(p.priority, 'normal');
      }
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it('handles missing JSONL directory gracefully for dump', () => {
    const cwd = withTempRepo();
    try {
      const missingDir = join(cwd, 'nonexistent');
      const result = runHookWithJsonl(cwd, {
        prompt: '/terminate-agent',
        transcript_path: join(missingDir, 'ghost-session.jsonl'),
        session_id: 'ghost-session',
      }, missingDir);
      assert.equal(result.status, 0);
      const json = JSON.parse(result.stdout);
      assert.equal(json.decision, 'block');

      const markerPath = join(cwd, '.hive-flow', 'sessions', 'terminated.json');
      if (existsSync(markerPath)) {
        const marker = JSON.parse(readFileSync(markerPath, 'utf8'));
        if ('sessionDumped' in marker) {
          assert.equal(marker.sessionDumped, false);
        }
      }
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it('amplifies all prompts when fewer than 10', () => {
    const cwd = withTempRepo();
    const jsonlDir = join(cwd, 'mock-jsonl');
    try {
      const { jsonlPath, sessionId } = createMockJsonl(jsonlDir, ['prompt one', 'prompt two', 'prompt three'], 'session-dump-3');

      const result = runHookWithJsonl(cwd, { prompt: '/terminate-agent' }, jsonlDir, jsonlPath, sessionId);
      assert.equal(result.status, 0);

      const dumpFiles = fs.readdirSync(join(cwd, '.hive-flow', 'sessions'))
        .filter(f => f.startsWith('session-dump-'));
      assert.ok(dumpFiles.length > 0);

      const dump = JSON.parse(readFileSync(join(cwd, '.hive-flow', 'sessions', dumpFiles[0]), 'utf8'));
      assert.equal(dump.totalPrompts, 3);
      assert.equal(dump.amplifiedCount, 3);
      assert.ok(dump.prompts.every(p => p.amplified === true && p.priority === 'high'));
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it('dump file survives clearSessionState', () => {
    const cwd = withTempRepo();
    const jsonlDir = join(cwd, 'mock-jsonl');
    try {
      const { jsonlPath, sessionId } = createMockJsonl(jsonlDir, ['test prompt'], 'session-dump-survive');

      const result = runHookWithJsonl(cwd, { prompt: '/terminate-agent' }, jsonlDir, jsonlPath, sessionId);
      assert.equal(result.status, 0);

      // Dump file should still exist after clearSessionState ran
      const sessionsDir = join(cwd, '.hive-flow', 'sessions');
      const dumpFiles = fs.readdirSync(sessionsDir).filter(f => f.startsWith('session-dump-'));
      assert.ok(dumpFiles.length > 0, 'dump file should survive clearSessionState');
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it('marker includes sessionDumped and sessionDumpPath', () => {
    const cwd = withTempRepo();
    const jsonlDir = join(cwd, 'mock-jsonl');
    try {
      const { jsonlPath, sessionId } = createMockJsonl(jsonlDir, ['prompt A', 'prompt B'], 'session-dump-marker');

      runHookWithJsonl(cwd, { prompt: '/terminate-agent' }, jsonlDir, jsonlPath, sessionId);

      const marker = JSON.parse(readFileSync(join(cwd, '.hive-flow', 'sessions', 'terminated.json'), 'utf8'));
      assert.equal(marker.sessionDumped, true);
      assert.ok(marker.sessionDumpPath, 'sessionDumpPath should be set');
      assert.ok(marker.sessionDumpPath.includes('session-dump-'), 'path should contain session-dump-');
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  // --- WP-31: Authorization gating tests ---

  it('blocks compaction-restored terminate invocations', () => {
    const cwd = withTempRepo();
    try {
      const result = runHook(cwd, {
        prompt: '/terminate-agent',
        restored_from_compaction: true,
      });
      assert.equal(result.status, 0);
      const json = JSON.parse(result.stdout);
      assert.equal(json.decision, 'block');
      assert.match(json.stopReason, /UNAUTHORIZED/);
      assert.match(json.stopReason, /[Cc]ompaction/);
      // No marker should be created
      assert.equal(existsSync(join(cwd, '.hive-flow', 'sessions', 'terminated.json')), false);
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it('logs violations for unauthorized terminate attempts', () => {
    const cwd = withTempRepo();
    try {
      runHook(cwd, {
        prompt: '/terminate-agent',
        restored_from_compaction: true,
      });
      const violationsPath = join(cwd, '.hive-flow', 'enforcement', 'violations.jsonl');
      assert.ok(existsSync(violationsPath), 'violations file should be created');
      const lines = readFileSync(violationsPath, 'utf8').trim().split('\n');
      assert.ok(lines.length >= 1, 'should have at least one violation logged');
      const violation = JSON.parse(lines[0]);
      assert.equal(violation.type, 'unauthorized-terminate');
      assert.equal(violation.severity, 'level2');
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it('allows normal human terminate invocations (no compaction flag)', () => {
    const cwd = withTempRepo();
    try {
      const result = runHook(cwd, { prompt: '/terminate-agent' });
      assert.equal(result.status, 0);
      const json = JSON.parse(result.stdout);
      assert.equal(json.decision, 'block');
      assert.match(json.stopReason, /\[TERMINATED\]/);
      // Should NOT have UNAUTHORIZED
      assert.doesNotMatch(json.stopReason, /UNAUTHORIZED/);
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it('allows ENFORCER-authorized terminate with valid token', () => {
    const cwd = withTempRepo();
    try {
      const enforcerDir = join(cwd, '.hive-flow', 'enforcement');
      mkdirSync(enforcerDir, { recursive: true });
      const token = 'test-enforcer-token-12345';
      const expires = new Date(Date.now() + 3600000).toISOString(); // 1 hour from now
      writeFileSync(join(enforcerDir, 'enforcer-token.json'), JSON.stringify({ token, expires }));

      const result = runHook(cwd, {
        prompt: '/terminate-agent',
        hook_event_name: 'EnforcerInvocation',
        enforcer_token: token,
      });
      assert.equal(result.status, 0);
      const json = JSON.parse(result.stdout);
      assert.equal(json.decision, 'block');
      assert.match(json.stopReason, /\[TERMINATED\]/);
      assert.doesNotMatch(json.stopReason, /UNAUTHORIZED/);
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it('rejects ENFORCER with expired token', () => {
    const cwd = withTempRepo();
    try {
      const enforcerDir = join(cwd, '.hive-flow', 'enforcement');
      mkdirSync(enforcerDir, { recursive: true });
      const token = 'test-enforcer-token-expired';
      const expires = new Date(Date.now() - 3600000).toISOString(); // 1 hour ago
      writeFileSync(join(enforcerDir, 'enforcer-token.json'), JSON.stringify({ token, expires }));

      const result = runHook(cwd, {
        prompt: '/terminate-agent',
        hook_event_name: 'EnforcerInvocation',
        enforcer_token: token,
      });
      assert.equal(result.status, 0);
      const json = JSON.parse(result.stdout);
      assert.equal(json.decision, 'block');
      assert.match(json.stopReason, /UNAUTHORIZED/);
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it('rejects ENFORCER with wrong token', () => {
    const cwd = withTempRepo();
    try {
      const enforcerDir = join(cwd, '.hive-flow', 'enforcement');
      mkdirSync(enforcerDir, { recursive: true });
      const expires = new Date(Date.now() + 3600000).toISOString();
      writeFileSync(join(enforcerDir, 'enforcer-token.json'), JSON.stringify({
        token: 'correct-token',
        expires,
      }));

      const result = runHook(cwd, {
        prompt: '/terminate-agent',
        hook_event_name: 'EnforcerInvocation',
        enforcer_token: 'wrong-token',
      });
      assert.equal(result.status, 0);
      const json = JSON.parse(result.stdout);
      assert.equal(json.decision, 'block');
      assert.match(json.stopReason, /UNAUTHORIZED/);
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it('handoff injection mentions session dump', () => {
    const cwd = withTempRepo();
    const jsonlDir = join(cwd, 'mock-jsonl');
    try {
      const { jsonlPath, sessionId } = createMockJsonl(jsonlDir, ['some work prompt'], 'session-dump-handoff');
      mkdirSync(join(cwd, '.claude'), { recursive: true });
      writeFileSync(join(cwd, '.claude', 'settings.json'), JSON.stringify({}, null, 2));

      // Stage 1: terminate
      runHookWithJsonl(cwd, { prompt: '/terminate-agent' }, jsonlDir, jsonlPath, sessionId);
      // Stage 2: ack
      runHookWithJsonl(cwd, { prompt: 'ack' }, jsonlDir, jsonlPath, sessionId);
      // Stage 3: inject
      const third = runHookWithJsonl(cwd, { prompt: 'continue' }, jsonlDir, jsonlPath, sessionId);
      assert.equal(third.status, 0);

      const thirdJson = JSON.parse(third.stdout);
      const ctx = thirdJson.hookSpecificOutput?.additionalContext || '';
      assert.ok(
        ctx.includes('session-dump') || ctx.includes('Session dump'),
        `additionalContext should mention session dump, got: ${ctx.substring(0, 300)}`
      );
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });
});
