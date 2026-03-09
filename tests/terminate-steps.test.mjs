import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, '..');
const SCRIPT = join(REPO_ROOT, '.claude', 'helpers', 'terminate-steps.cjs');
const require = createRequire(import.meta.url);
const mod = require(SCRIPT);

function withTempDir() {
  return mkdtempSync(join(tmpdir(), 'terminate-steps-'));
}

function makeExecStub(handlers) {
  return (cmd, args) => {
    const toolIdx = args.indexOf('--tool');
    if (toolIdx >= 0) {
      const tool = args[toolIdx + 1];
      const fn = handlers[`tool:${tool}`];
      if (!fn) throw new Error(`No handler for tool ${tool}`);
      return fn(cmd, args);
    }

    if (args[1] === 'agent' && args[2] === 'stop') {
      const fn = handlers['agent:stop'];
      if (!fn) return '';
      return fn(cmd, args);
    }

    throw new Error(`Unhandled exec call: ${cmd} ${args.join(' ')}`);
  };
}

function getToolAndParams(args) {
  const toolIdx = args.indexOf('--tool');
  const paramsIdx = args.indexOf('--params');
  const tool = toolIdx >= 0 ? args[toolIdx + 1] : null;
  const params = paramsIdx >= 0 ? JSON.parse(args[paramsIdx + 1]) : null;
  return { tool, params };
}

describe('terminate-steps helper', () => {
  it('extractAgentId handles common response shapes', () => {
    assert.equal(mod.extractAgentId({ agentId: 'agent-a' }), 'agent-a');
    assert.equal(mod.extractAgentId({ id: 'agent-b' }), 'agent-b');
    assert.equal(mod.extractAgentId({ result: { agentId: 'agent-c' } }), 'agent-c');
    assert.equal(mod.extractAgentId({ result: { id: 'agent-d' } }), 'agent-d');
    assert.equal(mod.extractAgentId({ raw: 'spawned agent-xyz-123' }), 'agent-xyz-123');
    assert.equal(mod.extractAgentId({ raw: 'spawn complete with no id' }), null);
    assert.equal(mod.extractAgentId({ error: 'bad' }), null);
    assert.equal(mod.extractAgentId(null), null);
  });

  it('appendStructuredLog writes JSONL records', () => {
    const root = withTempDir();
    try {
      const runtime = mod.resolveRuntime({ projectRoot: root });
      mod.appendStructuredLog(runtime, 'unit.test', { foo: 'bar' });
      assert.equal(existsSync(runtime.logPath), true);
      const lines = readFileSync(runtime.logPath, 'utf8').trim().split('\n');
      const entry = JSON.parse(lines[0]);
      assert.equal(entry.event, 'unit.test');
      assert.equal(entry.foo, 'bar');
      assert.ok(entry.ts);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('appendStructuredLog remains non-fatal when log path parent is invalid', () => {
    const root = withTempDir();
    try {
      const blocker = join(root, 'blocked');
      writeFileSync(blocker, 'not-a-dir');
      const runtime = mod.resolveRuntime({ projectRoot: root, logPath: join(blocker, 'terminate.log.jsonl') });
      assert.doesNotThrow(() => {
        mod.appendStructuredLog(runtime, 'unit.test.invalid', { x: 1 });
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('mcpExec parses JSON and errors deterministically', () => {
    const root = withTempDir();
    try {
      const okExec = makeExecStub({
        'tool:agent_spawn': () => 'Result:\n{"agentId":"agent-abc"}',
      });
      const ok = mod.mcpExec('agent_spawn', { a: 1 }, { projectRoot: root, execFileSync: okExec });
      assert.equal(ok.agentId, 'agent-abc');

      const rawExec = makeExecStub({
        'tool:agent_spawn': () => 'no-json-output',
      });
      const raw = mod.mcpExec('agent_spawn', {}, { projectRoot: root, execFileSync: rawExec });
      assert.equal(raw.raw, 'no-json-output');

      const failExec = makeExecStub({
        'tool:agent_spawn': () => {
          throw new Error('boom');
        },
      });
      const fail = mod.mcpExec('agent_spawn', {}, { projectRoot: root, execFileSync: failExec });
      assert.match(fail.error || '', /boom/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('mcpExecWithRetry retries and returns attempts', () => {
    const root = withTempDir();
    let calls = 0;
    try {
      const retryExec = makeExecStub({
        'tool:agent_task': () => {
          calls++;
          if (calls < 2) throw new Error('first fails');
          return '{"ok":true}';
        },
      });

      const res = mod.mcpExecWithRetry(
        'agent_task',
        { x: 1 },
        { maxAttempts: 3 },
        { projectRoot: root, execFileSync: retryExec }
      );
      assert.equal(res.error, undefined);
      assert.equal(res.attempts, 2);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('cleanupAgent handles missing id, success, and failure', () => {
    const root = withTempDir();
    try {
      const noId = mod.cleanupAgent('', { projectRoot: root, execFileSync: () => '' });
      assert.equal(noId.cleaned, false);

      const okExec = makeExecStub({
        'agent:stop': () => '',
      });
      const ok = mod.cleanupAgent('agent-1', { projectRoot: root, execFileSync: okExec });
      assert.equal(ok.cleaned, true);

      const badExec = makeExecStub({
        'agent:stop': () => {
          throw new Error('stop failed');
        },
      });
      const bad = mod.cleanupAgent('agent-2', { projectRoot: root, execFileSync: badExec });
      assert.equal(bad.cleaned, false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('runPostTerminationSteps succeeds and logs attempts', () => {
    const root = withTempDir();
    try {
      const execStub = makeExecStub({
        'tool:agent_spawn': (_cmd, args) => {
          const { params } = getToolAndParams(args);
          assert.equal(params.model, 'sonnet');
          assert.equal(Object.prototype.hasOwnProperty.call(params, 'provider'), false);
          return 'Result: {"agentId":"agent-test"}';
        },
        'tool:agent_task': () => 'Result: {"ok":true}',
        'agent:stop': () => '',
      });
      const res = mod.runPostTerminationSteps(
        { generation: 8, at: new Date().toISOString(), reason: 'test' },
        { projectRoot: root, execFileSync: execStub }
      );
      assert.equal(res.success, true);
      assert.equal(res.agentId, 'agent-test');
      assert.equal(res.spawnAttempts, 1);
      assert.equal(res.taskAttempts, 1);
      assert.equal(existsSync(res.logPath), true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('runPostTerminationSteps falls back to default routing when explicit provider fails', () => {
    const root = withTempDir();
    let spawnCalls = 0;
    const oldProvider = process.env.HIVE_FLOW_TERMINATE_AGENT_PROVIDER;
    process.env.HIVE_FLOW_TERMINATE_AGENT_PROVIDER = 'codex-cli';
    try {
      const execStub = makeExecStub({
        'tool:agent_spawn': (_cmd, args) => {
          spawnCalls++;
          const { params } = getToolAndParams(args);
          if (spawnCalls === 1) {
            assert.equal(params.provider, 'codex-cli');
            throw new Error('forced provider fail');
          }
          assert.equal(Object.prototype.hasOwnProperty.call(params, 'provider'), false);
          return '{"agentId":"agent-fallback"}';
        },
        'tool:agent_task': () => '{"ok":true}',
        'agent:stop': () => '',
      });
      const res = mod.runPostTerminationSteps(
        { generation: 18, at: new Date().toISOString(), reason: 'test' },
        { projectRoot: root, execFileSync: execStub }
      );
      assert.equal(res.success, true);
      assert.equal(res.agentId, 'agent-fallback');
      assert.equal(spawnCalls, 4);
    } finally {
      process.env.HIVE_FLOW_TERMINATE_AGENT_PROVIDER = oldProvider;
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('runPostTerminationSteps retries task and reports failure deterministically', () => {
    const root = withTempDir();
    let taskCalls = 0;
    try {
      const execStub = makeExecStub({
        'tool:agent_spawn': () => '{"agentId":"agent-test"}',
        'tool:agent_task': () => {
          taskCalls++;
          throw new Error(`task fail ${taskCalls}`);
        },
        'agent:stop': () => '',
      });
      const res = mod.runPostTerminationSteps(
        { generation: 9, at: new Date().toISOString(), reason: 'test' },
        { projectRoot: root, execFileSync: execStub }
      );
      assert.equal(res.success, false);
      assert.equal(res.agentId, 'agent-test');
      assert.equal(res.taskAttempts, 3);
      assert.equal(res.cleanup.cleaned, true);
      assert.equal(taskCalls, 3);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('runPostTerminationSteps handles unexpected throw and still performs cleanup', () => {
    const root = withTempDir();
    try {
      const execStub = makeExecStub({
        'tool:agent_spawn': () => '{"agentId":"agent-test"}',
        'agent:stop': () => '',
      });
      const marker = {
        generation: 10,
        at: new Date().toISOString(),
      };
      Object.defineProperty(marker, 'reason', {
        get() {
          throw new Error('reason-read-failed');
        },
      });

      const res = mod.runPostTerminationSteps(
        marker,
        { projectRoot: root, execFileSync: execStub, logPath: join(root, 'terminate-steps.log.jsonl') }
      );

      assert.equal(res.success, false);
      assert.equal(res.agentId, 'agent-test');
      assert.equal(res.cleanup.cleaned, true);
      assert.match(res.reason || '', /reason-read-failed/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('direct script execution returns JSON even when node is unavailable in PATH', () => {
    const root = withTempDir();
    try {
      const markerPath = join(root, 'marker.json');
      writeFileSync(markerPath, JSON.stringify({ generation: 11, at: new Date().toISOString() }));
      const run = spawnSync(process.execPath, [SCRIPT, markerPath], {
        cwd: root,
        encoding: 'utf8',
        env: {
          ...process.env,
          CLAUDE_PROJECT_DIR: root,
          PATH: '',
        },
      });
      const out = JSON.parse(run.stdout || '{}');
      assert.equal(typeof out.success, 'boolean');
      assert.equal(run.status === 0 || run.status === 1, true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
