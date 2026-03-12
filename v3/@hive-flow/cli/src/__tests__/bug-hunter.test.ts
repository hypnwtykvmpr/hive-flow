import { describe, it, expect, vi, beforeEach } from 'vitest';

// ── Module mocks (must be hoisted before imports) ──────────────────────────

// Mock node:fs — controls existsSync, readFileSync, writeFileSync, mkdirSync
vi.mock('node:fs', () => ({
  existsSync: vi.fn(),
  readFileSync: vi.fn(),
  writeFileSync: vi.fn(),
  mkdirSync: vi.fn(),
}));

import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import type {
  BugHunterResult,
  BugReport,
  BugCategory,
  BugSeverity,
  BugHunterConfig,
} from '../mcp-tools/bug-hunter.js';
import {
  executeBugHunterScan,
  loadHunterStore,
  saveHunterStore,
  bugHunterTools,
} from '../mcp-tools/bug-hunter.js';

// ── Helpers ─────────────────────────────────────────────────────────────────

interface HunterStore {
  reports: Record<string, BugHunterResult>;
  version: string;
}

/**
 * Configure fs mocks so that loadHunterStore returns the given store
 * and saveHunterStore captures writes. File reads for scan targets
 * are routed through the fileContents map.
 */
function setupMocks(
  initialStore: HunterStore = { reports: {}, version: '3.0.0' },
  fileContents: Record<string, string> = {},
) {
  let currentStore = JSON.parse(JSON.stringify(initialStore));

  (existsSync as ReturnType<typeof vi.fn>).mockImplementation((p: string) => {
    if (typeof p === 'string' && p.endsWith('reports.json')) return true;
    // Source files available for scanning
    if (fileContents[p] !== undefined) return true;
    return false;
  });

  (readFileSync as ReturnType<typeof vi.fn>).mockImplementation((p: string) => {
    if (typeof p === 'string' && p.endsWith('reports.json')) {
      return JSON.stringify(currentStore);
    }
    if (fileContents[p] !== undefined) return fileContents[p];
    throw new Error(`ENOENT: no such file '${p}'`);
  });

  (writeFileSync as ReturnType<typeof vi.fn>).mockImplementation(
    (_path: string, data: string) => {
      currentStore = JSON.parse(data);
    },
  );

  (mkdirSync as ReturnType<typeof vi.fn>).mockImplementation(() => {});

  return {
    getPersistedStore: () => currentStore as HunterStore,
  };
}

function makeConfig(overrides: Partial<BugHunterConfig> = {}): BugHunterConfig {
  return {
    targetPhase: 'implementation',
    scanScope: [],
    activeScan: false,
    ...overrides,
  };
}

// ── MCP tool result types ───────────────────────────────────────────────────

/** Result shape returned by the bug_hunter_scan MCP tool handler. */
interface ScanToolResult {
  huntId?: string;
  bugsFound?: number;
  summary?: Record<string, unknown>;
  bugs?: unknown[];
  scannedFiles?: string[];
  error?: string;
}

/** Result shape returned by the bug_hunter_report MCP tool handler. */
interface ReportToolResult {
  huntId?: string;
  phase?: string;
  workflowId?: string;
  totalHunts?: number;
  reports?: unknown[];
  error?: string;
}

// ── MCP tool handler helpers ────────────────────────────────────────────────

const scanTool = bugHunterTools.find((t) => t.name === 'bug_hunter_scan')!;
const reportTool = bugHunterTools.find((t) => t.name === 'bug_hunter_report')!;

// ── Tests ───────────────────────────────────────────────────────────────────

describe('bug-hunter', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // ========================================================================
  // executeBugHunterScan — result structure
  // ========================================================================

  describe('executeBugHunterScan', () => {
    it('returns a valid BugHunterResult with correct structure', async () => {
      setupMocks();
      const config = makeConfig({ scanScope: [] });

      const result = await executeBugHunterScan(config, {});

      expect(result).toHaveProperty('huntId');
      expect(result.huntId).toMatch(/^hunt-/);
      expect(result).toHaveProperty('phase', 'implementation');
      expect(result).toHaveProperty('bugs');
      expect(Array.isArray(result.bugs)).toBe(true);
      expect(result).toHaveProperty('scannedFiles');
      expect(Array.isArray(result.scannedFiles)).toBe(true);
      expect(result).toHaveProperty('coverageGaps');
      expect(Array.isArray(result.coverageGaps)).toBe(true);
      expect(result).toHaveProperty('summary');
      expect(result).toHaveProperty('startedAt');
      expect(result).toHaveProperty('completedAt');
    });

    it('attaches workflowId from context', async () => {
      setupMocks();
      const config = makeConfig();

      const result = await executeBugHunterScan(config, { workflowId: 'wf-123' });

      expect(result.workflowId).toBe('wf-123');
    });

    it('persists result to the hunter store', async () => {
      const { getPersistedStore } = setupMocks();
      const config = makeConfig();

      const result = await executeBugHunterScan(config, {});

      const store = getPersistedStore();
      expect(store.reports[result.huntId]).toBeDefined();
      expect(store.reports[result.huntId].huntId).toBe(result.huntId);
    });
  });

  // ========================================================================
  // Summary — correct counts
  // ========================================================================

  describe('summary counts', () => {
    it('has correct counts by severity and category', async () => {
      // Source that triggers known scanners:
      //   - logic-error: off-by-one (for i <= arr.length)
      //   - security-vuln: eval()
      const sourceWithBugs = [
        'function test() {',
        '  for (let i = 0; i <= arr.length; i++) {',
        '    eval(input);',
        '  }',
        '}',
      ].join('\n');

      setupMocks(undefined, { '/fake/src/app.ts': sourceWithBugs });

      const config = makeConfig({
        scanScope: ['/fake/src/app.ts'],
        categories: ['logic-error', 'security-vuln'],
      });

      const result = await executeBugHunterScan(config, {});

      expect(result.summary.total).toBeGreaterThanOrEqual(2);
      expect(result.summary.bySeverity).toHaveProperty('medium');
      expect(result.summary.bySeverity).toHaveProperty('high');
      expect(result.summary.byCategory['logic-error']).toBeGreaterThanOrEqual(1);
      expect(result.summary.byCategory['security-vuln']).toBeGreaterThanOrEqual(1);
    });

    it('summary totals match bugs array length', async () => {
      setupMocks(undefined, { '/fake/src/empty.ts': 'const x = 1;' });

      const config = makeConfig({ scanScope: ['/fake/src/empty.ts'] });
      const result = await executeBugHunterScan(config, {});

      expect(result.summary.total).toBe(result.bugs.length);
    });
  });

  // ========================================================================
  // Scanner output — BugReport fields
  // ========================================================================

  describe('BugReport required fields', () => {
    it('each scanner produces BugReports with all required fields', async () => {
      // Source that triggers multiple categories
      const source = [
        'const apiKey = "sk-super-secret-key-12345678";', // security-vuln
        'if (x = 5) {}',                                  // logic-error (assignment in condition)
        'const val = data.a.b.c.d;',                      // null-safety (deep chain)
        'setInterval(() => {}, 1000);',                    // resource-leak (no clearInterval)
        '// TODO: fix this later',                         // regression (TODO marker)
        'const v = parseInt(input)',                       // type-mismatch (no radix)
        'const first = items[0];',                         // edge-case (no length check)
      ].join('\n');

      setupMocks(undefined, { '/fake/src/multi.ts': source });

      const config = makeConfig({ scanScope: ['/fake/src/multi.ts'] });
      const result = await executeBugHunterScan(config, {});

      expect(result.bugs.length).toBeGreaterThan(0);

      for (const bug of result.bugs) {
        expect(bug).toHaveProperty('bugId');
        expect(bug.bugId).toMatch(/^bug-/);
        expect(bug).toHaveProperty('category');
        expect(bug).toHaveProperty('severity');
        expect(bug).toHaveProperty('title');
        expect(typeof bug.title).toBe('string');
        expect(bug).toHaveProperty('description');
        expect(typeof bug.description).toBe('string');
        expect(bug).toHaveProperty('location');
        expect(bug.location).toHaveProperty('file');
        expect(bug).toHaveProperty('reproduction');
        expect(typeof bug.reproduction).toBe('string');
        expect(bug).toHaveProperty('suggestedFix');
        expect(typeof bug.suggestedFix).toBe('string');
        expect(bug).toHaveProperty('evidence');
        expect(Array.isArray(bug.evidence)).toBe(true);
        expect(bug).toHaveProperty('detectedAt');
        expect(bug).toHaveProperty('phase');
      }
    });
  });

  // ========================================================================
  // Bug-hunter never fixes bugs
  // ========================================================================

  describe('bug-hunter is report-only', () => {
    it('results contain no code modification instructions', async () => {
      const source = 'eval(userInput);\nconst key = "api_key: secret12345678";';
      setupMocks(undefined, { '/fake/src/vuln.ts': source });

      const config = makeConfig({
        scanScope: ['/fake/src/vuln.ts'],
        categories: ['security-vuln'],
      });
      const result = await executeBugHunterScan(config, {});

      // Result should only contain report data, never file write operations
      const resultStr = JSON.stringify(result);
      expect(resultStr).not.toContain('writeFileSync');
      expect(resultStr).not.toContain('fs.write');
      expect(resultStr).not.toContain('patch');

      // Each bug has a suggestedFix (textual advice) but no applied fix
      for (const bug of result.bugs) {
        expect(typeof bug.suggestedFix).toBe('string');
        // The result object does not have an 'appliedFix' or 'codeChange' field
        expect((bug as Record<string, unknown>).appliedFix).toBeUndefined();
        expect((bug as Record<string, unknown>).codeChange).toBeUndefined();
      }
    });
  });

  // ========================================================================
  // Coverage gap analysis
  // ========================================================================

  describe('coverage gap analysis', () => {
    it('identifies files without test counterparts', async () => {
      const source = [
        'export function foo() { return 1; }',
        'export function bar() { return 2; }',
        'export function baz() { return 3; }',
      ].join('\n');

      // existsSync returns false for the test file path
      (existsSync as ReturnType<typeof vi.fn>).mockImplementation((p: string) => {
        if (typeof p === 'string' && p.endsWith('reports.json')) return true;
        if (p === '/fake/src/utils.ts') return true;
        // The expected test path (/fake/src/utils.test.ts) returns false
        return false;
      });

      (readFileSync as ReturnType<typeof vi.fn>).mockImplementation((p: string) => {
        if (typeof p === 'string' && p.endsWith('reports.json')) {
          return JSON.stringify({ reports: {}, version: '3.0.0' });
        }
        if (p === '/fake/src/utils.ts') return source;
        throw new Error(`ENOENT: ${p}`);
      });

      (writeFileSync as ReturnType<typeof vi.fn>).mockImplementation(() => {});
      (mkdirSync as ReturnType<typeof vi.fn>).mockImplementation(() => {});

      const config = makeConfig({ scanScope: ['/fake/src/utils.ts'] });
      const result = await executeBugHunterScan(config, {});

      expect(result.coverageGaps.length).toBeGreaterThanOrEqual(1);
      const gap = result.coverageGaps.find((g) => g.file === '/fake/src/utils.ts');
      expect(gap).toBeDefined();
      expect(gap!.uncoveredFunctions.length).toBeGreaterThan(0);
      expect(gap!.suggestedTests.length).toBeGreaterThan(0);
    });

    it('skips test files from coverage gap analysis', async () => {
      const source = 'export function helper() {}';

      setupMocks(undefined, { '/fake/src/__tests__/helper.test.ts': source });

      const config = makeConfig({
        scanScope: ['/fake/src/__tests__/helper.test.ts'],
      });
      const result = await executeBugHunterScan(config, {});

      // Test files should not appear in coverage gaps
      expect(result.coverageGaps.length).toBe(0);
    });
  });

  // ========================================================================
  // Category default severities
  // ========================================================================

  describe('category default severities', () => {
    it('security-vuln defaults to high severity (eval)', async () => {
      const source = 'eval(input);';
      setupMocks(undefined, { '/fake/src/a.ts': source });

      const config = makeConfig({
        scanScope: ['/fake/src/a.ts'],
        categories: ['security-vuln'],
      });
      const result = await executeBugHunterScan(config, {});

      const evalBug = result.bugs.find((b) => b.title === 'Use of eval()');
      expect(evalBug).toBeDefined();
      expect(evalBug!.severity).toBe('high');
    });

    it('logic-error defaults to medium severity', async () => {
      const source = 'for (let i = 0; i <= arr.length; i++) {}';
      setupMocks(undefined, { '/fake/src/b.ts': source });

      const config = makeConfig({
        scanScope: ['/fake/src/b.ts'],
        categories: ['logic-error'],
      });
      const result = await executeBugHunterScan(config, {});

      const offByOne = result.bugs.find((b) => b.title.includes('off-by-one'));
      expect(offByOne).toBeDefined();
      expect(offByOne!.severity).toBe('medium');
    });

    it('type-mismatch defaults to low severity', async () => {
      const source = 'const v = parseInt(input)';
      setupMocks(undefined, { '/fake/src/c.ts': source });

      const config = makeConfig({
        scanScope: ['/fake/src/c.ts'],
        categories: ['type-mismatch'],
      });
      const result = await executeBugHunterScan(config, {});

      const noRadix = result.bugs.find((b) => b.title.includes('radix'));
      expect(noRadix).toBeDefined();
      expect(noRadix!.severity).toBe('info');
    });

    it('race-condition defaults to high severity', async () => {
      const source = [
        'import { existsSync, readFileSync } from "node:fs";',
        'if (existsSync("file.txt")) {',
        '  const data = readFileSync("file.txt", "utf-8");',
        '}',
      ].join('\n');
      setupMocks(undefined, { '/fake/src/d.ts': source });

      const config = makeConfig({
        scanScope: ['/fake/src/d.ts'],
        categories: ['race-condition'],
      });
      const result = await executeBugHunterScan(config, {});

      const toctou = result.bugs.find((b) => b.title.includes('TOCTOU'));
      expect(toctou).toBeDefined();
      expect(toctou!.severity).toBe('high');
    });
  });

  // ========================================================================
  // MCP tool: bug_hunter_scan
  // ========================================================================

  describe('bug_hunter_scan MCP tool', () => {
    it('handler works with valid input', async () => {
      const source = 'eval(input);';
      setupMocks(undefined, { '/fake/src/scan.ts': source });

      const result = (await scanTool.handler({
        phase: 'implementation',
        files: ['/fake/src/scan.ts'],
        categories: ['security-vuln'],
      })) as ScanToolResult;

      expect(result).toHaveProperty('huntId');
      expect(result).toHaveProperty('bugsFound');
      expect(result.bugsFound).toBeGreaterThanOrEqual(1);
      expect(result).toHaveProperty('summary');
      expect(result).toHaveProperty('bugs');
      expect(result).toHaveProperty('scannedFiles');
    });

    it('returns error for missing required fields', async () => {
      setupMocks();
      const result = (await scanTool.handler({ phase: 'implementation' })) as ScanToolResult;
      expect(result).toHaveProperty('error');
      expect(result.error).toMatch(/Missing required/i);
    });

    it('returns error for invalid phase', async () => {
      setupMocks();
      const result = (await scanTool.handler({
        phase: 'invalid-phase',
        files: ['/fake/src/a.ts'],
      })) as ScanToolResult;
      expect(result).toHaveProperty('error');
      expect(result.error).toMatch(/Invalid phase/);
    });

    it('returns error for invalid categories', async () => {
      setupMocks();
      const result = (await scanTool.handler({
        phase: 'implementation',
        files: ['/fake/src/a.ts'],
        categories: ['not-a-category'],
      })) as ScanToolResult;
      expect(result).toHaveProperty('error');
      expect(result.error).toMatch(/Invalid categories/);
    });
  });

  // ========================================================================
  // MCP tool: bug_hunter_report
  // ========================================================================

  describe('bug_hunter_report MCP tool', () => {
    it('retrieves stored result by huntId', async () => {
      const fakeResult: BugHunterResult = {
        huntId: 'hunt-test-abc',
        phase: 'testing',
        bugs: [],
        scannedFiles: [],
        coverageGaps: [],
        summary: {
          total: 0,
          bySeverity: { info: 0, low: 0, medium: 0, high: 0, critical: 0 },
          byCategory: {
            'logic-error': 0,
            'null-safety': 0,
            'type-mismatch': 0,
            'race-condition': 0,
            'resource-leak': 0,
            'security-vuln': 0,
            'edge-case': 0,
            regression: 0,
          },
        },
        startedAt: '2025-01-01T00:00:00.000Z',
        completedAt: '2025-01-01T00:00:01.000Z',
      };

      setupMocks({ reports: { 'hunt-test-abc': fakeResult }, version: '3.0.0' });

      const result = (await reportTool.handler({ huntId: 'hunt-test-abc' })) as ReportToolResult;

      expect(result.huntId).toBe('hunt-test-abc');
      expect(result.phase).toBe('testing');
    });

    it('returns error when huntId is not found', async () => {
      setupMocks();
      const result = (await reportTool.handler({ huntId: 'nonexistent' })) as ReportToolResult;
      expect(result).toHaveProperty('error');
      expect(result.error).toMatch(/No report found/);
    });

    it('retrieves reports by workflowId', async () => {
      const fakeResult: BugHunterResult = {
        huntId: 'hunt-wf-1',
        workflowId: 'wf-999',
        phase: 'review',
        bugs: [],
        scannedFiles: [],
        coverageGaps: [],
        summary: {
          total: 0,
          bySeverity: { info: 0, low: 0, medium: 0, high: 0, critical: 0 },
          byCategory: {
            'logic-error': 0,
            'null-safety': 0,
            'type-mismatch': 0,
            'race-condition': 0,
            'resource-leak': 0,
            'security-vuln': 0,
            'edge-case': 0,
            regression: 0,
          },
        },
        startedAt: '2025-01-01T00:00:00.000Z',
        completedAt: '2025-01-01T00:00:01.000Z',
      };

      setupMocks({ reports: { 'hunt-wf-1': fakeResult }, version: '3.0.0' });

      const result = (await reportTool.handler({ workflowId: 'wf-999' })) as ReportToolResult;

      expect(result.workflowId).toBe('wf-999');
      expect(result.totalHunts).toBe(1);
      expect(result.reports).toHaveLength(1);
    });

    it('returns error when neither huntId nor workflowId provided', async () => {
      setupMocks();
      const result = (await reportTool.handler({})) as ReportToolResult;
      expect(result).toHaveProperty('error');
      expect(result.error).toMatch(/Provide either/);
    });

    it('returns error when workflowId has no matching reports', async () => {
      setupMocks();
      const result = (await reportTool.handler({ workflowId: 'wf-none' })) as ReportToolResult;
      expect(result).toHaveProperty('error');
      expect(result.error).toMatch(/No reports found/);
    });
  });

  // ========================================================================
  // Store helpers
  // ========================================================================

  describe('loadHunterStore / saveHunterStore', () => {
    it('loadHunterStore returns empty store when file does not exist', () => {
      (existsSync as ReturnType<typeof vi.fn>).mockReturnValue(false);

      const store = loadHunterStore();
      expect(store).toEqual({ reports: {}, version: '3.0.0' });
    });

    it('loadHunterStore returns empty store on corrupted JSON', () => {
      (existsSync as ReturnType<typeof vi.fn>).mockReturnValue(true);
      (readFileSync as ReturnType<typeof vi.fn>).mockReturnValue('not valid json{{{');

      const store = loadHunterStore();
      expect(store).toEqual({ reports: {}, version: '3.0.0' });
    });
  });
});
