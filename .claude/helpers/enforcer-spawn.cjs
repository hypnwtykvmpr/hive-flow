#!/usr/bin/env node
/**
 * SubagentStart — singleton ENFORCER agent when active hives exist.
 */
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const { pathToFileURL } = require('url');
const { resolveHiveFlowCliFile } = require('./layout-paths.cjs');

const PROJECT_DIR = path.resolve(__dirname, '..', '..');
const HIVES_DIR = path.join(PROJECT_DIR, '.hive-flow', 'hives');
const ENFORCEMENT_DIR = path.join(PROJECT_DIR, '.hive-flow', 'enforcement');
function resolveHiveHome() {
  const configured = String(process.env.HIVE_FLOW_HOME || '').trim();
  if (configured && path.isAbsolute(configured)) return path.resolve(configured);
  return path.join(os.homedir(), '.hive-flow');
}
const HIVE_HOME = resolveHiveHome();
const GLOBAL_ENFORCEMENT_DIR = path.join(HIVE_HOME, 'enforcement');
const GLOBAL_STATE_FILE = path.join(GLOBAL_ENFORCEMENT_DIR, 'global', 'state.json');
const GLOBAL_HMAC_KEY_FILE = path.join(GLOBAL_ENFORCEMENT_DIR, '.hmac-key');
const PROJECT_SCOPE_ID = `project-${crypto.createHash('sha256').update(PROJECT_DIR).digest('hex').slice(0, 16)}`;
const PROJECT_STATE_FILE = path.join(GLOBAL_ENFORCEMENT_DIR, 'projects', PROJECT_SCOPE_ID, 'state.json');

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
  let level = 0;
  for (const stateFile of [
    PROJECT_STATE_FILE,
    GLOBAL_STATE_FILE,
    path.join(ENFORCEMENT_DIR, 'state.json'),
  ]) {
    const candidate = readEnforcementLevelFromFile(stateFile);
    if (candidate.invalid) return 3;
    if (candidate.exists) level = Math.max(level, candidate.level);
  }
  return level;
}

function readEnforcementLevelFromFile(stateFile) {
  try {
    if (!fs.existsSync(stateFile)) return { exists: false, invalid: false, level: 0 };
    const raw = JSON.parse(fs.readFileSync(stateFile, 'utf8'));

    // SEC-005: HMAC verification before trusting enforcement level.
    // Fail-closed: return HALTED (3) on verification failure or missing key.
    const hmacKeyFiles = [
      GLOBAL_HMAC_KEY_FILE,
      path.join(ENFORCEMENT_DIR, '.hmac-key'),
    ];

    if (raw?.state !== undefined && typeof raw.hmac === 'string') {
      // enforcement.cjs envelope: { state, hmac }
      const actualBuf = Buffer.from(raw.hmac, 'hex');
      if (!verifyWithAnyKey(crypto, hmacKeyFiles, raw.state, actualBuf)) return { exists: true, invalid: true, level: 3 };
      return { exists: true, invalid: false, level: typeof raw.state.level === 'number' ? raw.state.level : 0 };
    }

    if (raw?.payload !== undefined && typeof raw.signature === 'string') {
      // workflow-enforcer.ts envelope: { payload, signature }
      const actualBuf = Buffer.from(raw.signature, 'hex');
      if (!verifyWithAnyKey(crypto, hmacKeyFiles, raw.payload, actualBuf)) return { exists: true, invalid: true, level: 3 };
      return { exists: true, invalid: false, level: typeof raw.payload.level === 'number' ? raw.payload.level : 0 };
    }

    // Unsigned state — fail-closed (HALTED)
    return { exists: true, invalid: true, level: 3 };
  } catch {
    return { exists: true, invalid: true, level: 3 };
  }
}

function verifyWithAnyKey(crypto, hmacKeyFiles, payload, actualBuf) {
  for (const hmacKeyFile of hmacKeyFiles) {
    if (!fs.existsSync(hmacKeyFile)) continue;
    let key;
    try { key = fs.readFileSync(hmacKeyFile, 'utf8').trim(); } catch { continue; }
    if (!key) continue;
    const expected = crypto.createHmac('sha256', key).update(JSON.stringify(payload)).digest('hex');
    const expectedBuf = Buffer.from(expected, 'hex');
    if (expectedBuf.length === actualBuf.length && crypto.timingSafeEqual(expectedBuf, actualBuf)) return true;
  }
  return false;
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

  const agentToolsPath = resolveHiveFlowCliFile('dist/src/mcp-tools/agent-tools.js', {
    env: process.env,
    cwd: process.cwd(),
    helperDir: __dirname,
  });
  if (!agentToolsPath || !fs.existsSync(agentToolsPath)) {
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
        hookEventName: 'SubagentStart',
        additionalContext:
          `[ENFORCER ACTIVE] Enforcer ${agentId} spawned. Monitors delegation metrics and governance. Coordinates with queen_task_worker / queen_report gates.`,
      },
    }));
  } catch {
    console.log('{}');
  }
}

if (require.main === module) {
  main().catch(() => console.log('{}'));
}

module.exports = {
  readEnforcementLevel,
};
