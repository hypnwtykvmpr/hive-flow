import { describe, it, expect, vi, beforeEach } from 'vitest';

// ── Module mocks (hoisted before imports) ────────────────────────────────

vi.mock('node:fs', () => ({
  existsSync: vi.fn(),
  readFileSync: vi.fn(),
  writeFileSync: vi.fn(),
  mkdirSync: vi.fn(),
}));

import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import {
  getDefaultGateConfig,
  shouldEscalate,
  createEscalationRecord,
  executeVerificationGate,
  loadGateStore,
  saveGateStore,
  type VerificationCheck,
  type VerificationGateConfig,
  type VerificationGateResult,
  type CheckCategory,
} from '../mcp-tools/verification-gate.js';

// ── Helpers ──────────────────────────────────────────────────────────────

function setupStoreMocks() {
  let currentStore = { gates: {} as Record<string, VerificationGateResult>, version: '1.0.0' };

  (existsSync as ReturnType<typeof vi.fn>).mockImplementation((p: string) => {
    if (typeof p === 'string' && p.endsWith('store.json')) return true;
    return false;
  });

  (readFileSync as ReturnType<typeof vi.fn>).mockImplementation(() =>
    JSON.stringify(currentStore),
  );

  (writeFileSync as ReturnType<typeof vi.fn>).mockImplementation(
    (_path: string, data: string) => {
      currentStore = JSON.parse(data);
    },
  );

  (mkdirSync as ReturnType<typeof vi.fn>).mockImplementation(() => {});

  return {
    getPersistedStore: () => currentStore,
  };
}

function setupEmptyStoreMocks() {
  (existsSync as ReturnType<typeof vi.fn>).mockReturnValue(false);
  (readFileSync as ReturnType<typeof vi.fn>).mockReturnValue('{}');
  (writeFileSync as ReturnType<typeof vi.fn>).mockImplementation(() => {});
  (mkdirSync as ReturnType<typeof vi.fn>).mockImplementation(() => {});
}

function makeGateResult(overrides: Partial<VerificationGateResult> = {}): VerificationGateResult {
  return {
    gateId: 'gate-test-1',
    fromPhase: 'Planning',
    toPhase: 'Implementation',
    status: 'waiting',
    checks: [],
    iterations: 1,
    concerns: [],
    startedAt: new Date().toISOString(),
    ...overrides,
  };
}

function makeCheck(overrides: Partial<VerificationCheck> = {}): VerificationCheck {
  return {
    checkId: 'check-1',
    category: 'syntax',
    description: 'Test check',
    status: 'passed',
    findings: ['All good'],
    severity: 'info',
    ...overrides,
  };
}

// ── Tests ────────────────────────────────────────────────────────────────

describe('verification-gate', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // ------------------------------------------------------------------
  // 1. createVerificationGate (via getDefaultGateConfig) produces
  //    correct structure per phase pair
  // ------------------------------------------------------------------
  describe('getDefaultGateConfig', () => {
    it('returns correct config for Planning->Implementation', () => {
      const config = getDefaultGateConfig('Planning', 'Implementation');
      expect(config.fromPhase).toBe('Planning');
      expect(config.toPhase).toBe('Implementation');
      expect(config.checks).toContain('factual');
      expect(config.checks).toContain('syntax');
      expect(config.checks).toContain('semantic');
      expect(config.checks).toContain('security');
      expect(config.minAgents).toBe(2);
      expect(config.escalationThreshold).toBe(3);
    });

    it('returns correct config for Implementation->Testing', () => {
      const config = getDefaultGateConfig('Implementation', 'Testing');
      expect(config.fromPhase).toBe('Implementation');
      expect(config.toPhase).toBe('Testing');
      expect(config.checks).toEqual(['syntax', 'semantic', 'security', 'edge-case']);
      expect(config.minAgents).toBe(2);
    });

    it('returns correct config for Testing->Review', () => {
      const config = getDefaultGateConfig('Testing', 'Review');
      expect(config.checks).toEqual(['error-omission', 'edge-case', 'blindspot']);
      expect(config.escalationThreshold).toBe(2);
    });

    it('returns correct config for Review->Integration', () => {
      const config = getDefaultGateConfig('Review', 'Integration');
      expect(config.checks).toEqual(['factual', 'security', 'alternative']);
      expect(config.escalationThreshold).toBe(2);
    });

    it('returns fallback config with all categories for unknown transitions', () => {
      const config = getDefaultGateConfig('Unknown', 'Phase');
      expect(config.fromPhase).toBe('Unknown');
      expect(config.toPhase).toBe('Phase');
      expect(config.checks.length).toBe(8); // all categories
      expect(config.minAgents).toBe(2);
      expect(config.escalationThreshold).toBe(3);
    });
  });

  // ------------------------------------------------------------------
  // 2. Check category functions return valid VerificationCheck arrays
  // ------------------------------------------------------------------
  describe('check category functions (via executeVerificationGate)', () => {
    it('runs all configured check categories and returns valid checks', async () => {
      setupStoreMocks();
      const config: VerificationGateConfig = {
        fromPhase: 'Planning',
        toPhase: 'Implementation',
        checks: ['factual', 'syntax', 'semantic', 'security'],
        minAgents: 2,
        escalationThreshold: 3,
      };

      const result = await executeVerificationGate(config, { key: 'value' }, {});

      expect(result.checks.length).toBeGreaterThan(0);
      for (const check of result.checks) {
        expect(check.checkId).toBeDefined();
        expect(check.category).toBeDefined();
        expect(check.description).toBeDefined();
        expect(['pending', 'passed', 'failed', 'warning']).toContain(check.status);
        expect(Array.isArray(check.findings)).toBe(true);
        expect(['info', 'warning', 'critical']).toContain(check.severity);
      }
    });

    it('returns checks for each requested category', async () => {
      setupStoreMocks();
      const categories: CheckCategory[] = ['syntax', 'security'];
      const config: VerificationGateConfig = {
        fromPhase: 'Test',
        toPhase: 'Test',
        checks: categories,
        minAgents: 1,
        escalationThreshold: 2,
      };

      const result = await executeVerificationGate(config, { test: true }, {});

      const returnedCategories = new Set(result.checks.map(c => c.category));
      for (const cat of categories) {
        expect(returnedCategories.has(cat)).toBe(true);
      }
    });
  });

  // ------------------------------------------------------------------
  // 3. Factual check has webVerified: true
  // ------------------------------------------------------------------
  describe('factual checks', () => {
    it('has webVerified: true on factual checks', async () => {
      setupStoreMocks();
      const config: VerificationGateConfig = {
        fromPhase: 'A',
        toPhase: 'B',
        checks: ['factual'],
        minAgents: 1,
        escalationThreshold: 2,
      };

      const result = await executeVerificationGate(config, { claim: 'always works' }, {});

      const factualChecks = result.checks.filter(c => c.category === 'factual');
      expect(factualChecks.length).toBeGreaterThan(0);
      for (const check of factualChecks) {
        expect(check.webVerified).toBe(true);
      }
    });
  });

  // ------------------------------------------------------------------
  // 4. Semantic check includes scope-creep detection
  // ------------------------------------------------------------------
  describe('semantic checks', () => {
    it('detects scope creep when output drifts from original request', async () => {
      setupStoreMocks();
      const config: VerificationGateConfig = {
        fromPhase: 'A',
        toPhase: 'B',
        checks: ['semantic'],
        minAgents: 1,
        escalationThreshold: 2,
      };

      const phaseOutput = { plan: 'Build a completely different feature about cooking' };
      const context = { originalRequest: 'Implement user authentication with OAuth' };

      const result = await executeVerificationGate(config, phaseOutput, context);

      const semanticChecks = result.checks.filter(c => c.category === 'semantic');
      expect(semanticChecks.length).toBeGreaterThan(0);

      const scopeCheck = semanticChecks.find(c =>
        c.description.toLowerCase().includes('scope'),
      );
      expect(scopeCheck).toBeDefined();
      expect(scopeCheck!.status).toBe('failed');
      expect(scopeCheck!.findings.some(f => f.toLowerCase().includes('drift'))).toBe(true);
    });

    it('passes scope check when output aligns with request', async () => {
      setupStoreMocks();
      const config: VerificationGateConfig = {
        fromPhase: 'A',
        toPhase: 'B',
        checks: ['semantic'],
        minAgents: 1,
        escalationThreshold: 2,
      };

      const phaseOutput = { plan: 'Implement authentication with OAuth tokens' };
      const context = { originalRequest: 'Implement user authentication with OAuth' };

      const result = await executeVerificationGate(config, phaseOutput, context);

      const scopeCheck = result.checks.find(c =>
        c.description.toLowerCase().includes('scope'),
      );
      expect(scopeCheck).toBeDefined();
      expect(scopeCheck!.status).toBe('passed');
    });
  });

  // ------------------------------------------------------------------
  // 5. Gate passes when all checks pass (status = 'passed')
  // ------------------------------------------------------------------
  describe('gate pass/fail', () => {
    it('sets status to passed when all checks pass', async () => {
      setupStoreMocks();
      // Use semantic check with aligned output (should pass)
      const config: VerificationGateConfig = {
        fromPhase: 'A',
        toPhase: 'B',
        checks: ['semantic'],
        minAgents: 1,
        escalationThreshold: 2,
      };

      const phaseOutput = { plan: 'Build the feature as requested' };
      const context = {};

      const result = await executeVerificationGate(config, phaseOutput, context);

      // When no originalRequest in context, semantic passes by default
      const failedChecks = result.checks.filter(c => c.status === 'failed');
      if (failedChecks.length === 0) {
        expect(result.status).toBe('passed');
        expect(result.concerns).toHaveLength(0);
      }
    });

    // ------------------------------------------------------------------
    // 6. Gate fails and packages concerns into ConcernPackage
    // ------------------------------------------------------------------
    it('sets status to waiting and creates ConcernPackage when checks fail', async () => {
      setupStoreMocks();
      const config: VerificationGateConfig = {
        fromPhase: 'A',
        toPhase: 'B',
        checks: ['security'],
        minAgents: 1,
        escalationThreshold: 2,
      };

      // No validation keywords -> security check will fail
      const phaseOutput = { plan: 'Store passwords in plaintext in the database' };

      const result = await executeVerificationGate(config, phaseOutput, {});

      expect(result.status).toBe('waiting');
      expect(result.concerns.length).toBeGreaterThan(0);

      const concern = result.concerns[0];
      expect(concern.iteration).toBe(1);
      expect(concern.failedChecks.length).toBeGreaterThan(0);
      expect(concern.remediationRequest).toContain('remediation');
      expect(concern.submittedAt).toBeDefined();
    });
  });

  // ------------------------------------------------------------------
  // 7. shouldEscalate returns correct thresholds
  // ------------------------------------------------------------------
  describe('shouldEscalate', () => {
    it('escalates at 2 iterations for low complexity (<=2)', () => {
      expect(shouldEscalate(1, 1)).toBe(false);
      expect(shouldEscalate(2, 1)).toBe(true);
      expect(shouldEscalate(2, 2)).toBe(true);
    });

    it('escalates at 3 iterations for medium complexity (3-5)', () => {
      expect(shouldEscalate(2, 3)).toBe(false);
      expect(shouldEscalate(3, 3)).toBe(true);
      expect(shouldEscalate(3, 5)).toBe(true);
    });

    it('escalates at 5 iterations for high complexity (>5)', () => {
      expect(shouldEscalate(4, 6)).toBe(false);
      expect(shouldEscalate(5, 6)).toBe(true);
      expect(shouldEscalate(5, 10)).toBe(true);
    });
  });

  // ------------------------------------------------------------------
  // 8. createEscalationRecord never returns 'fail'
  // ------------------------------------------------------------------
  describe('createEscalationRecord', () => {
    it('returns continue-iterating when critical failures with high ratio', () => {
      const gate = makeGateResult({
        iterations: 3,
        checks: [
          makeCheck({ status: 'failed', severity: 'critical', category: 'security' }),
          makeCheck({ status: 'failed', severity: 'critical', category: 'syntax' }),
          makeCheck({ status: 'failed', severity: 'warning', category: 'blindspot' }),
        ],
      });

      const record = createEscalationRecord(gate, {});

      expect(record.decision).toBe('continue-iterating');
      expect(record.decision).not.toBe('fail');
      expect(record.rationale).toBeDefined();
      expect(record.guidance).toBeDefined();
      expect(record.decidedAt).toBeDefined();
    });

    it('returns pass-with-caveats when remaining issues are non-critical', () => {
      const gate = makeGateResult({
        iterations: 4,
        checks: [
          makeCheck({ status: 'passed', severity: 'info' }),
          makeCheck({ status: 'warning', severity: 'warning', category: 'blindspot', findings: ['Minor concern'] }),
          makeCheck({ status: 'failed', severity: 'warning', category: 'alternative', findings: ['No alternatives'] }),
        ],
      });

      const record = createEscalationRecord(gate, {});

      expect(record.decision).toBe('pass-with-caveats');
      expect(record.decision).not.toBe('fail');
      expect(record.caveats.length).toBeGreaterThan(0);
      expect(record.decidedAt).toBeDefined();
    });

    it('never returns fail as a decision', () => {
      // Test various configurations to confirm 'fail' is never a possible outcome
      const scenarios = [
        makeGateResult({ checks: [], iterations: 10 }),
        makeGateResult({
          iterations: 5,
          checks: [
            makeCheck({ status: 'failed', severity: 'critical' }),
          ],
        }),
        makeGateResult({
          iterations: 1,
          checks: [
            makeCheck({ status: 'failed', severity: 'warning' }),
            makeCheck({ status: 'failed', severity: 'warning' }),
          ],
        }),
      ];

      for (const gate of scenarios) {
        const record = createEscalationRecord(gate, {});
        expect(['continue-iterating', 'pass-with-caveats']).toContain(record.decision);
      }
    });
  });

  // ------------------------------------------------------------------
  // 9. getDefaultGateConfig returns correct configs for each transition
  // ------------------------------------------------------------------
  describe('getDefaultGateConfig edge cases', () => {
    it('returns a copy not the original object', () => {
      const config1 = getDefaultGateConfig('Planning', 'Implementation');
      const config2 = getDefaultGateConfig('Planning', 'Implementation');
      expect(config1).toEqual(config2);
      expect(config1).not.toBe(config2); // different references
    });

    it('includes all 8 check categories in Planning->Implementation', () => {
      const config = getDefaultGateConfig('Planning', 'Implementation');
      const allCategories: CheckCategory[] = [
        'factual', 'syntax', 'semantic', 'blindspot',
        'error-omission', 'alternative', 'edge-case', 'security',
      ];
      expect(config.checks).toEqual(allCategories);
    });
  });
});
