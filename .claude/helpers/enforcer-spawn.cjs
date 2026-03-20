#!/usr/bin/env node
/**
 * SubagentStart — singleton ENFORCER agent when active hives exist.
 */
const fs = require('fs');
const path = require('path');
const { pathToFileURL } = require('url');

const PROJECT_DIR = path.resolve(__dirname, '..', '..');
const HIVES_DIR = path.join(PROJECT_DIR, '.hive-flow', 'hives');
const ENFORCEMENT_DIR = path.join(PROJECT_DIR, '.hive-flow', 'enforcement');

function hasActiveHives() {
  if (!fs.existsSync(HIVES_DIR)) return false;
  try {
    for (const ent of fs.readdirSync(HIVES_DIR, { withFileTypes: true })) {
      if (!ent.isDirectory() || ent.name.startsWith('.')) continue;
      try {
        const p = path.join(HIVES_DIR, ent.name, 'hive.json');
        const h = JSON.parse(fs.readFileSync(p, 'utf8'));
        if (h.status === 'active') return true;
      } catch { /* skip */ }
    }
  } catch {
    return false;
  }
  return false;
}

function listAgentsFromStore(storePath) {
  try {
    const raw = fs.readFileSync(storePath, 'utf8');
    const store = JSON.parse(raw);
    if (Array.isArray(store)) return store;
    const a = store.agents;
    if (!a) return [];
    if (Array.isArray(a)) return a;
    if (typeof a === 'object') return Object.values(a);
  } catch {
    return [];
  }
  return [];
}

function hasActiveEnforcer() {
  const storePath = path.join(PROJECT_DIR, '.hive-flow', 'agents', 'store.json');
  const agents = listAgentsFromStore(storePath);
  return agents.some(a => a && a.agentType === 'enforcer' && a.status !== 'terminated');
}

function readEnforcementLevel() {
  const crypto = require('crypto');
  try {
    const stateFile = path.join(ENFORCEMENT_DIR, 'state.json');
    if (!fs.existsSync(stateFile)) return 0;
    const raw = JSON.parse(fs.readFileSync(stateFile, 'utf8'));

    // SEC-005: HMAC verification before trusting enforcement level.
    // Fail-closed: return HALTED (3) on verification failure or missing key.
    const hmacKeyFile = path.join(ENFORCEMENT_DIR, '.hmac-key');

    if (raw?.state !== undefined && typeof raw.hmac === 'string') {
      // enforcement.cjs envelope: { state, hmac }
      let key;
      try { key = fs.readFileSync(hmacKeyFile, 'utf8').trim(); } catch { return 3; }
      if (!key) return 3;
      const expected = crypto.createHmac('sha256', key).update(JSON.stringify(raw.state)).digest('hex');
      const expectedBuf = Buffer.from(expected, 'hex');
      const actualBuf = Buffer.from(raw.hmac, 'hex');
      if (expectedBuf.length !== actualBuf.length || !crypto.timingSafeEqual(expectedBuf, actualBuf)) return 3;
      return typeof raw.state.level === 'number' ? raw.state.level : 0;
    }

    if (raw?.payload !== undefined && typeof raw.signature === 'string') {
      // workflow-enforcer.ts envelope: { payload, signature }
      let key;
      try { key = fs.readFileSync(hmacKeyFile, 'utf8').trim(); } catch { return 3; }
      if (!key) return 3;
      const expected = crypto.createHmac('sha256', key).update(JSON.stringify(raw.payload)).digest('hex');
      const expectedBuf = Buffer.from(expected, 'hex');
      const actualBuf = Buffer.from(raw.signature, 'hex');
      if (expectedBuf.length !== actualBuf.length || !crypto.timingSafeEqual(expectedBuf, actualBuf)) return 3;
      return typeof raw.payload.level === 'number' ? raw.payload.level : 0;
    }

    // Unsigned state — fail-closed (HALTED)
    return 3;
  } catch { /* ignore */ }
  return 3; // Fail-closed on any error
}

async function main() {
  if (readEnforcementLevel() >= 3) {
    console.log('{}');
    return;
  }
  if (!hasActiveHives()) {
    console.log('{}');
    return;
  }
  if (hasActiveEnforcer()) {
    console.log('{}');
    return;
  }

  const agentToolsPath = path.join(
    PROJECT_DIR, 'v3', '@hive-flow', 'cli', 'dist', 'src', 'mcp-tools', 'agent-tools.js'
  );
  if (!fs.existsSync(agentToolsPath)) {
    console.log('{}');
    return;
  }

  try {
    const agentToolsMod = await import(pathToFileURL(agentToolsPath).href);
    const arr = agentToolsMod.agentTools || [];
    const spawnTool = arr.find(t => t.name === 'agent_spawn');
    if (!spawnTool || typeof spawnTool.handler !== 'function') {
      console.log('{}');
      return;
    }

    const spawnResult = await spawnTool.handler({
      agentType: 'enforcer',
      provider: 'anthropic-cli',
      model: 'sonnet',
      task: 'Monitor hive delegation and enforcement. Observe only; escalate violations via enforcement channels.',
    });

    let agentId = 'unknown';
    try {
      const parsed = typeof spawnResult === 'string' ? JSON.parse(spawnResult) : spawnResult;
      agentId = parsed.agentId || agentId;
    } catch { /* ignore */ }

    const roleEnf = require('./role-enforcement.cjs');
    roleEnf.saveRole(agentId, {
      type: 'enforcer',
      assignedAt: new Date().toISOString(),
      assignedBy: 'system',
      hiveId: null,
      directWorkCount: 0,
    });

    process.stdout.write(JSON.stringify({
      hookSpecificOutput: {
        additionalContext:
          `[ENFORCER ACTIVE] Enforcer ${agentId} spawned. Monitors delegation metrics and governance. Coordinates with queen_task_worker / queen_report gates.`,
      },
    }));
  } catch {
    console.log('{}');
  }
}

main().catch(() => console.log('{}'));
