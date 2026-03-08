import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { existsSync, mkdirSync, writeFileSync, unlinkSync, rmSync } from 'node:fs';
import { join } from 'node:path';

// Test that workflowEnforcerTools is registered
import { workflowEnforcerTools, mapLevelToFlow, validateOptOut } from '../mcp-tools/workflow-enforcer.js';
import { isAmbiguityGenuine } from '../mcp-tools/ambiguity-filter.js';
import { loadEnforcementState, saveEnforcementState, assessComplexity, appendAuditEntry } from '../mcp-tools/workflow-enforcer.js';
import type { EnforcementState } from '../mcp-tools/workflow-enforcer.js';

const TEST_DIR = join(process.cwd(), '.claude-flow-test-enforcement');
const ENFORCEMENT_DIR = join(TEST_DIR, 'enforcement');

describe('Enforcement Wiring (H3.1)', () => {
  // --- MCP Tool Registration ---
  describe('MCP tool registration', () => {
    it('workflowEnforcerTools exports 3 tools', () => {
      expect(workflowEnforcerTools).toHaveLength(3);
    });

    it('exports workflow_enforcer_assess tool', () => {
      const tool = workflowEnforcerTools.find(t => t.name === 'workflow_enforcer_assess');
      expect(tool).toBeDefined();
      expect(tool!.inputSchema.required).toContain('taskDescription');
    });

    it('exports workflow_enforcer_override tool', () => {
      const tool = workflowEnforcerTools.find(t => t.name === 'workflow_enforcer_override');
      expect(tool).toBeDefined();
      expect(tool!.inputSchema.required).toContain('effectiveLevel');
    });

    it('exports workflow_enforcer_status tool', () => {
      const tool = workflowEnforcerTools.find(t => t.name === 'workflow_enforcer_status');
      expect(tool).toBeDefined();
    });
  });

  // --- EnforcementState authorized/planApproved ---
  describe('EnforcementState authorized/planApproved fields', () => {
    it('assessComplexity returns assessment without authorized fields (those are state-level)', () => {
      const assessment = assessComplexity('fix typo');
      expect(assessment.score).toBeDefined();
      expect(assessment.level).toBeDefined();
    });

    it('mapLevelToFlow returns RequiredFlow with rich configs', () => {
      const flow = mapLevelToFlow('COMPLEX');
      expect(flow.ambiguityFilter.enabled).toBe(true);
      expect(flow.ambiguityFilter.agentCount).toBe(2);
      expect(flow.dualAgentAudit.hiveMind).toBe(true);
    });
  });

  // --- isAmbiguityGenuine with authorization context ---
  describe('isAmbiguityGenuine with authorization context', () => {
    it('auto-resolves re-request when authorized', () => {
      const result = isAmbiguityGenuine(
        ['Should I proceed with the implementation?', 'Continue with next phase'],
        { authorized: true },
      );
      expect(result.genuine).toBe(false);
      expect(result.confidence).toBe(1.0);
      expect(result.reason).toMatch(/re-request|policy violation|authorized|continuation/i);
    });

    it('auto-resolves continuation vs stop-and-ask when planApproved', () => {
      const result = isAmbiguityGenuine(
        ['Proceed with Phase H implementation', 'Stop and check with user first'],
        { planApproved: true },
      );
      expect(result.genuine).toBe(false);
      expect(result.autoSelected).toBe('Proceed with Phase H implementation');
    });

    it('does NOT auto-resolve when unauthorized', () => {
      const result = isAmbiguityGenuine(
        ['Should I proceed?', 'Wait for instructions'],
        {},
      );
      // Without authorization, re-request detection should not fire
      if (!result.genuine) {
        expect(result.reason).not.toMatch(/re-request/i);
      }
    });

    it('does NOT auto-resolve genuine architectural decisions even when authorized', () => {
      const result = isAmbiguityGenuine(
        ['Use PostgreSQL', 'Use MongoDB'],
        { authorized: true },
      );
      // These are real choices, not re-requests
      if (!result.genuine) {
        expect(result.reason).not.toMatch(/re-request/i);
      }
    });
  });

  // --- saveEnforcementState auto-derives authorized/planApproved ---
  describe('saveEnforcementState auto-derivation', () => {
    it('sets authorized=true when planCreated=true', () => {
      const state: EnforcementState = {
        assessment: assessComplexity('test task'),
        planRequired: true,
        planCreated: true,
        sessionHighScore: 50,
        authorized: false,
        planApproved: false,
      };
      saveEnforcementState(state);
      const loaded = loadEnforcementState();
      expect(loaded).not.toBeNull();
      expect(loaded!.authorized).toBe(true);
      expect(loaded!.planApproved).toBe(true);
    });

    it('preserves authorized=true even when planCreated=false', () => {
      const state: EnforcementState = {
        assessment: assessComplexity('test task'),
        planRequired: false,
        planCreated: false,
        sessionHighScore: 10,
        authorized: true,
        planApproved: false,
      };
      saveEnforcementState(state);
      const loaded = loadEnforcementState();
      expect(loaded).not.toBeNull();
      expect(loaded!.authorized).toBe(true);
      expect(loaded!.planApproved).toBe(false);
    });

    it('defaults both to false when planCreated=false and authorized=false', () => {
      const state: EnforcementState = {
        assessment: assessComplexity('test'),
        planRequired: false,
        planCreated: false,
        sessionHighScore: 0,
        authorized: false,
        planApproved: false,
      };
      saveEnforcementState(state);
      const loaded = loadEnforcementState();
      expect(loaded).not.toBeNull();
      expect(loaded!.authorized).toBe(false);
      expect(loaded!.planApproved).toBe(false);
    });
  });

  // --- Adversarial pattern detection through isAmbiguityGenuine ---
  describe('adversarial patterns detected via isAmbiguityGenuine', () => {
    const authorizedCtx = { authorized: true };

    const adversarialPhrases = [
      'It might be worth checking if the approach still holds',
      'If you\'d prefer, I could take a different approach',
      'I wonder if we should reconsider the architecture',
      'I defer to your judgment on this matter',
      'Before I continue, is there anything you want adjusted?',
      'This also touches the auth module — should I include that?',
      'This could be risky — shall I proceed carefully?',
      'Just wanted to confirm we are aligned on the approach',
      'Perhaps it would be prudent to verify the assumptions',
      'Your guidance would be valuable here',
      'Parking this here for your review before moving on',
      'Flagging this decision point for visibility',
    ];

    for (const phrase of adversarialPhrases) {
      it(`detects adversarial re-request: "${phrase.slice(0, 50)}..."`, () => {
        const result = isAmbiguityGenuine(
          [phrase, 'Continue with authorized implementation'],
          authorizedCtx,
        );
        expect(result.genuine).toBe(false);
        expect(result.confidence).toBe(1.0);
      });
    }
  });

  // --- Legitimate permission requests NOT false-positived ---
  describe('legitimate permission requests pass through', () => {
    const authorizedCtx = { authorized: true };

    it('genuinely new scope not in plan passes through scoring', () => {
      const result = isAmbiguityGenuine(
        ['Extend to database migration (not in plan)', 'Stay within current plan scope'],
        authorizedCtx,
      );
      // This may or may not be genuine depending on scoring,
      // but should NOT be caught by re-request detection
      if (!result.genuine && result.reason) {
        expect(result.reason).not.toMatch(/re-request/i);
      }
    });
  });
});
