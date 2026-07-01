// v3/@hive-flow/cli/src/integrations/__tests__/diagnose.test.ts
//
// Tests for the connector diagnose engine.
//
// We mock the integration-marker module because it is being authored in
// parallel by another agent in the same wave. Mocking the read API lets these
// tests exercise the diagnose logic without needing the marker module's
// disk layout finalised. The mock surface is intentionally small: the
// well-defined readMarker / markerPath / ADAPTER_TARGETS contract from the
// wave-spec.

import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// ---------------------------------------------------------------------------
// Mock the parallel-agent module. Vitest hoists vi.mock above the imports
// so the test code below sees the mocked version of './integration-marker'.
// We use a mutable map so each test sets the markers it wants returned for
// (target, scope) pairs.
// ---------------------------------------------------------------------------

type MockScope = 'project' | 'user';
type MarkerKey = `${string}::${MockScope}`;

interface MockMarker {
  version: 1;
  target: string;
  tier: 'wrapper-mode' | 'native-plugin';
  scope: MockScope;
  installedAt: string;
  scriptPath?: string;
  realCliBin?: string;
}

// Module-level mock state. vi.mock factories cannot close over outer
// non-hoisted variables, so we attach state to globalThis and reference it
// from within the factory via the same global.
type DiagnoseMockGlobal = typeof globalThis & {
  __HF_DIAGNOSE_MARKERS__?: Map<MarkerKey, MockMarker>;
};
const mockGlobal = globalThis as DiagnoseMockGlobal;
mockGlobal.__HF_DIAGNOSE_MARKERS__ = new Map<MarkerKey, MockMarker>();

vi.mock('../integration-marker.js', () => {
  const TARGETS = [
    'claude-code',
    'codex',
    'gemini',
    'forgecode',
    'cursor-cli',
    'qwen',
    'opencode',
  ] as const;

  return {
    ADAPTER_TARGETS: TARGETS,
    readMarker: async (opts: {
      projectRoot: string;
      target: string;
      scope: MockScope;
    }) => {
      const g = globalThis as DiagnoseMockGlobal;
      const store = g.__HF_DIAGNOSE_MARKERS__;
      if (store === undefined) return undefined;
      return store.get(`${opts.target}::${opts.scope}`);
    },
    markerPath: (opts: {
      projectRoot: string;
      target: string;
      scope: MockScope;
    }) =>
      join(
        opts.projectRoot,
        '.hive-flow',
        'integrations',
        opts.scope,
        `${opts.target}.json`,
      ),
  };
});

import { diagnoseConnectors } from '../diagnose.js';

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

const ALL_TARGETS = [
  'claude-code',
  'codex',
  'gemini',
  'forgecode',
  'cursor-cli',
  'qwen',
  'opencode',
];

function setMarker(target: string, scope: MockScope, marker: MockMarker): void {
  const store = mockGlobal.__HF_DIAGNOSE_MARKERS__;
  if (store === undefined) throw new Error('mock store not initialised');
  store.set(`${target}::${scope}`, marker);
}

function clearMarkers(): void {
  mockGlobal.__HF_DIAGNOSE_MARKERS__?.clear();
}

let tmpRoot: string;

beforeEach(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), 'hf-diagnose-'));
  clearMarkers();
});

afterEach(() => {
  rmSync(tmpRoot, { recursive: true, force: true });
  clearMarkers();
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('diagnoseConnectors — empty state', () => {
  it('reports all 7 targets as not installed when no markers exist', async () => {
    const report = await diagnoseConnectors({ projectRoot: tmpRoot });

    expect(report.entries).toHaveLength(7);
    for (const entry of report.entries) {
      expect(entry.installed).toBe(false);
      expect(entry.scope).toBeUndefined();
      expect(entry.tier).toBeUndefined();
      expect(entry.issues).toEqual([]);
    }
    expect(report.summary.installed).toBe(0);
    expect(report.summary.healthy).toBe(0);
    expect(report.summary.withIssues).toBe(0);
  });

  it('covers every adapter target exactly once', async () => {
    const report = await diagnoseConnectors({ projectRoot: tmpRoot });
    const seen = report.entries.map((e) => e.target).sort();
    expect(seen).toEqual([...ALL_TARGETS].sort());
  });
});

describe('diagnoseConnectors — scope selection', () => {
  it('records a single project-scope marker as installed at project scope', async () => {
    const scriptPath = join(tmpRoot, 'wrapper-codex.sh');
    const realCli = join(tmpRoot, 'real-codex');
    writeFileSync(scriptPath, '#!/usr/bin/env bash\nexit 0\n');
    chmodSync(scriptPath, 0o755);
    writeFileSync(realCli, '#!/usr/bin/env bash\nexit 0\n');
    chmodSync(realCli, 0o755);

    setMarker('codex', 'project', {
      version: 1,
      target: 'codex',
      tier: 'wrapper-mode',
      scope: 'project',
      installedAt: new Date().toISOString(),
      scriptPath,
      realCliBin: realCli,
    });

    const report = await diagnoseConnectors({ projectRoot: tmpRoot });

    const codex = report.entries.find((e) => e.target === 'codex');
    expect(codex).toBeDefined();
    expect(codex?.installed).toBe(true);
    expect(codex?.scope).toBe('project');
    expect(codex?.tier).toBe('wrapper-mode');
    expect(codex?.scriptExists).toBe(true);
    expect(codex?.realCliExists).toBe(true);
    expect(codex?.issues).toEqual([]);

    // Other targets remain uninstalled.
    for (const entry of report.entries) {
      if (entry.target === 'codex') continue;
      expect(entry.installed).toBe(false);
    }

    expect(report.summary.installed).toBe(1);
    expect(report.summary.healthy).toBe(1);
    expect(report.summary.withIssues).toBe(0);
  });

  it('records a single user-scope marker as installed at user scope', async () => {
    const scriptPath = join(tmpRoot, 'wrapper-gemini.sh');
    const realCli = join(tmpRoot, 'real-gemini');
    writeFileSync(scriptPath, '#!/usr/bin/env bash\nexit 0\n');
    chmodSync(scriptPath, 0o755);
    writeFileSync(realCli, '#!/usr/bin/env bash\nexit 0\n');
    chmodSync(realCli, 0o755);

    setMarker('gemini', 'user', {
      version: 1,
      target: 'gemini',
      tier: 'wrapper-mode',
      scope: 'user',
      installedAt: new Date().toISOString(),
      scriptPath,
      realCliBin: realCli,
    });

    const report = await diagnoseConnectors({ projectRoot: tmpRoot });
    const gemini = report.entries.find((e) => e.target === 'gemini');
    expect(gemini?.installed).toBe(true);
    expect(gemini?.scope).toBe('user');
    expect(gemini?.issues).toEqual([]);
  });

  it('prefers project scope when both project and user markers exist', async () => {
    const projectScript = join(tmpRoot, 'project-wrapper');
    const userScript = join(tmpRoot, 'user-wrapper');
    writeFileSync(projectScript, '#!/usr/bin/env bash\nexit 0\n');
    chmodSync(projectScript, 0o755);
    writeFileSync(userScript, '#!/usr/bin/env bash\nexit 0\n');
    chmodSync(userScript, 0o755);

    setMarker('cursor-cli', 'project', {
      version: 1,
      target: 'cursor-cli',
      tier: 'wrapper-mode',
      scope: 'project',
      installedAt: '2026-05-22T00:00:00.000Z',
      scriptPath: projectScript,
    });
    setMarker('cursor-cli', 'user', {
      version: 1,
      target: 'cursor-cli',
      tier: 'wrapper-mode',
      scope: 'user',
      installedAt: '2026-05-21T00:00:00.000Z',
      scriptPath: userScript,
    });

    const report = await diagnoseConnectors({ projectRoot: tmpRoot });
    const cursor = report.entries.find((e) => e.target === 'cursor-cli');
    expect(cursor?.installed).toBe(true);
    expect(cursor?.scope).toBe('project');
    // The scriptPath from the project marker should be reported.
    expect(cursor?.scriptPath).toBe(projectScript);
  });
});

describe('diagnoseConnectors — wrapper-mode health checks', () => {
  it('reports "wrapper script missing" when scriptPath does not exist', async () => {
    const missingScript = join(tmpRoot, 'does-not-exist.sh');
    const realCli = join(tmpRoot, 'real-forge');
    writeFileSync(realCli, '#!/usr/bin/env bash\nexit 0\n');
    chmodSync(realCli, 0o755);

    setMarker('forgecode', 'project', {
      version: 1,
      target: 'forgecode',
      tier: 'wrapper-mode',
      scope: 'project',
      installedAt: new Date().toISOString(),
      scriptPath: missingScript,
      realCliBin: realCli,
    });

    const report = await diagnoseConnectors({ projectRoot: tmpRoot });
    const forge = report.entries.find((e) => e.target === 'forgecode');
    expect(forge?.installed).toBe(true);
    expect(forge?.scriptExists).toBe(false);
    expect(forge?.realCliExists).toBe(true);
    expect(forge?.issues).toContain('wrapper script missing');
    expect(forge?.issues).not.toContain('real CLI binary missing');

    expect(report.summary.installed).toBe(1);
    expect(report.summary.healthy).toBe(0);
    expect(report.summary.withIssues).toBe(1);
  });

  it('reports "real CLI binary missing" when realCliBin does not exist', async () => {
    const scriptPath = join(tmpRoot, 'wrapper-qwen.sh');
    const missingReal = join(tmpRoot, 'no-real-qwen');
    writeFileSync(scriptPath, '#!/usr/bin/env bash\nexit 0\n');
    chmodSync(scriptPath, 0o755);

    setMarker('qwen', 'project', {
      version: 1,
      target: 'qwen',
      tier: 'wrapper-mode',
      scope: 'project',
      installedAt: new Date().toISOString(),
      scriptPath,
      realCliBin: missingReal,
    });

    const report = await diagnoseConnectors({ projectRoot: tmpRoot });
    const qwen = report.entries.find((e) => e.target === 'qwen');
    expect(qwen?.scriptExists).toBe(true);
    expect(qwen?.realCliExists).toBe(false);
    expect(qwen?.issues).toContain('real CLI binary missing');
    expect(qwen?.issues).not.toContain('wrapper script missing');
  });

  it('reports both issues when scriptPath and realCliBin are both missing', async () => {
    setMarker('opencode', 'user', {
      version: 1,
      target: 'opencode',
      tier: 'wrapper-mode',
      scope: 'user',
      installedAt: new Date().toISOString(),
      scriptPath: join(tmpRoot, 'never-existed-wrapper'),
      realCliBin: join(tmpRoot, 'never-existed-real'),
    });

    const report = await diagnoseConnectors({ projectRoot: tmpRoot });
    const open = report.entries.find((e) => e.target === 'opencode');
    expect(open?.issues).toEqual(
      expect.arrayContaining(['wrapper script missing', 'real CLI binary missing']),
    );
    expect(open?.issues).toHaveLength(2);
  });

  it('reports no issues when realCliBin is omitted from the marker', async () => {
    const scriptPath = join(tmpRoot, 'wrapper-only.sh');
    writeFileSync(scriptPath, '#!/usr/bin/env bash\nexit 0\n');
    chmodSync(scriptPath, 0o755);

    setMarker('claude-code', 'project', {
      version: 1,
      target: 'claude-code',
      tier: 'wrapper-mode',
      scope: 'project',
      installedAt: new Date().toISOString(),
      scriptPath,
    });

    const report = await diagnoseConnectors({ projectRoot: tmpRoot });
    const claude = report.entries.find((e) => e.target === 'claude-code');
    expect(claude?.installed).toBe(true);
    expect(claude?.scriptExists).toBe(true);
    expect(claude?.realCliBin).toBeUndefined();
    expect(claude?.realCliExists).toBeUndefined();
    expect(claude?.issues).toEqual([]);
  });

  it('uses lstat — a symlink at scriptPath registers as existing even if its target is gone', async () => {
    // Defense-in-depth: lstat does not follow symlinks. A wrapper that has
    // been replaced with a dangling symlink should still register the path
    // as present, because the on-disk entry exists — though clearly it
    // would break at runtime. This test mainly proves we are NOT silently
    // following links to elsewhere on the filesystem.
    const wrapperLink = join(tmpRoot, 'wrapper-link');
    const targetThatExists = join(tmpRoot, 'wrapper-real');
    writeFileSync(targetThatExists, '#!/usr/bin/env bash\nexit 0\n');
    chmodSync(targetThatExists, 0o755);
    symlinkSync(targetThatExists, wrapperLink);

    setMarker('codex', 'project', {
      version: 1,
      target: 'codex',
      tier: 'wrapper-mode',
      scope: 'project',
      installedAt: new Date().toISOString(),
      scriptPath: wrapperLink,
    });

    const report = await diagnoseConnectors({ projectRoot: tmpRoot });
    const codex = report.entries.find((e) => e.target === 'codex');
    // lstat sees the symlink itself — present.
    expect(codex?.scriptExists).toBe(true);
    expect(codex?.issues).toEqual([]);
  });

  it('uses lstat — dangling symlink at scriptPath still registers as present', async () => {
    const dangling = join(tmpRoot, 'dangling-link');
    const gone = join(tmpRoot, 'never-existed');
    // Create a symlink pointing at a nonexistent path. lstat must still see
    // the symlink itself; stat would have raised ENOENT and we would have
    // mis-reported the wrapper as missing.
    symlinkSync(gone, dangling);

    setMarker('codex', 'project', {
      version: 1,
      target: 'codex',
      tier: 'wrapper-mode',
      scope: 'project',
      installedAt: new Date().toISOString(),
      scriptPath: dangling,
    });

    const report = await diagnoseConnectors({ projectRoot: tmpRoot });
    const codex = report.entries.find((e) => e.target === 'codex');
    expect(codex?.scriptExists).toBe(true);
  });
});

describe('diagnoseConnectors — native-plugin tier', () => {
  it('records native-plugin markers as installed without deeper checks', async () => {
    setMarker('claude-code', 'project', {
      version: 1,
      target: 'claude-code',
      tier: 'native-plugin',
      scope: 'project',
      installedAt: new Date().toISOString(),
    });

    const report = await diagnoseConnectors({ projectRoot: tmpRoot });
    const claude = report.entries.find((e) => e.target === 'claude-code');
    expect(claude?.installed).toBe(true);
    expect(claude?.tier).toBe('native-plugin');
    expect(claude?.scope).toBe('project');
    // No scriptPath / realCliBin recorded → no existence fields.
    expect(claude?.scriptExists).toBeUndefined();
    expect(claude?.realCliExists).toBeUndefined();
    expect(claude?.issues).toEqual([]);
  });
});

describe('diagnoseConnectors — summary counts', () => {
  it('counts installed / healthy / withIssues correctly across mixed states', async () => {
    // Two healthy wrappers, one wrapper with a missing real CLI, one
    // not-installed, three more not-installed.
    const goodScript1 = join(tmpRoot, 'good-1');
    const goodScript2 = join(tmpRoot, 'good-2');
    const goodReal1 = join(tmpRoot, 'real-good-1');
    const goodScript3 = join(tmpRoot, 'good-3');
    writeFileSync(goodScript1, '#!/usr/bin/env bash\nexit 0\n');
    chmodSync(goodScript1, 0o755);
    writeFileSync(goodScript2, '#!/usr/bin/env bash\nexit 0\n');
    chmodSync(goodScript2, 0o755);
    writeFileSync(goodReal1, '#!/usr/bin/env bash\nexit 0\n');
    chmodSync(goodReal1, 0o755);
    writeFileSync(goodScript3, '#!/usr/bin/env bash\nexit 0\n');
    chmodSync(goodScript3, 0o755);

    setMarker('codex', 'project', {
      version: 1,
      target: 'codex',
      tier: 'wrapper-mode',
      scope: 'project',
      installedAt: new Date().toISOString(),
      scriptPath: goodScript1,
      realCliBin: goodReal1,
    });
    setMarker('gemini', 'user', {
      version: 1,
      target: 'gemini',
      tier: 'wrapper-mode',
      scope: 'user',
      installedAt: new Date().toISOString(),
      scriptPath: goodScript2,
    });
    setMarker('qwen', 'project', {
      version: 1,
      target: 'qwen',
      tier: 'wrapper-mode',
      scope: 'project',
      installedAt: new Date().toISOString(),
      scriptPath: goodScript3,
      realCliBin: join(tmpRoot, 'absent-real'),
    });

    const report = await diagnoseConnectors({ projectRoot: tmpRoot });
    expect(report.summary.installed).toBe(3);
    expect(report.summary.healthy).toBe(2);
    expect(report.summary.withIssues).toBe(1);

    // Spot-check the per-entry breakdown
    expect(report.entries.find((e) => e.target === 'codex')?.issues).toEqual([]);
    expect(report.entries.find((e) => e.target === 'gemini')?.issues).toEqual([]);
    expect(
      report.entries.find((e) => e.target === 'qwen')?.issues,
    ).toContain('real CLI binary missing');
  });
});

describe('diagnoseConnectors — malformed wrapper marker', () => {
  it('flags wrapper-mode marker that omits scriptPath as missing', async () => {
    // A wrapper-mode marker without a scriptPath is malformed. The
    // installer should never write one, but if it does (or a future migration
    // mangles the file), diagnose must surface it rather than silently pass.
    setMarker('codex', 'project', {
      version: 1,
      target: 'codex',
      tier: 'wrapper-mode',
      scope: 'project',
      installedAt: new Date().toISOString(),
    });

    const report = await diagnoseConnectors({ projectRoot: tmpRoot });
    const codex = report.entries.find((e) => e.target === 'codex');
    expect(codex?.installed).toBe(true);
    expect(codex?.issues).toContain('wrapper script missing');
  });
});

describe('diagnoseConnectors — directory entries', () => {
  it('treats a directory at scriptPath as present (lstat does not type-discriminate here)', async () => {
    // This documents current behavior: we only check that *something* lives
    // at the marker path. A directory is unusual but not strictly an error
    // for the diagnose pass — the wrapper installer is responsible for
    // rejecting that during apply. Adding type discrimination would change
    // the contract and risk reporting healthy connectors as broken if the
    // wrapper is a hard link or other non-regular entry.
    const dirAsScript = join(tmpRoot, 'wrapper-dir');
    mkdirSync(dirAsScript, { recursive: true });

    setMarker('codex', 'project', {
      version: 1,
      target: 'codex',
      tier: 'wrapper-mode',
      scope: 'project',
      installedAt: new Date().toISOString(),
      scriptPath: dirAsScript,
    });

    const report = await diagnoseConnectors({ projectRoot: tmpRoot });
    const codex = report.entries.find((e) => e.target === 'codex');
    expect(codex?.scriptExists).toBe(true);
    expect(codex?.issues).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Wave 11B.5: active-PATH diagnose gate
// ---------------------------------------------------------------------------

describe('diagnoseConnectors — active-PATH gate', () => {
  let tmpRoot: string;
  const origPath = process.env.PATH;

  beforeEach(() => {
    tmpRoot = mkdtempSync(join(tmpdir(), 'hf-diagnose-path-'));
    mockGlobal.__HF_DIAGNOSE_MARKERS__!.clear();
  });

  afterEach(() => {
    process.env.PATH = origPath;
    rmSync(tmpRoot, { recursive: true, force: true });
  });

  it('reports host command not resolvable when wrapper is under .hive-flow/bin/ but binary is not on PATH', async () => {
    const wrapperDir = join(tmpRoot, '.hive-flow', 'bin');
    mkdirSync(wrapperDir, { recursive: true });
    const wrapperScript = join(wrapperDir, 'qwen');
    writeFileSync(wrapperScript, '#!/bin/bash\n# AUTO-GENERATED by hive-flow wrapper-driver\nexit 0\n', { mode: 0o755 });

    const realBinDir = join(tmpRoot, 'real-bin');
    mkdirSync(realBinDir, { recursive: true });
    const realBin = join(realBinDir, 'qwen');
    writeFileSync(realBin, '#!/bin/bash\necho real\n', { mode: 0o755 });

    mockGlobal.__HF_DIAGNOSE_MARKERS__!.set('qwen::project', {
      version: 1,
      target: 'qwen',
      tier: 'wrapper-mode',
      scope: 'project',
      installedAt: new Date().toISOString(),
      scriptPath: wrapperScript,
      realCliBin: realBin,
    });

    // PATH excludes both wrapper dir and real binary dir
    process.env.PATH = '/usr/bin:/bin';

    const report = await diagnoseConnectors({ projectRoot: tmpRoot });
    const qwen = report.entries.find((e) => e.target === 'qwen');
    expect(qwen?.installed).toBe(true);
    expect(qwen?.issues).toContain(
      'wrapper installed but host command not resolvable on PATH — add wrapper directory to PATH',
    );
  });
});
