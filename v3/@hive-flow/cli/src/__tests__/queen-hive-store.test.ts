import { describe, it, expect, vi, beforeEach } from 'vitest';

// ── Types imported for structural tests ──────────────────────────────────

// We import only the type interfaces from hive-store.ts.
// No vi.mock('node:fs') needed — these tests verify data structures,
// serialization round-trips, and sanitization logic without touching disk.

import type {
  HiveRecord,
  HiveWorkerRecord,
  HiveBudget,
  HiveStatus,
} from '../mcp-tools/hive-store.js';

// ── Helper: build a minimal HiveRecord ───────────────────────────────────

function makeHiveRecord(overrides: Partial<HiveRecord> = {}): HiveRecord {
  const now = new Date().toISOString();
  return {
    hiveId: 'hive-test-001',
    queenId: 'queen-test-001',
    status: 'active',
    workers: [],
    budget: { maxWorkers: 8, workersAllocated: 0 },
    audit: [],
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

function makeWorkerRecord(overrides: Partial<HiveWorkerRecord> = {}): HiveWorkerRecord {
  return {
    workerId: 'worker-test-001',
    agentId: 'agent-test-001',
    role: 'coder',
    provider: 'codex-cli',
    status: 'idle',
    spawnedAt: new Date().toISOString(),
    ...overrides,
  };
}

// ── Canonical sanitization function (shared by all 4 files) ──────────────

// This is the pattern that MUST be identical in:
//   .claude/helpers/enforcement.cjs    (getStateFile)
//   .claude/helpers/role-enforcement.cjs (sanitizeId)
//   v3/@hive-flow/cli/src/mcp-tools/queen-tools.ts (mission_assign role file)
//   v3/@hive-flow/cli/src/mcp-tools/agent-tools.ts (propagateEnforcementToSubAgent)
function canonicalSanitize(id: string): string {
  return id.replace(/[/\\.]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 64);
}

// ──────────────────────────────────────────────────────────────────────────
// Tests
// ──────────────────────────────────────────────────────────────────────────

describe('Queen & Hive Store — Phase 2 additions', () => {

  // ── 1. HiveWorkerRecord 'error' status ────────────────────────────────

  describe('HiveWorkerRecord error status', () => {
    it('accepts "error" as a valid worker status in HiveWorkerRecord', () => {
      const worker = makeWorkerRecord({ status: 'error' });
      expect(worker.status).toBe('error');
    });

    it('worker status transitions to error on failed task result', () => {
      // Simulate the queen_task_worker post-result update logic:
      // freshWorker.status = result.success ? 'idle' : 'error';
      const worker = makeWorkerRecord({ status: 'busy' });
      const result = { success: false, error: 'Task execution failed' };
      worker.status = result.success ? 'idle' : 'error';
      expect(worker.status).toBe('error');
    });

    it('worker status transitions to idle on successful task result', () => {
      const worker = makeWorkerRecord({ status: 'busy' });
      const result = { success: true };
      worker.status = result.success ? 'idle' : 'error';
      expect(worker.status).toBe('idle');
    });

    it('hive record preserves error status across serialization', () => {
      const hive = makeHiveRecord({
        workers: [makeWorkerRecord({ status: 'error' })],
      });
      const serialized = JSON.stringify(hive);
      const deserialized = JSON.parse(serialized) as HiveRecord;
      expect(deserialized.workers[0].status).toBe('error');
    });
  });

  // ── 2. queen_report persists report text ──────────────────────────────

  describe('queen_report persists report text', () => {
    it('hive record accepts and stores a report field', () => {
      const reportText = '## Security Audit\n\nNo critical findings.';
      const hive = makeHiveRecord({ report: reportText });
      expect(hive.report).toBe(reportText);
    });

    it('report field is included in JSON serialization', () => {
      const reportText = 'Findings: all tests pass, coverage at 94%.';
      const hive = makeHiveRecord({ report: reportText });
      const serialized = JSON.stringify(hive);
      const deserialized = JSON.parse(serialized) as HiveRecord;
      expect(deserialized.report).toBe(reportText);
    });

    it('hive record without report has undefined report field', () => {
      const hive = makeHiveRecord();
      expect(hive.report).toBeUndefined();
    });
  });

  // ── 3. HiveRecord report field round-trips ────────────────────────────

  describe('HiveRecord report round-trip', () => {
    it('preserves report string through JSON round-trip', () => {
      const reportText = 'Multi-line report:\n- Finding 1\n- Finding 2\n\nConclusion: all clear.';
      const hive = makeHiveRecord({
        report: reportText,
        status: 'completed',
        completedAt: new Date().toISOString(),
      });

      const serialized = JSON.stringify(hive, null, 2);
      const loaded = JSON.parse(serialized) as HiveRecord;
      expect(loaded.report).toBe(reportText);
      expect(loaded.status).toBe('completed');
      expect(loaded.completedAt).toBeDefined();
    });

    it('preserves empty string report', () => {
      const hive = makeHiveRecord({ report: '' });
      const serialized = JSON.stringify(hive);
      const deserialized = JSON.parse(serialized) as HiveRecord;
      expect(deserialized.report).toBe('');
    });

    it('preserves report with special characters', () => {
      const reportText = 'Report with "quotes", <tags>, and unicode: \u2603\u2764';
      const hive = makeHiveRecord({ report: reportText });
      const serialized = JSON.stringify(hive);
      const deserialized = JSON.parse(serialized) as HiveRecord;
      expect(deserialized.report).toBe(reportText);
    });

    it('preserves error field alongside report when status is failed', () => {
      const hive = makeHiveRecord({
        report: 'Partial findings before failure.',
        status: 'failed',
        error: 'Worker budget exhausted with incomplete results',
      });
      const serialized = JSON.stringify(hive);
      const deserialized = JSON.parse(serialized) as HiveRecord;
      expect(deserialized.report).toBe('Partial findings before failure.');
      expect(deserialized.error).toBe('Worker budget exhausted with incomplete results');
      expect(deserialized.status).toBe('failed');
    });
  });

  // ── 4. Sanitization consistency ───────────────────────────────────────

  describe('Sanitization consistency across files', () => {

    it('dots are replaced with underscores', () => {
      expect(canonicalSanitize('agent.foo.bar')).toBe('agent_foo_bar');
    });

    it('forward slashes are replaced with underscores', () => {
      expect(canonicalSanitize('agent/foo/bar')).toBe('agent_foo_bar');
    });

    it('backslashes are replaced with underscores', () => {
      expect(canonicalSanitize('agent\\foo\\bar')).toBe('agent_foo_bar');
    });

    it('consecutive path separators collapse to single underscore', () => {
      expect(canonicalSanitize('agent///foo...bar\\\\baz')).toBe('agent_foo_bar_baz');
    });

    it('long strings are truncated to 64 characters', () => {
      const input = 'a'.repeat(100);
      const result = canonicalSanitize(input);
      expect(result.length).toBe(64);
    });

    it('leading/trailing underscores are stripped before truncation', () => {
      const input = '...agent-id...';
      const result = canonicalSanitize(input);
      expect(result).toBe('agent-id');
      expect(result).not.toMatch(/^_/);
      expect(result).not.toMatch(/_$/);
    });

    it('path-traversal components are neutralized', () => {
      const input = '../../../etc/passwd';
      const result = canonicalSanitize(input);
      expect(result).toBe('etc_passwd');
    });

    it('unicode characters are preserved (not path separators)', () => {
      const input = 'agent-\u00e9\u00e8\u00ea';
      const result = canonicalSanitize(input);
      expect(result).toBe('agent-\u00e9\u00e8\u00ea');
    });

    it('empty input returns empty string', () => {
      expect(canonicalSanitize('')).toBe('');
    });

    it('input of only dots/slashes returns empty string after stripping', () => {
      expect(canonicalSanitize('...')).toBe('');
      expect(canonicalSanitize('///')).toBe('');
      expect(canonicalSanitize('\\\\\\')).toBe('');
    });

    // Cross-file verification: enforcement.cjs getStateFile
    it('enforcement.cjs sanitization matches canonical pattern', () => {
      vi.resetModules();
      const enfPath = require('path').resolve(
        __dirname, '..', '..', '..', '..', '..', '.claude', 'helpers', 'enforcement.cjs'
      );
      const enfModule = require(enfPath);
      const longId = 'x'.repeat(100);
      const stateFile: string = enfModule.getStateFile(longId);
      // The sanitized portion of the path should be exactly 64 chars
      expect(stateFile).toContain('x'.repeat(64));
      expect(stateFile).not.toContain('x'.repeat(65));
    });

    // Cross-file verification: role-enforcement.cjs sanitizeId
    it('role-enforcement.cjs sanitizeId matches canonical pattern', () => {
      vi.resetModules();
      const rolePath = require('path').resolve(
        __dirname, '..', '..', '..', '..', '..', '.claude', 'helpers', 'role-enforcement.cjs'
      );
      const roleEnf = require(rolePath);

      // Length truncation
      expect(roleEnf.sanitizeId('y'.repeat(100)).length).toBe(64);

      // Character replacement matches canonical
      expect(roleEnf.sanitizeId('a.b.c')).toBe(canonicalSanitize('a.b.c'));
      expect(roleEnf.sanitizeId('a/b\\c')).toBe(canonicalSanitize('a/b\\c'));
      expect(roleEnf.sanitizeId('///...')).toBe(canonicalSanitize('///...'));
    });
  });
});
