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
  try {
    const stateFile = path.join(ENFORCEMENT_DIR, 'state.json');
    if (!fs.existsSync(stateFile)) return 0;
    const raw = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
    if (raw?.state && typeof raw.state.level === 'number') return raw.state.level;
    if (raw?.payload && typeof raw.payload.level === 'number') return raw.payload.level;
  } catch { /* ignore */ }
  return 0;
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
