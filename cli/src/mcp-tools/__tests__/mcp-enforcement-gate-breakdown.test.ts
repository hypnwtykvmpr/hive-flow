/**
 * F0-B (hive-flow-6f73) — getEnforcementLevelBreakdown() visibility tests.
 *
 * The escalation LADDER (Normal/Warned/Restricted/Halted) gates provider-bridge
 * writes/exec/fetch (RESTRICTED+) and MCP tools, but nothing surfaced it — so
 * operators saw NORMAL from workflow_enforcer_status (a DIFFERENT, complexity
 * axis) while API-provider writes were blocked at RESTRICTED+.
 *
 * These tests prove the breakdown reader:
 *   - AGREES with getEnforcementLevel() on the effective number (they share one
 *     scope-walk, so the reported level can never diverge from the gated one),
 *   - reports per-scope contributions + level names + block descriptions,
 *   - preserves fail-closed HALTED on tamper / unverifiable state.
 *
 * Fixture harness mirrors mcp-enforcement-gate-scope.test.ts exactly (isolated
 * temp HIVE_FLOW_HOME + CLAUDE_PROJECT_DIR; never touches the real ~/.hive-flow).
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, realpathSync } from 'fs';
import { tmpdir } from 'os';
import { createHash, createHmac } from 'crypto';
import { join } from 'path';

import { getEnforcementLevel, getEnforcementLevelBreakdown, levelName } from '../mcp-enforcement-gate.js';
import { operatorSessionEnvKeys } from '../session-id.js';

function signEnvelope(state: Record<string, unknown>, key: string): string {
  return JSON.stringify({
    state,
    hmac: createHmac('sha256', key).update(JSON.stringify(state)).digest('hex'),
  });
}

function projectScopeId(projectDir: string): string {
  return `project-${createHash('sha256').update(projectDir).digest('hex').slice(0, 16)}`;
}

interface Sandbox {
  hiveHome: string;
  projectDir: string;
}

const ENV_KEYS_TO_ISOLATE = Array.from(new Set([
  'HIVE_FLOW_HOME',
  'HIVE_FLOW_PROJECT_ROOT',
  'CLAUDE_PROJECT_DIR',
  'HIVE_FLOW_AGENT_ID',
  'CLAUDE_AGENT_ID',
  'HIVE_FLOW_HIVE_ID',
  'HIVE_FLOW_CLIENT_KIND',
  ...operatorSessionEnvKeys(),
  'CLAUDECODE',
  'CLAUDE_CODE',
  'CLAUDE_CODE_ENTRYPOINT',
]));

let originalEnv: Record<string, string | undefined> = {};
const createdRoots: string[] = [];

beforeEach(() => {
  originalEnv = {};
  for (const key of ENV_KEYS_TO_ISOLATE) {
    originalEnv[key] = process.env[key];
    delete process.env[key];
  }
});

function restore(name: string, value: string | undefined): void {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

afterEach(() => {
  for (const [key, value] of Object.entries(originalEnv)) restore(key, value);
  while (createdRoots.length > 0) {
    const root = createdRoots.pop()!;
    try {
      rmSync(root, { recursive: true, force: true });
    } catch {
      // best-effort cleanup
    }
  }
});

function makeSandbox(): Sandbox {
  const root = mkdtempSync(join(tmpdir(), 'hf-gate-breakdown-'));
  createdRoots.push(root);
  const hiveHome = join(root, 'hive-home');
  const lexicalProjectDir = join(root, 'project');
  mkdirSync(hiveHome, { recursive: true });
  mkdirSync(lexicalProjectDir, { recursive: true });
  const projectDir = realpathSync.native(lexicalProjectDir);
  process.env.HIVE_FLOW_HOME = hiveHome;
  process.env.CLAUDE_PROJECT_DIR = projectDir;
  return { hiveHome, projectDir };
}

const SHARED_KEY = 'shared-test-hmac-key-deadbeefcafef00d';

function writeSharedKey(sb: Sandbox): void {
  const enforcementDir = join(sb.hiveHome, 'enforcement');
  mkdirSync(enforcementDir, { recursive: true });
  writeFileSync(join(enforcementDir, '.hmac-key'), SHARED_KEY, 'utf8');
}

function writeGlobalState(sb: Sandbox, level: number): void {
  writeSharedKey(sb);
  const globalDir = join(sb.hiveHome, 'enforcement', 'global');
  mkdirSync(globalDir, { recursive: true });
  writeFileSync(join(globalDir, 'state.json'), signEnvelope({ level }, SHARED_KEY), 'utf8');
}

function writeProjectState(sb: Sandbox, level: number): void {
  writeSharedKey(sb);
  const id = projectScopeId(sb.projectDir);
  const scopeDir = join(sb.hiveHome, 'enforcement', 'projects', id);
  mkdirSync(scopeDir, { recursive: true });
  writeFileSync(join(scopeDir, 'state.json'), signEnvelope({ level }, SHARED_KEY), 'utf8');
}

function writeScopeState(sb: Sandbox, scopeDir: string, id: string, level: number): void {
  writeSharedKey(sb);
  const dir = join(sb.hiveHome, 'enforcement', scopeDir, id);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'state.json'), signEnvelope({ level }, SHARED_KEY), 'utf8');
}

function writeTamperedGlobalState(sb: Sandbox): void {
  writeSharedKey(sb);
  const globalDir = join(sb.hiveHome, 'enforcement', 'global');
  mkdirSync(globalDir, { recursive: true });
  writeFileSync(
    join(globalDir, 'state.json'),
    JSON.stringify({ state: { level: 0 }, hmac: 'deadbeefdeadbeef' }),
    'utf8',
  );
}

describe('levelName', () => {
  it('maps ladder levels to names', () => {
    expect(levelName(0)).toBe('NORMAL');
    expect(levelName(1)).toBe('WARNED');
    expect(levelName(2)).toBe('RESTRICTED');
    expect(levelName(3)).toBe('HALTED');
    expect(levelName(-1)).toBe('NORMAL');
    expect(levelName(99)).toBe('HALTED');
  });
});

describe('getEnforcementLevelBreakdown — agreement with the gated number', () => {
  const cases: Array<[string, (sb: Sandbox) => void, number]> = [
    ['clean (no scope files)', () => {}, 0],
    ['global 0', (sb) => writeGlobalState(sb, 0), 0],
    ['global RESTRICTED(2)', (sb) => writeGlobalState(sb, 2), 2],
    ['global HALT(3)', (sb) => writeGlobalState(sb, 3), 3],
    ['project 2 over global 0 (MAX)', (sb) => { writeGlobalState(sb, 0); writeProjectState(sb, 2); }, 2],
  ];
  for (const [label, setup, expected] of cases) {
    it(`effectiveLevel === getEnforcementLevel() and === ${expected} for: ${label}`, () => {
      const sb = makeSandbox();
      setup(sb);
      const breakdown = getEnforcementLevelBreakdown();
      expect(breakdown.effectiveLevel).toBe(getEnforcementLevel());
      expect(breakdown.effectiveLevel).toBe(expected);
      expect(breakdown.effectiveLevelName).toBe(levelName(expected));
      expect(breakdown.failClosed).toBe(false);
    });
  }
});

describe('getEnforcementLevelBreakdown — the F0-B scenario (RESTRICTED+ visibility)', () => {
  it('surfaces a RESTRICTED global scope with a bridge-write block description', () => {
    const sb = makeSandbox();
    writeGlobalState(sb, 2);
    const b = getEnforcementLevelBreakdown();
    expect(b.effectiveLevel).toBe(2);
    expect(b.effectiveLevelName).toBe('RESTRICTED');
    const globalContribution = b.scopes.find((s) => s.scope === 'global');
    expect(globalContribution).toBeDefined();
    expect(globalContribution!.level).toBe(2);
    expect(globalContribution!.source).toBe('canonical');
    // The whole point of F0-B: the operator can see WHY bridge/API writes are blocked.
    expect(b.blocks.some((x) => /provider-bridge write/i.test(x))).toBe(true);
  });

  it('reports NO scopes and NO blocks when clean (NORMAL)', () => {
    makeSandbox();
    const b = getEnforcementLevelBreakdown();
    expect(b.effectiveLevel).toBe(0);
    expect(b.effectiveLevelName).toBe('NORMAL');
    expect(b.scopes).toEqual([]);
    expect(b.blocks).toEqual([]);
  });

  it('attributes the level to the right scope (session HALT wins) and lists all present scopes', () => {
    const sb = makeSandbox();
    writeGlobalState(sb, 0);
    writeProjectState(sb, 1);
    process.env.CLAUDE_SESSION_ID = 'sess-break';
    writeScopeState(sb, 'sessions', 'sess-break', 3);
    const b = getEnforcementLevelBreakdown();
    expect(b.effectiveLevel).toBe(3);
    expect(b.effectiveLevel).toBe(getEnforcementLevel());
    const bySccope = Object.fromEntries(b.scopes.map((s) => [s.scope, s.level]));
    expect(bySccope.global).toBe(0);
    expect(bySccope.project).toBe(1);
    expect(bySccope.session).toBe(3);
    // WARNED + RESTRICTED + HALTED descriptions all present at level 3.
    expect(b.blocks.length).toBeGreaterThanOrEqual(3);
  });
});

describe('getEnforcementLevelBreakdown — fail-closed on tamper', () => {
  it('tampered global state -> HALTED, agrees with getEnforcementLevel()', () => {
    const sb = makeSandbox();
    writeTamperedGlobalState(sb);
    const b = getEnforcementLevelBreakdown();
    expect(b.effectiveLevel).toBe(3);
    expect(b.effectiveLevel).toBe(getEnforcementLevel());
    expect(b.effectiveLevelName).toBe('HALTED');
  });

  it('signed state but NO shared key -> HALTED (cannot verify, fail-closed)', () => {
    const sb = makeSandbox();
    const globalDir = join(sb.hiveHome, 'enforcement', 'global');
    mkdirSync(globalDir, { recursive: true });
    writeFileSync(join(globalDir, 'state.json'), signEnvelope({ level: 0 }, SHARED_KEY), 'utf8');
    const b = getEnforcementLevelBreakdown();
    expect(b.effectiveLevel).toBe(3);
    expect(b.effectiveLevel).toBe(getEnforcementLevel());
  });
});
