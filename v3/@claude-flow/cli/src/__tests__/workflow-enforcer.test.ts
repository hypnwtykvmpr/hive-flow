import { describe, it, expect, vi, beforeEach } from 'vitest';

// ── Module mocks (hoisted before imports) ────────────────────────────────

vi.mock('node:fs', () => ({
  existsSync: vi.fn(),
  readFileSync: vi.fn(),
  writeFileSync: vi.fn(),
  mkdirSync: vi.fn(),
  appendFileSync: vi.fn(),
}));

import { existsSync, readFileSync, writeFileSync, mkdirSync, appendFileSync } from 'node:fs';
import {
  assessComplexity,
  mapLevelToFlow,
  validateOptOut,
  loadEnforcementState,
  saveEnforcementState,
  appendAuditEntry,
  loadAuditEntries,
  validateOverride,
  workflowEnforcerTools,
  type ComplexityAssessment,
  type ComplexityLevel,
  type EnforcementState,
  type RequiredFlow,
} from '../mcp-tools/workflow-enforcer.js';

// ── Helpers ──────────────────────────────────────────────────────────────

function setupStateMocks(state?: EnforcementState) {
  (existsSync as ReturnType<typeof vi.fn>).mockImplementation((p: string) => {
    if (typeof p === 'string' && p.endsWith('current.json')) return !!state;
    return false;
  });
  (readFileSync as ReturnType<typeof vi.fn>).mockImplementation(() =>
    state ? JSON.stringify(state) : '{}',
  );
  (writeFileSync as ReturnType<typeof vi.fn>).mockImplementation(() => {});
  (mkdirSync as ReturnType<typeof vi.fn>).mockImplementation(() => {});
  (appendFileSync as ReturnType<typeof vi.fn>).mockImplementation(() => {});
}

function makeState(overrides: Partial<EnforcementState> = {}): EnforcementState {
  const assessment = overrides.assessment ?? {
    score: 50,
    level: 'MODERATE' as ComplexityLevel,
    signals: [],
    requiredFlow: mapLevelToFlow('MODERATE'),
    dismissalAllowed: false,
    assessedAt: new Date().toISOString(),
  };
  return {
    assessment,
    planRequired: true,
    planCreated: false,
    sessionHighScore: assessment.score,
    ...overrides,
  };
}

// ── Tests ────────────────────────────────────────────────────────────────

describe('workflow-enforcer', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    setupStateMocks();
  });

  // ------------------------------------------------------------------
  // Complexity Assessment
  // ------------------------------------------------------------------
  describe('Complexity Assessment', () => {
    it('scores "fix typo in README" as SIMPLE', () => {
      const result = assessComplexity('fix typo in README');
      expect(result.level).toBe('SIMPLE');
      expect(result.score).toBeLessThanOrEqual(25);
    });

    it('scores "update config value" as SIMPLE', () => {
      const result = assessComplexity('update config value');
      expect(result.level).toBe('SIMPLE');
      expect(result.score).toBeLessThanOrEqual(25);
    });

    it('scores "add API endpoint with integration tests and deploy" as MODERATE', () => {
      const result = assessComplexity('add API endpoint with integration tests and deploy config across src/routes.ts src/handler.ts');
      expect(result.level).toBe('MODERATE');
      expect(result.score).toBeGreaterThan(25);
      expect(result.score).toBeLessThanOrEqual(60);
    });

    it('scores "refactor auth across 7 files with security" as COMPLEX', () => {
      const result = assessComplexity(
        'refactor auth security across src/a.ts src/b.ts src/c.ts src/d.ts src/e.ts src/f.ts src/g.ts',
      );
      expect(result.level).toBe('COMPLEX');
      expect(result.score).toBeGreaterThan(60);
    });

    it('scores task with migration, refactor, and credential handling as COMPLEX', () => {
      const result = assessComplexity(
        'refactor and migrate database schema with credential rotation across src/db.ts src/schema.ts src/migrate.ts src/models.ts',
      );
      expect(result.level).toBe('COMPLEX');
      expect(result.score).toBeGreaterThan(60);
    });

    it('adds 20 points for security keywords', () => {
      const withSecurity = assessComplexity('handle password storage');
      const withoutSecurity = assessComplexity('handle data storage');
      const securitySignals = withSecurity.signals.filter(s => s.category === 'security');
      expect(securitySignals.length).toBeGreaterThan(0);
      expect(securitySignals[0].points).toBe(20);
      expect(withSecurity.score).toBeGreaterThanOrEqual(withoutSecurity.score + 20);
    });

    it('adds 15 points for multi-module detection', () => {
      const result = assessComplexity('update @claude-flow/cli and @claude-flow/hooks');
      const multiSignals = result.signals.filter(s => s.category === 'multi-module');
      expect(multiSignals.length).toBe(1);
      expect(multiSignals[0].points).toBe(15);
    });

    it('emits zero-point signals for low-complexity keywords', () => {
      const result = assessComplexity('fix typo and update formatting');
      const lowSignals = result.signals.filter(
        s => s.category === 'keyword' && s.description.includes('Low keyword'),
      );
      expect(lowSignals.length).toBeGreaterThan(0);
      for (const s of lowSignals) {
        expect(s.points).toBe(0);
      }
    });

    it('floors score at 0', () => {
      const result = assessComplexity('fix typo, rename, comment, formatting, lint, doc update, bump version');
      expect(result.score).toBeGreaterThanOrEqual(0);
    });

    it('caps score at 100', () => {
      const result = assessComplexity(
        'refactor migrate architecture security auth performance optimize database schema breaking change ' +
        'across src/a.ts src/b.ts src/c.ts src/d.ts src/e.ts src/f.ts src/g.ts src/h.ts ' +
        '@claude-flow/cli @claude-flow/hooks credential token password vulnerability injection',
      );
      expect(result.score).toBeLessThanOrEqual(100);
    });

    it('includes assessedAt timestamp', () => {
      const result = assessComplexity('anything');
      expect(result.assessedAt).toBeDefined();
      expect(new Date(result.assessedAt).getTime()).not.toBeNaN();
    });
  });

  // ------------------------------------------------------------------
  // Scoring: LOW_KEYWORDS neutral
  // ------------------------------------------------------------------
  describe('Scoring: LOW_KEYWORDS neutral', () => {
    it('fix typo scores 0, not negative', () => {
      const result = assessComplexity('fix typo');
      expect(result.score).toBe(0);
    });

    it('complex task with fix typo is not reduced', () => {
      const withTypo = assessComplexity('refactor auth security across src/a.ts src/b.ts src/c.ts src/d.ts src/e.ts src/f.ts src/g.ts, also fix typo');
      const withoutTypo = assessComplexity('refactor auth security across src/a.ts src/b.ts src/c.ts src/d.ts src/e.ts src/f.ts src/g.ts');
      expect(withTypo.score).toBe(withoutTypo.score);
    });

    it('multiple LOW_KEYWORDS do not stack negative', () => {
      const result = assessComplexity('fix typo, rename, comment, formatting, lint');
      expect(result.score).toBe(0);
      const lowSignals = result.signals.filter(s => s.description.includes('Low keyword'));
      for (const s of lowSignals) {
        expect(s.points).toBe(0);
      }
    });

    it('score floor is still 0', () => {
      const result = assessComplexity('fix typo rename comment formatting lint doc update bump version update config');
      expect(result.score).toBeGreaterThanOrEqual(0);
    });
  });

  // ------------------------------------------------------------------
  // RequiredFlow structured mapping
  // ------------------------------------------------------------------
  describe('RequiredFlow structured mapping', () => {
    it('SIMPLE: ambiguityFilter enabled with agentCount=1', () => {
      const result = assessComplexity('fix typo');
      const flow = result.requiredFlow;
      expect(flow.ambiguityFilter.enabled).toBe(true);
      expect(flow.ambiguityFilter.agentCount).toBe(1);
      expect(flow.ambiguityFilter.variant).toBe('lightweight');
    });

    it('SIMPLE: dualAgentAudit enabled with agentCount=1', () => {
      const result = assessComplexity('fix typo');
      const flow = result.requiredFlow;
      expect(flow.dualAgentAudit.enabled).toBe(true);
      expect(flow.dualAgentAudit.agentCount).toBe(1);
      expect(flow.dualAgentAudit.hiveMind).toBe(false);
    });

    it('SIMPLE: planningSubflow and verificationGates disabled', () => {
      const result = assessComplexity('fix typo');
      const flow = result.requiredFlow;
      expect(flow.planningSubflow.enabled).toBe(false);
      expect(flow.verificationGates.enabled).toBe(false);
    });

    it('MODERATE: planningSubflow enabled with optOutAllowed=true', () => {
      const result = assessComplexity(
        'add API endpoint with integration tests and deploy config across src/routes.ts src/handler.ts',
      );
      const flow = result.requiredFlow;
      expect(flow.planningSubflow.enabled).toBe(true);
      expect(flow.planningSubflow.optOutAllowed).toBe(true);
    });

    it('MODERATE: all components enabled', () => {
      const result = assessComplexity(
        'add API endpoint with integration tests and deploy config across src/routes.ts src/handler.ts',
      );
      const flow = result.requiredFlow;
      expect(flow.planningSubflow.enabled).toBe(true);
      expect(flow.verificationGates.enabled).toBe(true);
      expect(flow.ambiguityFilter.enabled).toBe(true);
      expect(flow.dualAgentAudit.enabled).toBe(true);
      expect(flow.postTaskVerification.enabled).toBe(true);
    });

    it('COMPLEX: planningSubflow enabled with optOutAllowed=false', () => {
      const result = assessComplexity(
        'refactor auth security across src/a.ts src/b.ts src/c.ts src/d.ts src/e.ts src/f.ts src/g.ts',
      );
      const flow = result.requiredFlow;
      expect(flow.planningSubflow.enabled).toBe(true);
      expect(flow.planningSubflow.optOutAllowed).toBe(false);
    });

    it('COMPLEX: dualAgentAudit has agentCount=5 and hiveMind=true', () => {
      const result = assessComplexity(
        'refactor auth security across src/a.ts src/b.ts src/c.ts src/d.ts src/e.ts src/f.ts src/g.ts',
      );
      const flow = result.requiredFlow;
      expect(flow.dualAgentAudit.agentCount).toBe(5);
      expect(flow.dualAgentAudit.hiveMind).toBe(true);
    });

    it('COMPLEX: ambiguityFilter has advanced mode with explorationAgents and deepAnalysis', () => {
      const result = assessComplexity(
        'refactor auth security across src/a.ts src/b.ts src/c.ts src/d.ts src/e.ts src/f.ts src/g.ts',
      );
      const flow = result.requiredFlow;
      expect(flow.ambiguityFilter.variant).toBe('advanced');
      expect(flow.ambiguityFilter.explorationAgents).toBe(2);
      expect(flow.ambiguityFilter.deepAnalysis).toBe(true);
    });

    it('dismissalAllowed only for SIMPLE', () => {
      expect(assessComplexity('fix typo').dismissalAllowed).toBe(true);
      expect(
        assessComplexity('add API endpoint with integration tests and deploy config across src/routes.ts src/handler.ts').dismissalAllowed,
      ).toBe(false);
      expect(
        assessComplexity('refactor auth security across src/a.ts src/b.ts src/c.ts src/d.ts src/e.ts src/f.ts src/g.ts').dismissalAllowed,
      ).toBe(false);
    });
  });

  // ------------------------------------------------------------------
  // MODERATE opt-out
  // ------------------------------------------------------------------
  describe('MODERATE opt-out', () => {
    it('validateOptOut allows for MODERATE', () => {
      const state = makeState();
      const result = validateOptOut(state);
      expect(result.allowed).toBe(true);
    });

    it('validateOptOut rejects for COMPLEX', () => {
      const state = makeState({
        assessment: {
          score: 70,
          level: 'COMPLEX',
          signals: [],
          requiredFlow: mapLevelToFlow('COMPLEX'),
          dismissalAllowed: false,
          assessedAt: new Date().toISOString(),
        },
      });
      const result = validateOptOut(state);
      expect(result.allowed).toBe(false);
      expect(result.reason).toContain('COMPLEX');
    });

    it('validateOptOut rejects for SIMPLE (not applicable)', () => {
      const state = makeState({
        assessment: {
          score: 5,
          level: 'SIMPLE',
          signals: [],
          requiredFlow: mapLevelToFlow('SIMPLE'),
          dismissalAllowed: true,
          assessedAt: new Date().toISOString(),
        },
      });
      const result = validateOptOut(state);
      expect(result.allowed).toBe(false);
      expect(result.reason).toContain('MODERATE');
    });

    it('opt-out is idempotent', () => {
      const state = makeState();
      const r1 = validateOptOut(state);
      const r2 = validateOptOut(state);
      expect(r1.allowed).toBe(r2.allowed);
      expect(r1.reason).toBe(r2.reason);
    });
  });

  // ------------------------------------------------------------------
  // Provider/model integration
  // ------------------------------------------------------------------
  describe('Provider/model integration', () => {
    it('SIMPLE uses gemini-cli and codex-cli as providers', () => {
      const flow = mapLevelToFlow('SIMPLE');
      expect(flow.ambiguityFilter.providerPreference).toBe('gemini-cli');
      expect(flow.dualAgentAudit.providerPreference).toBe('codex-cli');
    });

    it('COMPLEX hive-mind has no single provider (mixed)', () => {
      const flow = mapLevelToFlow('COMPLEX');
      // hiveMind agents use mixed providers, so no single providerPreference
      expect(flow.dualAgentAudit.hiveMind).toBe(true);
      expect(flow.dualAgentAudit.providerPreference).toBeUndefined();
    });

    it('no model preference is gpt-5.4-thinking', () => {
      for (const level of ['SIMPLE', 'MODERATE', 'COMPLEX'] as ComplexityLevel[]) {
        const flow = mapLevelToFlow(level);
        const prefs = [
          flow.planningSubflow.modelPreference,
          flow.verificationGates.modelPreference,
          flow.ambiguityFilter.modelPreference,
          flow.dualAgentAudit.modelPreference,
          flow.postTaskVerification.modelPreference,
        ];
        for (const p of prefs) {
          expect(p).not.toBe('gpt-5.4-thinking');
        }
      }
    });
  });

  // ------------------------------------------------------------------
  // State migration
  // ------------------------------------------------------------------
  describe('State migration', () => {
    it('migrates old boolean RequiredFlow to new shape on load', () => {
      const oldState = {
        assessment: {
          score: 50,
          level: 'MODERATE',
          signals: [],
          requiredFlow: {
            planningSubflow: false,
            verificationGates: true,
            ambiguityFilter: true,
            dualAgentAudit: false,
            postTaskVerification: true,
          },
          dismissalAllowed: false,
          assessedAt: new Date().toISOString(),
        },
        planRequired: true,
        planCreated: false,
        sessionHighScore: 50,
      };
      setupStateMocks(oldState as unknown as EnforcementState);
      const loaded = loadEnforcementState();
      expect(loaded).not.toBeNull();
      // Should have migrated to new shape
      expect(typeof loaded!.assessment.requiredFlow.planningSubflow).toBe('object');
      expect(loaded!.assessment.requiredFlow.planningSubflow.enabled).toBe(true);
      expect(loaded!.assessment.requiredFlow.ambiguityFilter.enabled).toBe(true);
    });

    it('preserves new shape RequiredFlow on load', () => {
      const newFlow = mapLevelToFlow('MODERATE');
      const state = makeState({
        assessment: {
          score: 40,
          level: 'MODERATE',
          signals: [],
          requiredFlow: newFlow,
          dismissalAllowed: false,
          assessedAt: new Date().toISOString(),
        },
      });
      setupStateMocks(state);
      const loaded = loadEnforcementState();
      expect(loaded!.assessment.requiredFlow.planningSubflow.optOutAllowed).toBe(true);
    });
  });

  // ------------------------------------------------------------------
  // Enforcement State
  // ------------------------------------------------------------------
  describe('Enforcement State', () => {
    it('persists assessment to current.json via saveEnforcementState', () => {
      const state = makeState();
      saveEnforcementState(state);
      expect(mkdirSync).toHaveBeenCalled();
      expect(writeFileSync).toHaveBeenCalledWith(
        expect.stringContaining('current.json'),
        expect.any(String),
        'utf-8',
      );
      const written = JSON.parse(
        (writeFileSync as ReturnType<typeof vi.fn>).mock.calls[0][1] as string,
      );
      expect(written.assessment.score).toBe(50);
    });

    it('loadEnforcementState returns null when no file exists', () => {
      setupStateMocks();
      const result = loadEnforcementState();
      expect(result).toBeNull();
    });

    it('loadEnforcementState returns persisted state', () => {
      const state = makeState();
      setupStateMocks(state);
      const loaded = loadEnforcementState();
      expect(loaded).not.toBeNull();
      expect(loaded!.assessment.score).toBe(50);
    });

    it('re-assessment uses highest score (sessionHighScore / no auto-downgrade)', () => {
      const prior: ComplexityAssessment = {
        score: 70,
        level: 'COMPLEX',
        signals: [],
        requiredFlow: mapLevelToFlow('COMPLEX'),
        dismissalAllowed: false,
        assessedAt: new Date().toISOString(),
      };

      const result = assessComplexity('fix typo', { priorAssessment: prior });
      expect(result.score).toBeGreaterThanOrEqual(70);
      expect(result.level).toBe('COMPLEX');
    });

    it('appendAuditEntry writes to audit.jsonl', () => {
      appendAuditEntry({
        timestamp: new Date().toISOString(),
        event: 'assessment',
        taskDescription: 'test',
        score: 50,
        level: 'MODERATE',
      });
      expect(appendFileSync).toHaveBeenCalledWith(
        expect.stringContaining('audit.jsonl'),
        expect.stringContaining('"event":"assessment"'),
        'utf-8',
      );
    });
  });

  // ------------------------------------------------------------------
  // Override
  // ------------------------------------------------------------------
  describe('Override', () => {
    it('validates successfully for valid downgrade', () => {
      const state = makeState();
      const result = validateOverride(state, 'SIMPLE', 'Emergency hotfix');
      expect(result.valid).toBe(true);
    });

    it('cannot override security-flagged task below MODERATE', () => {
      const state = makeState({
        assessment: {
          score: 65,
          level: 'COMPLEX',
          signals: [{ category: 'security', description: 'Security keyword: "auth"', points: 20 }],
          requiredFlow: mapLevelToFlow('COMPLEX'),
          dismissalAllowed: false,
          assessedAt: new Date().toISOString(),
        },
      });
      const result = validateOverride(state, 'SIMPLE', 'I want simple');
      expect(result.valid).toBe(false);
      expect(result.error).toContain('security');
    });

    it('allows override of security-flagged to MODERATE', () => {
      const state = makeState({
        assessment: {
          score: 65,
          level: 'COMPLEX',
          signals: [{ category: 'security', description: 'Security keyword: "auth"', points: 20 }],
          requiredFlow: mapLevelToFlow('COMPLEX'),
          dismissalAllowed: false,
          assessedAt: new Date().toISOString(),
        },
      });
      const result = validateOverride(state, 'MODERATE', 'Reviewed and acceptable');
      expect(result.valid).toBe(true);
    });

    it('cannot override to same or higher level', () => {
      const state = makeState();
      const same = validateOverride(state, 'MODERATE', 'No change');
      expect(same.valid).toBe(false);
      expect(same.error).toContain('higher');
    });

    it('requires a reason', () => {
      const state = makeState();
      const result = validateOverride(state, 'SIMPLE', '');
      expect(result.valid).toBe(false);
      expect(result.error).toContain('reason');
    });
  });

  // ------------------------------------------------------------------
  // MCP Tools
  // ------------------------------------------------------------------
  describe('MCP Tools', () => {
    it('exports three tools', () => {
      expect(workflowEnforcerTools).toHaveLength(3);
      const names = workflowEnforcerTools.map(t => t.name);
      expect(names).toContain('workflow_enforcer_assess');
      expect(names).toContain('workflow_enforcer_override');
      expect(names).toContain('workflow_enforcer_status');
    });

    it('workflow_enforcer_assess returns ComplexityAssessment', async () => {
      setupStateMocks();
      const tool = workflowEnforcerTools.find(t => t.name === 'workflow_enforcer_assess')!;
      const result = await tool.handler({ taskDescription: 'fix typo in README' }) as {
        content: Array<{ type: string; text: string }>;
      };
      const assessment = JSON.parse(result.content[0].text) as ComplexityAssessment;
      expect(assessment.level).toBe('SIMPLE');
      expect(assessment.score).toBeDefined();
      expect(assessment.requiredFlow).toBeDefined();
      expect(assessment.signals).toBeDefined();
      expect(writeFileSync).toHaveBeenCalled();
      expect(appendFileSync).toHaveBeenCalled();
    });

    it('workflow_enforcer_assess sets planRequired for MODERATE', async () => {
      setupStateMocks();
      const tool = workflowEnforcerTools.find(t => t.name === 'workflow_enforcer_assess')!;
      await tool.handler({
        taskDescription: 'add API endpoint with integration tests and deploy config across src/routes.ts src/handler.ts',
      });
      const writtenState = JSON.parse(
        (writeFileSync as ReturnType<typeof vi.fn>).mock.calls[0][1] as string,
      );
      expect(writtenState.planRequired).toBe(true);
    });

    it('workflow_enforcer_override rejects when no state exists', async () => {
      setupStateMocks();
      const tool = workflowEnforcerTools.find(t => t.name === 'workflow_enforcer_override')!;
      const result = await tool.handler({
        effectiveLevel: 'SIMPLE',
        reason: 'test',
      }) as { content: Array<{ type: string; text: string }>; isError?: boolean };
      expect(result.isError).toBe(true);
      const body = JSON.parse(result.content[0].text);
      expect(body.success).toBe(false);
    });

    it('workflow_enforcer_override rejects invalid override', async () => {
      const state = makeState({
        assessment: {
          score: 65,
          level: 'COMPLEX',
          signals: [{ category: 'security', description: 'Security keyword', points: 20 }],
          requiredFlow: mapLevelToFlow('COMPLEX'),
          dismissalAllowed: false,
          assessedAt: new Date().toISOString(),
        },
      });
      setupStateMocks(state);
      const tool = workflowEnforcerTools.find(t => t.name === 'workflow_enforcer_override')!;
      const result = await tool.handler({
        effectiveLevel: 'SIMPLE',
        reason: 'bypass security',
      }) as { content: Array<{ type: string; text: string }>; isError?: boolean };
      expect(result.isError).toBe(true);
      const body = JSON.parse(result.content[0].text);
      expect(body.success).toBe(false);
      expect(body.error).toContain('security');
    });

    it('workflow_enforcer_status returns current state', async () => {
      const state = makeState();
      setupStateMocks(state);
      const tool = workflowEnforcerTools.find(t => t.name === 'workflow_enforcer_status')!;
      const result = await tool.handler({}) as {
        content: Array<{ type: string; text: string }>;
      };
      const body = JSON.parse(result.content[0].text);
      expect(body.hasState).toBe(true);
      expect(body.state.assessment.score).toBe(50);
    });

    it('workflow_enforcer_status returns null state when none exists', async () => {
      setupStateMocks();
      const tool = workflowEnforcerTools.find(t => t.name === 'workflow_enforcer_status')!;
      const result = await tool.handler({}) as {
        content: Array<{ type: string; text: string }>;
      };
      const body = JSON.parse(result.content[0].text);
      expect(body.hasState).toBe(false);
      expect(body.state).toBeNull();
    });

    it('workflow_enforcer_status includes audit entries when requested', async () => {
      const state = makeState();
      setupStateMocks(state);
      // Mock audit file with entries
      (existsSync as ReturnType<typeof vi.fn>).mockImplementation((p: string) => {
        if (typeof p === 'string' && p.endsWith('current.json')) return true;
        if (typeof p === 'string' && p.endsWith('audit.jsonl')) return true;
        return false;
      });
      (readFileSync as ReturnType<typeof vi.fn>).mockImplementation((p: string) => {
        if (typeof p === 'string' && p.endsWith('audit.jsonl')) {
          return '{"timestamp":"2026-01-01","event":"assessment","taskDescription":"test","score":50,"level":"MODERATE"}\n{"timestamp":"2026-01-02","event":"gate-pass","taskDescription":"test2","score":50,"level":"MODERATE"}\n';
        }
        return JSON.stringify(state);
      });
      const tool = workflowEnforcerTools.find(t => t.name === 'workflow_enforcer_status')!;
      const result = await tool.handler({ includeAudit: true, auditLimit: 1 }) as {
        content: Array<{ type: string; text: string }>;
      };
      const body = JSON.parse(result.content[0].text);
      expect(body.recentAudit).toBeDefined();
      expect(body.recentAudit).toHaveLength(1);
    });

    it('workflow_enforcer_override applies override and saves state', async () => {
      const state = makeState({ assessment: { score: 70, level: 'COMPLEX' as ComplexityLevel, signals: [], requiredFlow: mapLevelToFlow('COMPLEX'), dismissalAllowed: false, assessedAt: new Date().toISOString() } });
      setupStateMocks(state);
      const tool = workflowEnforcerTools.find(t => t.name === 'workflow_enforcer_override')!;
      const result = await tool.handler({
        effectiveLevel: 'MODERATE',
        reason: 'Emergency hotfix',
        overrideType: 'emergency',
        overriddenBy: 'admin',
      }) as { content: Array<{ type: string; text: string }>; isError?: boolean };
      expect(result.isError).toBeUndefined();
      const body = JSON.parse(result.content[0].text);
      expect(body.success).toBe(true);
      expect(body.override.effectiveLevel).toBe('MODERATE');
      expect(body.override.originalLevel).toBe('COMPLEX');
    });
  });

  // --- Coverage: uncovered functions ---
  describe('loadAuditEntries', () => {
    it('returns empty array when file does not exist', () => {
      (existsSync as ReturnType<typeof vi.fn>).mockReturnValue(false);
      expect(loadAuditEntries()).toEqual([]);
    });

    it('returns all entries when no limit', () => {
      (existsSync as ReturnType<typeof vi.fn>).mockReturnValue(true);
      (readFileSync as ReturnType<typeof vi.fn>).mockReturnValue(
        '{"event":"a"}\n{"event":"b"}\n{"event":"c"}\n'
      );
      const entries = loadAuditEntries();
      expect(entries).toHaveLength(3);
    });

    it('returns limited entries from end', () => {
      (existsSync as ReturnType<typeof vi.fn>).mockReturnValue(true);
      (readFileSync as ReturnType<typeof vi.fn>).mockReturnValue(
        '{"event":"a"}\n{"event":"b"}\n{"event":"c"}\n'
      );
      const entries = loadAuditEntries(2);
      expect(entries).toHaveLength(2);
      expect(entries[0].event).toBe('b');
      expect(entries[1].event).toBe('c');
    });

    it('returns empty array on parse error', () => {
      (existsSync as ReturnType<typeof vi.fn>).mockReturnValue(true);
      (readFileSync as ReturnType<typeof vi.fn>).mockImplementation(() => { throw new Error('read fail'); });
      expect(loadAuditEntries()).toEqual([]);
    });
  });

  describe('assessComplexity re-request detection', () => {
    it('detects re-request pattern in task description', () => {
      const result = assessComplexity('should i continue with the implementation?');
      const hasReRequestSignal = result.signals.some(s => s.description.includes('Re-request'));
      expect(hasReRequestSignal).toBe(true);
    });

    it('detects shall I proceed pattern', () => {
      const result = assessComplexity('shall I proceed with the deployment?');
      const hasReRequestSignal = result.signals.some(s => s.description.includes('Re-request'));
      expect(hasReRequestSignal).toBe(true);
    });
  });

  describe('validateOptOut edge cases', () => {
    it('returns not allowed when no assessment', () => {
      const state = { planRequired: false, planCreated: false, sessionHighScore: 0, authorized: false, planApproved: false } as EnforcementState;
      const result = validateOptOut(state);
      expect(result.allowed).toBe(false);
      expect(result.reason).toBe('No assessment');
    });

    it('returns not allowed for SIMPLE level', () => {
      const state = makeState({ assessment: { score: 10, level: 'SIMPLE' as ComplexityLevel, signals: [], requiredFlow: mapLevelToFlow('SIMPLE'), dismissalAllowed: true, assessedAt: new Date().toISOString() } });
      const result = validateOptOut(state);
      expect(result.allowed).toBe(false);
      expect(result.reason).toContain('MODERATE');
    });
  });
});
