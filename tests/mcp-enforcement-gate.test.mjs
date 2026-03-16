/**
 * Tests for MCP Enforcement Gate — risk classification and level-based blocking.
 *
 * Imports the REAL compiled module (dist/src/mcp-tools/mcp-enforcement-gate.js)
 * so that regressions in the production code are caught here. Enforcement level
 * is set by writing an HMAC-signed state file under a temp project directory
 * (pointed at via CLAUDE_PROJECT_DIR) before each call, mirroring the pattern
 * used in enforcement.test.mjs.
 */

import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  mkdirSync, writeFileSync, existsSync, rmSync,
} from 'node:fs';
import { join, dirname } from 'node:path';
import { createHmac, randomBytes } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const REPO_ROOT = join(__dirname, '..');

// ---------------------------------------------------------------------------
// Import the REAL compiled module
// ---------------------------------------------------------------------------

const GATE_MODULE = join(
  REPO_ROOT,
  'v3/@hive-flow/cli/dist/src/mcp-tools/mcp-enforcement-gate.js',
);

let checkMCPEnforcement;
let classifyTool;
let ToolRisk;

// Load the real module. The require below uses createRequire so we stay in ESM.
const _require = createRequire(import.meta.url);
const gateModule = _require(GATE_MODULE);
checkMCPEnforcement = gateModule.checkMCPEnforcement;
classifyTool = gateModule.classifyTool;
ToolRisk = gateModule.ToolRisk;

// ---------------------------------------------------------------------------
// Temp project dir + HMAC helpers
// ---------------------------------------------------------------------------

let tmpProjectDir;
let enforcementDir;
let hmacKeyFile;
let stateFile;

function setupTempProject() {
  tmpProjectDir = mkdtempSync(join(tmpdir(), 'hive-flow-gate-test-'));
  enforcementDir = join(tmpProjectDir, '.hive-flow', 'enforcement');
  hmacKeyFile = join(enforcementDir, '.hmac-key');
  stateFile = join(enforcementDir, 'state.json');
  mkdirSync(enforcementDir, { recursive: true });

  // Generate a fresh HMAC key for this test run
  const key = randomBytes(32).toString('hex');
  writeFileSync(hmacKeyFile, key, { mode: 0o600 });

  // Point the gate module at this temp directory
  process.env.CLAUDE_PROJECT_DIR = tmpProjectDir;
}

function teardownTempProject() {
  delete process.env.CLAUDE_PROJECT_DIR;
  if (tmpProjectDir && existsSync(tmpProjectDir)) {
    rmSync(tmpProjectDir, { recursive: true, force: true });
  }
}

function readHmacKey() {
  const _req = createRequire(import.meta.url);
  const { readFileSync } = _req('node:fs');
  return readFileSync(hmacKeyFile, 'utf8').trim();
}

function signState(state) {
  const key = readHmacKey();
  const hmac = createHmac('sha256', key).update(JSON.stringify(state)).digest('hex');
  return { state, hmac };
}

/**
 * Write a signed enforcement state file at the given level (0–3).
 * Called before every checkMCPEnforcement() call that needs a specific level.
 */
function setEnforcementLevel(level) {
  const state = {
    level,
    violations: 0,
    consecutiveDenials: 0,
    lastActivity: new Date().toISOString(),
    restrictedGroups: [],
    history: [],
    resetAt: null,
    integrityCompromised: false,
  };
  const envelope = signState(state);
  writeFileSync(stateFile, JSON.stringify(envelope, null, 2));
}

// ---------------------------------------------------------------------------
// Helper: run enforcement at a given level for a list of tools
// ---------------------------------------------------------------------------

function checkAll(tools, level) {
  setEnforcementLevel(level);
  return tools.map(t => ({ tool: t, ...checkMCPEnforcement(t) }));
}

// ---------------------------------------------------------------------------
// Representative tool names for each risk tier
// ---------------------------------------------------------------------------

const SAMPLE_CRITICAL = [
  'mcp__hive-flow__agent_spawn',
  'mcp__hive-flow__agent_task',
  'mcp__hive-flow__system_reset',
  'mcp__hive-flow__browser_eval',  // via playwright prefix won't match — use hive-flow variant
  'mcp__hive-flow__workflow_enforcer_override',
  'mcp__hive-flow__config_import',
];

const SAMPLE_HIGH = [
  'mcp__hive-flow__terminal_execute',
  'mcp__hive-flow__swarm_init',
  'mcp__hive-flow__claims_steal',
  'mcp__hive-flow__session_delete',
  'mcp__hive-flow__memory_delete',
  'mcp__hive-flow__workflow_execute',
  'mcp__filesystem__write_file',
  'mcp__filesystem__edit_file',
  'mcp__filesystem__move_file',
];

const SAMPLE_MEDIUM = [
  'mcp__hive-flow__memory_store',
  'mcp__hive-flow__memory_migrate',
];

const SAMPLE_LOW = [
  'mcp__hive-flow__agent_list',
  'mcp__hive-flow__agent_status',
  'mcp__hive-flow__memory_search',
  'mcp__hive-flow__memory_retrieve',
  'mcp__hive-flow__system_status',
  'mcp__hive-flow__task_list',
  'mcp__filesystem__read_file',
  'mcp__filesystem__list_directory',
];

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('MCP Enforcement Gate', () => {

  before(() => {
    setupTempProject();
  });

  after(() => {
    teardownTempProject();
  });

  // Ensure a clean NORMAL state before each test so isolation holds
  beforeEach(() => {
    setEnforcementLevel(0);
  });

  // ---- I1: NORMAL (level 0) allows ALL MCP tools ----
  describe('I1: NORMAL level allows all tools', () => {
    const allTools = [...SAMPLE_CRITICAL, ...SAMPLE_HIGH, ...SAMPLE_MEDIUM, ...SAMPLE_LOW];

    it('allows every tool at level 0', () => {
      const results = checkAll(allTools, 0);
      for (const r of results) {
        assert.equal(r.allowed, true, `${r.tool} should be allowed at NORMAL`);
        assert.equal(r.reason, undefined, `${r.tool} should have no reason at NORMAL`);
      }
    });

    it('CRITICAL tools still return risk=CRITICAL at level 0', () => {
      setEnforcementLevel(0);
      for (const tool of SAMPLE_CRITICAL) {
        const r = checkMCPEnforcement(tool);
        assert.equal(r.risk, ToolRisk.CRITICAL, `${tool} risk should be CRITICAL`);
      }
    });
  });

  // ---- I2: WARNED (level 1) blocks CRITICAL, allows rest ----
  describe('I2: WARNED level blocks CRITICAL tools', () => {
    it('blocks all CRITICAL tools', () => {
      setEnforcementLevel(1);
      for (const tool of SAMPLE_CRITICAL) {
        const r = checkMCPEnforcement(tool);
        assert.equal(r.allowed, false, `${tool} should be blocked at WARNED`);
        assert.match(r.reason, /CRITICAL risk/);
        assert.match(r.reason, /level 1/);
      }
    });

    it('allows HIGH tools', () => {
      setEnforcementLevel(1);
      for (const tool of SAMPLE_HIGH) {
        const r = checkMCPEnforcement(tool);
        assert.equal(r.allowed, true, `${tool} should be allowed at WARNED`);
      }
    });

    it('allows MEDIUM tools', () => {
      setEnforcementLevel(1);
      for (const tool of SAMPLE_MEDIUM) {
        const r = checkMCPEnforcement(tool);
        assert.equal(r.allowed, true, `${tool} should be allowed at WARNED`);
      }
    });

    it('allows LOW tools', () => {
      setEnforcementLevel(1);
      for (const tool of SAMPLE_LOW) {
        const r = checkMCPEnforcement(tool);
        assert.equal(r.allowed, true, `${tool} should be allowed at WARNED`);
      }
    });
  });

  // ---- I3: RESTRICTED (level 2) blocks CRITICAL + HIGH ----
  describe('I3: RESTRICTED level blocks CRITICAL and HIGH tools', () => {
    it('blocks all CRITICAL tools', () => {
      setEnforcementLevel(2);
      for (const tool of SAMPLE_CRITICAL) {
        const r = checkMCPEnforcement(tool);
        assert.equal(r.allowed, false, `${tool} should be blocked at RESTRICTED`);
        assert.match(r.reason, /CRITICAL risk/);
      }
    });

    it('blocks all HIGH tools', () => {
      setEnforcementLevel(2);
      for (const tool of SAMPLE_HIGH) {
        const r = checkMCPEnforcement(tool);
        assert.equal(r.allowed, false, `${tool} should be blocked at RESTRICTED`);
        assert.match(r.reason, /HIGH risk/);
        assert.match(r.reason, /level 2/);
      }
    });

    it('allows MEDIUM tools', () => {
      setEnforcementLevel(2);
      for (const tool of SAMPLE_MEDIUM) {
        const r = checkMCPEnforcement(tool);
        assert.equal(r.allowed, true, `${tool} should be allowed at RESTRICTED`);
      }
    });

    it('allows LOW tools', () => {
      setEnforcementLevel(2);
      for (const tool of SAMPLE_LOW) {
        const r = checkMCPEnforcement(tool);
        assert.equal(r.allowed, true, `${tool} should be allowed at RESTRICTED`);
      }
    });
  });

  // ---- I4: HALTED (level 3) blocks all non-LOW ----
  describe('I4: HALTED level blocks all non-LOW tools', () => {
    it('blocks all CRITICAL tools', () => {
      setEnforcementLevel(3);
      for (const tool of SAMPLE_CRITICAL) {
        const r = checkMCPEnforcement(tool);
        assert.equal(r.allowed, false, `${tool} should be blocked at HALTED`);
      }
    });

    it('blocks all HIGH tools', () => {
      setEnforcementLevel(3);
      for (const tool of SAMPLE_HIGH) {
        const r = checkMCPEnforcement(tool);
        assert.equal(r.allowed, false, `${tool} should be blocked at HALTED`);
      }
    });

    it('blocks all MEDIUM tools', () => {
      setEnforcementLevel(3);
      for (const tool of SAMPLE_MEDIUM) {
        const r = checkMCPEnforcement(tool);
        assert.equal(r.allowed, false, `${tool} should be blocked at HALTED`);
        assert.match(r.reason, /MEDIUM risk/);
        assert.match(r.reason, /level 3/);
      }
    });

    it('allows LOW tools', () => {
      setEnforcementLevel(3);
      for (const tool of SAMPLE_LOW) {
        const r = checkMCPEnforcement(tool);
        assert.equal(r.allowed, true, `${tool} should be allowed at HALTED`);
      }
    });
  });

  // ---- I5: Tool name prefix stripping ----
  describe('I5: prefix stripping works correctly', () => {
    it('strips mcp__hive-flow__ prefix', () => {
      assert.equal(classifyTool('mcp__hive-flow__agent_spawn'), ToolRisk.CRITICAL);
      assert.equal(classifyTool('agent_spawn'), ToolRisk.CRITICAL);
    });

    it('strips mcp__filesystem__ prefix and remaps to filesystem__', () => {
      assert.equal(classifyTool('mcp__filesystem__write_file'), ToolRisk.HIGH);
      assert.equal(classifyTool('mcp__filesystem__edit_file'), ToolRisk.HIGH);
      assert.equal(classifyTool('mcp__filesystem__move_file'), ToolRisk.HIGH);
    });

    it('strips mcp__playwright__ prefix and remaps to browser_', () => {
      assert.equal(classifyTool('mcp__playwright__browser_eval'), ToolRisk.CRITICAL);
      assert.equal(classifyTool('mcp__playwright__browser_click'), ToolRisk.HIGH);
      assert.equal(classifyTool('mcp__playwright__browser_open'), ToolRisk.HIGH);
      assert.equal(classifyTool('mcp__playwright__browser_fill'), ToolRisk.HIGH);
    });

    it('handles bare tool names without prefix', () => {
      assert.equal(classifyTool('system_reset'), ToolRisk.CRITICAL);
      assert.equal(classifyTool('terminal_execute'), ToolRisk.HIGH);
      assert.equal(classifyTool('memory_store'), ToolRisk.MEDIUM);
      assert.equal(classifyTool('agent_list'), ToolRisk.LOW);
    });
  });

  // ---- I6: filesystem write/edit/move classified as HIGH ----
  describe('I6: filesystem write/edit/move are HIGH risk', () => {
    it('filesystem__write_file is HIGH', () => {
      assert.equal(classifyTool('filesystem__write_file'), ToolRisk.HIGH);
    });

    it('filesystem__edit_file is HIGH', () => {
      assert.equal(classifyTool('filesystem__edit_file'), ToolRisk.HIGH);
    });

    it('filesystem__move_file is HIGH', () => {
      assert.equal(classifyTool('filesystem__move_file'), ToolRisk.HIGH);
    });

    it('filesystem read tools are LOW', () => {
      assert.equal(classifyTool('mcp__filesystem__read_file'), ToolRisk.LOW);
      assert.equal(classifyTool('mcp__filesystem__list_directory'), ToolRisk.LOW);
      assert.equal(classifyTool('mcp__filesystem__read_multiple_files'), ToolRisk.LOW);
    });

    it('filesystem write tools blocked at RESTRICTED', () => {
      setEnforcementLevel(2);
      const fsTool = 'mcp__filesystem__write_file';
      const r = checkMCPEnforcement(fsTool);
      assert.equal(r.allowed, false);
      assert.match(r.reason, /HIGH risk/);
    });
  });

  // ---- I7: Unknown tools classified as LOW ----
  describe('I7: unknown tools are LOW risk', () => {
    const unknownTools = [
      'mcp__hive-flow__some_future_tool',
      'mcp__hive-flow__custom_thing',
      'totally_unknown_tool',
      'mcp__unknown-server__do_stuff',
      '',
    ];

    it('all unknown tools get LOW risk', () => {
      for (const tool of unknownTools) {
        assert.equal(classifyTool(tool), ToolRisk.LOW, `'${tool}' should be LOW`);
      }
    });

    it('unknown tools are always allowed even at HALTED', () => {
      setEnforcementLevel(3);
      for (const tool of unknownTools) {
        const r = checkMCPEnforcement(tool);
        assert.equal(r.allowed, true, `'${tool}' should be allowed at HALTED`);
      }
    });
  });

  // ---- Edge cases ----
  describe('edge cases', () => {
    it('level values above 3 still enforce HALTED rules', () => {
      setEnforcementLevel(5);
      const r = checkMCPEnforcement('mcp__hive-flow__memory_store');
      assert.equal(r.allowed, false, 'MEDIUM tool blocked at level > 3');
    });

    it('reason message includes the original tool name', () => {
      setEnforcementLevel(1);
      const tool = 'mcp__hive-flow__agent_spawn';
      const r = checkMCPEnforcement(tool);
      assert.equal(r.allowed, false);
      assert.ok(r.reason.includes(tool), 'reason should contain original tool name');
    });

    it('reason message includes the enforcement level', () => {
      setEnforcementLevel(2);
      const r = checkMCPEnforcement('mcp__hive-flow__terminal_execute');
      assert.ok(r.reason.includes('level 2'));
    });

    it('LOW tools have no reason at any level', () => {
      for (let level = 0; level <= 3; level++) {
        setEnforcementLevel(level);
        const r = checkMCPEnforcement('mcp__hive-flow__agent_list');
        assert.equal(r.allowed, true);
        assert.equal(r.reason, undefined);
      }
    });

    it('missing state file causes fail-closed (HALTED behavior)', () => {
      // Remove the state file — gate should fail closed, blocking CRITICAL tools
      if (existsSync(stateFile)) {
        rmSync(stateFile);
      }
      const r = checkMCPEnforcement('mcp__hive-flow__agent_spawn');
      assert.equal(r.allowed, false, 'CRITICAL tool must be blocked when state file is absent');
    });
  });

  // ---- Classification completeness ----
  describe('classification completeness', () => {
    // Use bare short-names that match the CRITICAL/HIGH/MEDIUM sets directly
    const CRITICAL_SHORT = [
      'agent_spawn', 'agent_task', 'workflow_enforcer_override',
      'browser_eval', 'config_import', 'system_reset',
    ];
    const HIGH_SHORT = [
      'agent_update', 'agent_terminate', 'config_set', 'config_reset',
      'terminal_execute', 'terminal_create', 'browser_open', 'browser_click',
      'browser_fill', 'swarm_init', 'hive-mind_init', 'hive-mind_spawn',
      'claims_claim', 'claims_steal', 'session_delete', 'memory_delete',
      'workflow_create', 'workflow_execute', 'daa_agent_create', 'daa_workflow_execute',
      'filesystem__write_file', 'filesystem__edit_file', 'filesystem__move_file',
    ];
    const MEDIUM_SHORT = ['memory_store', 'memory_migrate'];

    it('all CRITICAL short-names classify as CRITICAL', () => {
      for (const t of CRITICAL_SHORT) {
        assert.equal(classifyTool(t), ToolRisk.CRITICAL, `${t} should be CRITICAL`);
      }
    });

    it('all HIGH short-names classify as HIGH', () => {
      for (const t of HIGH_SHORT) {
        assert.equal(classifyTool(t), ToolRisk.HIGH, `${t} should be HIGH`);
      }
    });

    it('all MEDIUM short-names classify as MEDIUM', () => {
      for (const t of MEDIUM_SHORT) {
        assert.equal(classifyTool(t), ToolRisk.MEDIUM, `${t} should be MEDIUM`);
      }
    });
  });
});
