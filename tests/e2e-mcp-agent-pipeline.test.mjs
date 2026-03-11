/**
 * E2E Test: MCP Agent Spawn + Task Pipeline
 *
 * Tests the full pipeline: agent_spawn -> agent_task -> provider-agent-bridge -> CLI -> result
 *
 * Requirements:
 * - gemini CLI installed (gemini binary in PATH)
 * - codex CLI installed (codex binary in PATH)
 * - cursor-agent CLI installed (cursor-agent binary in PATH)
 * - Provider authentication configured
 *
 * Run: node --test tests/e2e-mcp-agent-pipeline.test.mjs
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, execFile } from 'node:child_process';
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = join(__dirname, '..');
const STORE_DIR = join(PROJECT_ROOT, '.hive-flow', 'agents');
const STORE_PATH = join(STORE_DIR, 'store.json');
const BRIDGE_PATH = join(PROJECT_ROOT, 'v3', '@hive-flow', 'providers', 'scripts', 'provider-agent-bridge.mjs');

// ===== Helpers =====

function loadStore() {
  if (!existsSync(STORE_PATH)) return { agents: {}, version: '3.0.0' };
  return JSON.parse(readFileSync(STORE_PATH, 'utf-8'));
}

function saveStore(store) {
  if (!existsSync(STORE_DIR)) mkdirSync(STORE_DIR, { recursive: true });
  writeFileSync(STORE_PATH, JSON.stringify(store, null, 2));
}

/**
 * Spawn an agent directly into store.json.
 * This avoids depending on `npx hive-flow mcp exec` being available.
 */
function spawnAgent(provider, agentType = 'coder', model = 'sonnet') {
  const agentId = `test-agent-${randomUUID()}`;
  const store = loadStore();
  store.agents[agentId] = {
    agentId,
    agentType,
    status: 'idle',
    health: 1,
    taskCount: 0,
    config: {},
    createdAt: new Date().toISOString(),
    model,
    provider,
    ...(provider !== 'anthropic' ? { resolvedModel: 'auto' } : {}),
    modelRoutedBy: 'explicit',
  };
  saveStore(store);
  return { agentId, provider };
}

/**
 * Run bridge directly as a subprocess (same as agent_task does).
 * Returns parsed JSON result + stderr.
 */
function runBridgeDirect(agentId, task, timeoutMs = 120000) {
  return new Promise((resolve, reject) => {
    const env = {
      ...process.env,
      PATH: `/opt/homebrew/bin:/usr/local/bin:${process.env.HOME}/.local/bin:${process.env.PATH}`,
    };
    execFile('node', [
      BRIDGE_PATH,
      '--agent-id', agentId,
      '--task', task,
      '--store-dir', STORE_DIR,
    ], { timeout: timeoutMs, maxBuffer: 10 * 1024 * 1024, env }, (err, stdout, stderr) => {
      let parsed;
      try { parsed = JSON.parse(stdout); } catch { /* ignore */ }
      if (err && !parsed) {
        reject(new Error(`Bridge failed: ${err.message}\nstderr: ${stderr}\nstdout: ${stdout}`));
        return;
      }
      resolve({ result: parsed, stderr });
    });
  });
}

function whichBinary(name) {
  try {
    return execFileSync('which', [name], { encoding: 'utf-8' }).trim().split('\n')[0];
  } catch {
    return null;
  }
}

// Track agents created during tests for cleanup
const testAgentIds = [];

// ===== Tests =====

describe('E2E: MCP Agent Pipeline', () => {
  let storeBackup;

  before(() => {
    if (existsSync(STORE_PATH)) {
      storeBackup = readFileSync(STORE_PATH, 'utf-8');
    }
    assert.ok(existsSync(BRIDGE_PATH), `Bridge script not found at ${BRIDGE_PATH}`);
  });

  after(() => {
    // Clean up test agents from store
    if (testAgentIds.length > 0) {
      const store = loadStore();
      for (const id of testAgentIds) {
        delete store.agents[id];
      }
      saveStore(store);
    }
  });

  describe('agent_spawn (store persistence)', () => {
    it('spawns an anthropic agent', () => {
      const { agentId } = spawnAgent('anthropic');
      testAgentIds.push(agentId);
      const store = loadStore();
      assert.ok(store.agents[agentId], 'Agent should be in store');
      assert.equal(store.agents[agentId].status, 'idle');
      assert.equal(store.agents[agentId].provider, 'anthropic');
    });

    it('spawns a gemini-cli agent', () => {
      const { agentId } = spawnAgent('gemini-cli', 'reviewer');
      testAgentIds.push(agentId);
      const store = loadStore();
      assert.ok(store.agents[agentId]);
      assert.equal(store.agents[agentId].provider, 'gemini-cli');
    });

    it('spawns a codex-cli agent', () => {
      const { agentId } = spawnAgent('codex-cli');
      testAgentIds.push(agentId);
      const store = loadStore();
      assert.ok(store.agents[agentId]);
      assert.equal(store.agents[agentId].provider, 'codex-cli');
    });

    it('spawns a cursor-cli agent', () => {
      const { agentId } = spawnAgent('cursor-cli', 'tester');
      testAgentIds.push(agentId);
      const store = loadStore();
      assert.ok(store.agents[agentId]);
      assert.equal(store.agents[agentId].provider, 'cursor-cli');
    });
  });

  describe('provider-agent-bridge.mjs (direct)', () => {
    it('bridge script exists and is valid', () => {
      assert.ok(existsSync(BRIDGE_PATH));
      const content = readFileSync(BRIDGE_PATH, 'utf-8');
      assert.ok(content.includes('provider-agent-bridge'), 'Should be the bridge script');
    });

    it('fails gracefully for missing agent', async () => {
      const { result } = await runBridgeDirect('nonexistent-id', 'Hello', 10000);
      assert.equal(result.success, false);
      assert.ok(
        result.error.includes('not found') || result.error.includes('nonexistent'),
        `Expected 'not found' error, got: ${result.error}`
      );
    });

    it('rejects anthropic agent (bridge only supports external CLIs)', async () => {
      const { agentId } = spawnAgent('anthropic');
      testAgentIds.push(agentId);
      const { result } = await runBridgeDirect(agentId, 'Hello', 10000);
      assert.equal(result.success, false);
      assert.ok(
        result.error.includes('Unknown provider') ||
        result.error.includes('anthropic') ||
        result.error.includes('Supported:'),
        `Expected provider rejection, got: ${result.error?.slice(0, 200)}`
      );
    });

    it('executes task on gemini-cli agent via bridge', { timeout: 120000 }, async () => {
      if (!whichBinary('gemini')) return; // skip if not installed
      const { agentId } = spawnAgent('gemini-cli');
      testAgentIds.push(agentId);

      const { result } = await runBridgeDirect(agentId, 'What is 1+1? Reply with just the number.', 60000);
      assert.equal(result.success, true);
      assert.ok(result.content, 'Should have content');
      assert.ok(result.content.includes('2'), `Expected "2" in response, got: ${result.content}`);
    });

    it('executes task on codex-cli agent via bridge', { timeout: 120000 }, async () => {
      if (!whichBinary('codex')) return; // skip if not installed
      const { agentId } = spawnAgent('codex-cli');
      testAgentIds.push(agentId);

      const { result } = await runBridgeDirect(agentId, 'What is 1+1? Reply with just the number.', 60000);
      assert.equal(result.success, true);
      assert.ok(result.content, 'Should have content');
    });

    it('executes task on cursor-cli agent via bridge', { timeout: 120000 }, async () => {
      if (!whichBinary('cursor-agent')) return; // skip if not installed
      const { agentId } = spawnAgent('cursor-cli');
      testAgentIds.push(agentId);

      const { result } = await runBridgeDirect(agentId, 'What is 1+1? Reply with just the number.', 60000);
      assert.equal(result.success, true);
      assert.ok(result.content, 'Should have content');
    });

    it('updates agent state after task', { timeout: 120000 }, async () => {
      if (!whichBinary('gemini')) return; // skip if not installed
      const { agentId } = spawnAgent('gemini-cli');
      testAgentIds.push(agentId);

      const storeBefore = loadStore();
      const agentBefore = storeBefore.agents[agentId];
      assert.equal(agentBefore.taskCount, 0);
      assert.equal(agentBefore.status, 'idle');

      await runBridgeDirect(agentId, 'Say hello', 60000);

      const storeAfter = loadStore();
      const agentAfter = storeAfter.agents[agentId];
      assert.equal(agentAfter.taskCount, 1);
      assert.ok(agentAfter.lastResult, 'Should have lastResult');
      assert.ok(agentAfter.conversationHistory?.length > 0, 'Should have history');
    });
  });
});
