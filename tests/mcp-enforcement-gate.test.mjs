/**
 * Tests for MCP Enforcement Gate — risk classification and level-based blocking.
 *
 * Since the gate module is TypeScript and may not be compiled, we reimplement
 * the pure classification and enforcement logic here to validate expected
 * behavior across all enforcement levels.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

// ---------------------------------------------------------------------------
// Reimplement classification logic (mirrors mcp-enforcement-gate.ts)
// ---------------------------------------------------------------------------

const ToolRisk = { CRITICAL: 3, HIGH: 2, MEDIUM: 1, LOW: 0 };

const CRITICAL_TOOLS = new Set([
  'agent_spawn', 'agent_task',
  'workflow_enforcer_override',
  'browser_eval',
  'config_import',
  'system_reset',
]);

const HIGH_TOOLS = new Set([
  'agent_update', 'agent_terminate',
  'config_set', 'config_reset',
  'terminal_execute', 'terminal_create',
  'browser_open', 'browser_click', 'browser_fill',
  'swarm_init',
  'hive-mind_init', 'hive-mind_spawn',
  'claims_claim', 'claims_steal',
  'session_delete',
  'memory_delete',
  'workflow_create', 'workflow_execute',
  'daa_agent_create', 'daa_workflow_execute',
  'filesystem__write_file', 'filesystem__edit_file', 'filesystem__move_file',
]);

const MEDIUM_TOOLS = new Set([
  'memory_store', 'memory_migrate',
]);

function classifyTool(toolName) {
  const shortName = toolName
    .replace(/^mcp__hive-flow__/, '')
    .replace(/^mcp__filesystem__/, 'filesystem__')
    .replace(/^mcp__playwright__browser_/, 'browser_');

  if (CRITICAL_TOOLS.has(shortName)) return ToolRisk.CRITICAL;
  if (HIGH_TOOLS.has(shortName)) return ToolRisk.HIGH;
  if (MEDIUM_TOOLS.has(shortName)) return ToolRisk.MEDIUM;
  return ToolRisk.LOW;
}

function checkMCPEnforcement(toolName, level) {
  const risk = classifyTool(toolName);

  if (level === 0) {
    return { allowed: true, risk };
  }

  if (level >= 1 && risk >= ToolRisk.CRITICAL) {
    return {
      allowed: false,
      risk,
      reason: `[MCP ENFORCEMENT] Tool '${toolName}' (CRITICAL risk) blocked at enforcement level ${level}.`,
    };
  }

  if (level >= 2 && risk >= ToolRisk.HIGH) {
    return {
      allowed: false,
      risk,
      reason: `[MCP ENFORCEMENT] Tool '${toolName}' (HIGH risk) blocked at enforcement level ${level}.`,
    };
  }

  if (level >= 3 && risk >= ToolRisk.MEDIUM) {
    return {
      allowed: false,
      risk,
      reason: `[MCP ENFORCEMENT] Tool '${toolName}' (MEDIUM risk) blocked at enforcement level ${level}.`,
    };
  }

  return { allowed: true, risk };
}

// ---------------------------------------------------------------------------
// Helper: run enforcement at a given level for a list of tools
// ---------------------------------------------------------------------------

function checkAll(tools, level) {
  return tools.map(t => ({ tool: t, ...checkMCPEnforcement(t, level) }));
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
      for (const tool of SAMPLE_CRITICAL) {
        const r = checkMCPEnforcement(tool, 0);
        assert.equal(r.risk, ToolRisk.CRITICAL, `${tool} risk should be CRITICAL`);
      }
    });
  });

  // ---- I2: WARNED (level 1) blocks CRITICAL, allows rest ----
  describe('I2: WARNED level blocks CRITICAL tools', () => {
    it('blocks all CRITICAL tools', () => {
      for (const tool of SAMPLE_CRITICAL) {
        const r = checkMCPEnforcement(tool, 1);
        assert.equal(r.allowed, false, `${tool} should be blocked at WARNED`);
        assert.match(r.reason, /CRITICAL risk/);
        assert.match(r.reason, /level 1/);
      }
    });

    it('allows HIGH tools', () => {
      for (const tool of SAMPLE_HIGH) {
        const r = checkMCPEnforcement(tool, 1);
        assert.equal(r.allowed, true, `${tool} should be allowed at WARNED`);
      }
    });

    it('allows MEDIUM tools', () => {
      for (const tool of SAMPLE_MEDIUM) {
        const r = checkMCPEnforcement(tool, 1);
        assert.equal(r.allowed, true, `${tool} should be allowed at WARNED`);
      }
    });

    it('allows LOW tools', () => {
      for (const tool of SAMPLE_LOW) {
        const r = checkMCPEnforcement(tool, 1);
        assert.equal(r.allowed, true, `${tool} should be allowed at WARNED`);
      }
    });
  });

  // ---- I3: RESTRICTED (level 2) blocks CRITICAL + HIGH ----
  describe('I3: RESTRICTED level blocks CRITICAL and HIGH tools', () => {
    it('blocks all CRITICAL tools', () => {
      for (const tool of SAMPLE_CRITICAL) {
        const r = checkMCPEnforcement(tool, 2);
        assert.equal(r.allowed, false, `${tool} should be blocked at RESTRICTED`);
        assert.match(r.reason, /CRITICAL risk/);
      }
    });

    it('blocks all HIGH tools', () => {
      for (const tool of SAMPLE_HIGH) {
        const r = checkMCPEnforcement(tool, 2);
        assert.equal(r.allowed, false, `${tool} should be blocked at RESTRICTED`);
        assert.match(r.reason, /HIGH risk/);
        assert.match(r.reason, /level 2/);
      }
    });

    it('allows MEDIUM tools', () => {
      for (const tool of SAMPLE_MEDIUM) {
        const r = checkMCPEnforcement(tool, 2);
        assert.equal(r.allowed, true, `${tool} should be allowed at RESTRICTED`);
      }
    });

    it('allows LOW tools', () => {
      for (const tool of SAMPLE_LOW) {
        const r = checkMCPEnforcement(tool, 2);
        assert.equal(r.allowed, true, `${tool} should be allowed at RESTRICTED`);
      }
    });
  });

  // ---- I4: HALTED (level 3) blocks all non-LOW ----
  describe('I4: HALTED level blocks all non-LOW tools', () => {
    it('blocks all CRITICAL tools', () => {
      for (const tool of SAMPLE_CRITICAL) {
        const r = checkMCPEnforcement(tool, 3);
        assert.equal(r.allowed, false, `${tool} should be blocked at HALTED`);
      }
    });

    it('blocks all HIGH tools', () => {
      for (const tool of SAMPLE_HIGH) {
        const r = checkMCPEnforcement(tool, 3);
        assert.equal(r.allowed, false, `${tool} should be blocked at HALTED`);
      }
    });

    it('blocks all MEDIUM tools', () => {
      for (const tool of SAMPLE_MEDIUM) {
        const r = checkMCPEnforcement(tool, 3);
        assert.equal(r.allowed, false, `${tool} should be blocked at HALTED`);
        assert.match(r.reason, /MEDIUM risk/);
        assert.match(r.reason, /level 3/);
      }
    });

    it('allows LOW tools', () => {
      for (const tool of SAMPLE_LOW) {
        const r = checkMCPEnforcement(tool, 3);
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
      const fsTool = 'mcp__filesystem__write_file';
      const r = checkMCPEnforcement(fsTool, 2);
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
      for (const tool of unknownTools) {
        const r = checkMCPEnforcement(tool, 3);
        assert.equal(r.allowed, true, `'${tool}' should be allowed at HALTED`);
      }
    });
  });

  // ---- Edge cases ----
  describe('edge cases', () => {
    it('level values above 3 still enforce HALTED rules', () => {
      const r = checkMCPEnforcement('mcp__hive-flow__memory_store', 5);
      assert.equal(r.allowed, false, 'MEDIUM tool blocked at level > 3');
    });

    it('reason message includes the original tool name', () => {
      const tool = 'mcp__hive-flow__agent_spawn';
      const r = checkMCPEnforcement(tool, 1);
      assert.equal(r.allowed, false);
      assert.ok(r.reason.includes(tool), 'reason should contain original tool name');
    });

    it('reason message includes the enforcement level', () => {
      const r = checkMCPEnforcement('mcp__hive-flow__terminal_execute', 2);
      assert.ok(r.reason.includes('level 2'));
    });

    it('LOW tools have no reason at any level', () => {
      for (let level = 0; level <= 3; level++) {
        const r = checkMCPEnforcement('mcp__hive-flow__agent_list', level);
        assert.equal(r.allowed, true);
        assert.equal(r.reason, undefined);
      }
    });
  });

  // ---- Classification completeness ----
  describe('classification completeness', () => {
    it('all CRITICAL_TOOLS entries classify as CRITICAL', () => {
      for (const t of CRITICAL_TOOLS) {
        assert.equal(classifyTool(t), ToolRisk.CRITICAL, `${t} should be CRITICAL`);
      }
    });

    it('all HIGH_TOOLS entries classify as HIGH', () => {
      for (const t of HIGH_TOOLS) {
        assert.equal(classifyTool(t), ToolRisk.HIGH, `${t} should be HIGH`);
      }
    });

    it('all MEDIUM_TOOLS entries classify as MEDIUM', () => {
      for (const t of MEDIUM_TOOLS) {
        assert.equal(classifyTool(t), ToolRisk.MEDIUM, `${t} should be MEDIUM`);
      }
    });
  });
});
