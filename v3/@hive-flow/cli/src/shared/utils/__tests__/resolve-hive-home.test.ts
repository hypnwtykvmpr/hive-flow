import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';

import {
  projectKeyFor,
  resolveHiveHome,
  resolveLegacyClaudeHiveHome,
  sessionKeyFor,
} from '../resolve-hive-home.js';

describe('resolveHiveHome', () => {
  let home: string;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'hf-shared-home-'));
  });

  afterEach(() => {
    rmSync(home, { recursive: true, force: true });
  });

  it('uses an absolute HIVE_FLOW_HOME override as the primary home', () => {
    const override = join(home, 'custom-hive-home');
    const resolved = resolveHiveHome({ HIVE_FLOW_HOME: override }, { homeDir: home });
    expect(resolved.home).toBe(resolve(override));
    expect(resolved.source).toBe('env');
    expect(resolved.legacyHome).toBe(join(home, '.claude', 'hive-flow'));
  });

  it('ignores a relative HIVE_FLOW_HOME override and defaults to ~/.hive-flow', () => {
    const resolved = resolveHiveHome({ HIVE_FLOW_HOME: 'relative-home' }, { homeDir: home });
    expect(resolved.home).toBe(join(home, '.hive-flow'));
    expect(resolved.source).toBe('default');
  });

  it('keeps ~/.claude/hive-flow as legacy read fallback metadata only', () => {
    const legacy = join(home, '.claude', 'hive-flow');
    mkdirSync(legacy, { recursive: true });
    const resolved = resolveHiveHome({}, { homeDir: home });
    expect(resolved.home).toBe(join(home, '.hive-flow'));
    expect(resolved.legacyHome).toBe(legacy);
    expect(resolved.legacyExists).toBe(true);
    expect(resolved.readFallbacks).toEqual([legacy]);
  });

  it('does not create the primary or legacy home as a side effect', () => {
    const primary = join(home, '.hive-flow');
    const legacy = join(home, '.claude', 'hive-flow');
    expect(existsSync(primary)).toBe(false);
    expect(existsSync(legacy)).toBe(false);
    const resolved = resolveHiveHome({}, { homeDir: home });
    expect(resolved.home).toBe(primary);
    expect(existsSync(primary)).toBe(false);
    expect(existsSync(legacy)).toBe(false);
  });
});

describe('resolveLegacyClaudeHiveHome', () => {
  it('returns the legacy Claude Hive Flow location under the supplied home', () => {
    const home = mkdtempSync(join(tmpdir(), 'hf-legacy-home-'));
    try {
      expect(resolveLegacyClaudeHiveHome({}, { homeDir: home })).toBe(
        join(home, '.claude', 'hive-flow'),
      );
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});

describe('projectKeyFor', () => {
  let projectRoot: string;

  beforeEach(() => {
    projectRoot = mkdtempSync(join(tmpdir(), 'hf-project-key-'));
  });

  afterEach(() => {
    rmSync(projectRoot, { recursive: true, force: true });
  });

  it('returns a stable sha256 key for a canonical project root', () => {
    const first = projectKeyFor(projectRoot);
    const second = projectKeyFor(resolve(projectRoot, '.'));
    expect(first).toBe(second);
    expect(first).toMatch(/^[a-f0-9]{64}$/);
  });

  it('canonicalizes symlinked project roots before hashing', () => {
    const linkParent = mkdtempSync(join(tmpdir(), 'hf-project-key-link-'));
    const link = join(linkParent, 'linked-project');
    try {
      symlinkSync(projectRoot, link, 'dir');
      expect(projectKeyFor(link)).toBe(projectKeyFor(realpathSync(projectRoot)));
    } finally {
      rmSync(linkParent, { recursive: true, force: true });
    }
  });
});

describe('sessionKeyFor', () => {
  it('uses explicit session input before environment values', () => {
    const fromInput = sessionKeyFor({ sessionId: 'claude-session-1' }, {
      HIVE_FLOW_SESSION_ID: 'env-session',
    });
    const sameInput = sessionKeyFor({ session_id: 'claude-session-1' }, {});
    const fromEnv = sessionKeyFor(undefined, { HIVE_FLOW_SESSION_ID: 'env-session' });
    expect(fromInput).toBe(sameInput);
    expect(fromInput).not.toBe(fromEnv);
  });

  it('uses CODEX_SESSION_ID before Claude and Hive Flow session env values', () => {
    const fromEnv = sessionKeyFor(undefined, {
      HIVE_FLOW_SESSION_ID: 'hive-session',
      CLAUDE_SESSION_ID: 'claude-session',
      CODEX_SESSION_ID: 'codex-session',
    });

    expect(fromEnv).toBe(sessionKeyFor({ sessionId: 'codex-session' }, {
      CODEX_SESSION_ID: 'codex-session',
    }));
    expect(fromEnv).not.toBe(sessionKeyFor({ sessionId: 'claude-session' }, {}));
    expect(fromEnv).not.toBe(sessionKeyFor({ sessionId: 'hive-session' }, {}));
  });

  it('returns deterministic path-safe keys for unsafe session values', () => {
    const key = sessionKeyFor({ sessionId: '../unsafe session/value' }, {});
    expect(key).toMatch(/^s_[a-f0-9]{32}$/);
    expect(sessionKeyFor({ sessionId: '../unsafe session/value' }, {})).toBe(key);
  });

  it('uses client kind as part of the key namespace', () => {
    const claude = sessionKeyFor({ sessionId: 'same-id', clientKind: 'claude-code' }, {});
    const codex = sessionKeyFor({ sessionId: 'same-id', clientKind: 'codex' }, {});
    expect(claude).not.toBe(codex);
  });

  it('defaults ownerless session keys to Claude rather than an unknown bucket', () => {
    expect(sessionKeyFor({ sessionId: 'default-owner' }, {})).toBe(
      sessionKeyFor({ sessionId: 'default-owner', clientKind: 'claude-code' }, {}),
    );
    expect(sessionKeyFor({ sessionId: 'codex-owner' }, { CODEX_SESSION_ID: 'codex-owner' })).toBe(
      sessionKeyFor({ sessionId: 'codex-owner', clientKind: 'codex' }, {}),
    );
  });
});

describe('public shared exports', () => {
  it('exports Phase 1 Hive home helpers from the package root', async () => {
    const shared = await import('../../index.js');
    expect(shared.resolveHiveHome).toBe(resolveHiveHome);
    expect(shared.resolveLegacyClaudeHiveHome).toBe(resolveLegacyClaudeHiveHome);
    expect(shared.projectKeyFor).toBe(projectKeyFor);
    expect(shared.sessionKeyFor).toBe(sessionKeyFor);
  });
});
