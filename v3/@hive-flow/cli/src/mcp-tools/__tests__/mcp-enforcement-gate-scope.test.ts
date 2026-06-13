/**
 * SECURITY REGRESSION TESTS — scope-aware getEnforcementLevel().
 *
 * Background (BUG #1, the original phantom-HALT): getEnforcementLevel() once
 * resolved ONLY a project-scoped state file and returned LEVEL_HALTED whenever
 * that file was missing. Any repo with no project state.json therefore got a
 * PHANTOM HALTED — agent_spawn (and other CRITICAL tools) were wrongly denied
 * even though the GLOBAL scope was clean (level 0).
 *
 * Background (BUG #2, the security WEAKENING this file now guards against): a
 * follow-up fix made the level scope-aware but read the WRONG project path
 * (`<projectDir>/.hive-flow/enforcement/state.json`) and used PER-SCOPE sibling
 * `.hmac-key` files. The REAL enforcement substrate (`.claude/helpers/
 * enforcement.cjs`) stores the project scope at
 * `<hiveHome>/enforcement/projects/<project-id>/state.json` and signs EVERY
 * hiveHome-rooted scope with ONE shared key at `<hiveHome>/enforcement/.hmac-key`.
 * Because the gate looked at the wrong path, a REAL project-scoped HALT(3)
 * returned 0 — a silent enforcement bypass.
 *
 * The corrected gate mirrors enforcement.cjs `loadEffectiveState()`:
 *   EFFECTIVE LEVEL = MAX over all PRESENT scopes
 *     (agent, hive, session, project, global — at their canonical hiveHome
 *      paths, with `<projectDir>/.hive-flow` legacy fallbacks),
 *   verified with the single shared key, NO present scope => 0 (clean default),
 *   PRESENT-but-tampered scope => LEVEL_HALTED (fail-closed).
 *
 *   project-id = `project-${sha256(PROJECT_DIR).slice(0,16)}`
 *
 * ISOLATION GUARANTEE: every test creates its own throwaway temp dir via
 * mkdtempSync(tmpdir()) and points HIVE_FLOW_HOME + CLAUDE_PROJECT_DIR at it.
 * No test reads, writes, or otherwise touches the real ~/.hive-flow enforcement
 * substrate. Scope-id env vars are cleared per-test for determinism.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { createHash, createHmac } from 'crypto';
import { join } from 'path';

import { getEnforcementLevel } from '../mcp-enforcement-gate.js';

// ---------------------------------------------------------------------------
// Fixture helpers — replicate exactly the signing + layout the gate verifies:
//   hmac = HMAC-SHA256(key, JSON.stringify(state))  (hex)
//   shared key:  <hiveHome>/enforcement/.hmac-key       (signs ALL scopes)
//   global:      <hiveHome>/enforcement/global/state.json
//   project:     <hiveHome>/enforcement/projects/<project-id>/state.json
//                project-id = `project-${sha256(PROJECT_DIR).slice(0,16)}`
//   session:     <hiveHome>/enforcement/sessions/<id>/state.json
//   agent:       <hiveHome>/enforcement/agents/<id>/state.json
//   hive:        <hiveHome>/enforcement/hives/<id>/state.json
//   legacy:      <projectDir>/.hive-flow/enforcement/... (fallbacks)
// ---------------------------------------------------------------------------

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

let originalHiveFlowHome: string | undefined;
let originalProjectDir: string | undefined;
let originalAgentId: string | undefined;
let originalCcAgentId: string | undefined;
let originalHiveId: string | undefined;
let originalSessionId: string | undefined;
let originalHfSessionId: string | undefined;
let originalAfSessionId: string | undefined;
const createdRoots: string[] = [];

beforeEach(() => {
  originalHiveFlowHome = process.env.HIVE_FLOW_HOME;
  originalProjectDir = process.env.CLAUDE_PROJECT_DIR;
  originalAgentId = process.env.AGENTIC_FLOW_AGENT_ID;
  originalCcAgentId = process.env.CLAUDE_AGENT_ID;
  originalHiveId = process.env.HIVE_FLOW_HIVE_ID;
  originalSessionId = process.env.CLAUDE_SESSION_ID;
  originalHfSessionId = process.env.HIVE_FLOW_SESSION_ID;
  originalAfSessionId = process.env.AGENTIC_FLOW_SESSION_ID;
  // Default: clear scope-id env so only the project + global scopes apply.
  delete process.env.AGENTIC_FLOW_AGENT_ID;
  delete process.env.CLAUDE_AGENT_ID;
  delete process.env.HIVE_FLOW_HIVE_ID;
  delete process.env.CLAUDE_SESSION_ID;
  delete process.env.HIVE_FLOW_SESSION_ID;
  delete process.env.AGENTIC_FLOW_SESSION_ID;
});

function restore(name: string, value: string | undefined): void {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

afterEach(() => {
  restore('HIVE_FLOW_HOME', originalHiveFlowHome);
  restore('CLAUDE_PROJECT_DIR', originalProjectDir);
  restore('AGENTIC_FLOW_AGENT_ID', originalAgentId);
  restore('CLAUDE_AGENT_ID', originalCcAgentId);
  restore('HIVE_FLOW_HIVE_ID', originalHiveId);
  restore('CLAUDE_SESSION_ID', originalSessionId);
  restore('HIVE_FLOW_SESSION_ID', originalHfSessionId);
  restore('AGENTIC_FLOW_SESSION_ID', originalAfSessionId);

  while (createdRoots.length > 0) {
    const root = createdRoots.pop()!;
    try {
      rmSync(root, { recursive: true, force: true });
    } catch {
      // best-effort cleanup
    }
  }
});

/**
 * Create an isolated sandbox: a fresh temp root containing a tmp HIVE_FLOW_HOME
 * and a tmp project dir, and wire both env vars to point at it. ABSOLUTELY never
 * touches the real ~/.hive-flow.
 */
function makeSandbox(): Sandbox {
  const root = mkdtempSync(join(tmpdir(), 'hf-gate-scope-'));
  createdRoots.push(root);
  const hiveHome = join(root, 'hive-home');
  const projectDir = join(root, 'project');
  mkdirSync(hiveHome, { recursive: true });
  mkdirSync(projectDir, { recursive: true });
  process.env.HIVE_FLOW_HOME = hiveHome; // absolute => honored
  process.env.CLAUDE_PROJECT_DIR = projectDir;
  return { hiveHome, projectDir };
}

// A SINGLE shared key signs every hiveHome-rooted scope, matching
// enforcement.cjs getOrCreateHmacKey(). NO per-scope sibling keys.
const SHARED_KEY = 'shared-test-hmac-key-deadbeefcafef00d';

/** Ensure the shared <hiveHome>/enforcement/.hmac-key exists. */
function writeSharedKey(sb: Sandbox): void {
  const enforcementDir = join(sb.hiveHome, 'enforcement');
  mkdirSync(enforcementDir, { recursive: true });
  writeFileSync(join(enforcementDir, '.hmac-key'), SHARED_KEY, 'utf8');
}

/** Write a valid signed global state.json at level `level`. */
function writeGlobalState(sb: Sandbox, level: number): void {
  writeSharedKey(sb);
  const globalDir = join(sb.hiveHome, 'enforcement', 'global');
  mkdirSync(globalDir, { recursive: true });
  writeFileSync(join(globalDir, 'state.json'), signEnvelope({ level }, SHARED_KEY), 'utf8');
}

/**
 * Write a valid signed PROJECT state.json at the CORRECT hiveHome path:
 *   <hiveHome>/enforcement/projects/<project-id>/state.json
 */
function writeProjectState(sb: Sandbox, level: number): void {
  writeSharedKey(sb);
  const id = projectScopeId(sb.projectDir);
  const projectDir = join(sb.hiveHome, 'enforcement', 'projects', id);
  mkdirSync(projectDir, { recursive: true });
  writeFileSync(join(projectDir, 'state.json'), signEnvelope({ level }, SHARED_KEY), 'utf8');
}

/** Write a valid signed scope state.json under <hiveHome>/enforcement/<dir>/<id>/. */
function writeScopeState(sb: Sandbox, scopeDir: string, id: string, level: number): void {
  writeSharedKey(sb);
  const dir = join(sb.hiveHome, 'enforcement', scopeDir, id);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'state.json'), signEnvelope({ level }, SHARED_KEY), 'utf8');
}

/** Write a PRESENT-but-tampered project state.json (signature won't verify). */
function writeTamperedProjectState(sb: Sandbox): void {
  writeSharedKey(sb);
  const id = projectScopeId(sb.projectDir);
  const projectDir = join(sb.hiveHome, 'enforcement', 'projects', id);
  mkdirSync(projectDir, { recursive: true });
  // level-0 envelope with a bogus hmac that will not verify against SHARED_KEY.
  writeFileSync(
    join(projectDir, 'state.json'),
    JSON.stringify({ state: { level: 0 }, hmac: 'deadbeefdeadbeef' }),
    'utf8',
  );
}

describe('getEnforcementLevel — scope-aware (security regression)', () => {
  // ---- BUG #1 guard: no phantom HALT --------------------------------------

  it('[BUG #1] no project state.json + global level 0 -> returns 0 (NOT HALTED)', () => {
    const sb = makeSandbox();
    writeGlobalState(sb, 0);
    expect(getEnforcementLevel()).toBe(0);
  });

  it('no scope files at all -> 0 (clean default, no phantom HALT)', () => {
    makeSandbox();
    expect(getEnforcementLevel()).toBe(0);
  });

  it('missing project scope alone never phantom-HALTs (global 0 only)', () => {
    const sb = makeSandbox();
    writeGlobalState(sb, 0);
    expect(getEnforcementLevel()).toBe(0);
  });

  // ---- BUG #2 guard: REAL project HALT at the CORRECT path must block ------

  it('[BUG #2 — THE MISSED CASE] project HALT(3) at CORRECT hiveHome path -> 3', () => {
    const sb = makeSandbox();
    writeGlobalState(sb, 0);
    // Written to <hiveHome>/enforcement/projects/<project-id>/state.json (level 3).
    writeProjectState(sb, 3);
    expect(getEnforcementLevel()).toBe(3);
  });

  it('[BUG #2] project HALT(3), NO global file present -> 3', () => {
    const sb = makeSandbox();
    writeProjectState(sb, 3);
    expect(getEnforcementLevel()).toBe(3);
  });

  it('[BUG #2] gate reads the sha256-derived project-id path (CLAUDE_PROJECT_DIR)', () => {
    const sb = makeSandbox();
    // Sanity: the id the gate uses is the sha256 of the tmp CLAUDE_PROJECT_DIR.
    const id = projectScopeId(sb.projectDir);
    expect(id).toMatch(/^project-[0-9a-f]{16}$/);
    writeScopeState(sb, 'projects', id, 3);
    expect(getEnforcementLevel()).toBe(3);
  });

  it('[BUG #2] a state file at the OLD wrong path is IGNORED (no false security)', () => {
    const sb = makeSandbox();
    writeGlobalState(sb, 0);
    // Old (wrong) path the buggy gate read: <projectDir>/.hive-flow/enforcement/state.json.
    // enforcement.cjs treats this as the LEGACY GLOBAL fallback, NOT project —
    // and only when the canonical global file is ABSENT. Here the canonical
    // global file IS present (level 0), so this legacy file must not apply, and
    // there is no real project HALT => level stays 0.
    const legacyDir = join(sb.projectDir, '.hive-flow', 'enforcement');
    mkdirSync(legacyDir, { recursive: true });
    writeFileSync(join(legacyDir, '.hmac-key'), SHARED_KEY, 'utf8');
    writeFileSync(join(legacyDir, 'state.json'), signEnvelope({ level: 3 }, SHARED_KEY), 'utf8');
    expect(getEnforcementLevel()).toBe(0);
  });

  // ---- session / agent / hive scope HALTs (enforcement.cjs MAXes them) -----

  it('session scope HALT(3) at correct hiveHome path -> 3', () => {
    const sb = makeSandbox();
    writeGlobalState(sb, 0);
    process.env.CLAUDE_SESSION_ID = 'sess-abc123';
    writeScopeState(sb, 'sessions', 'sess-abc123', 3);
    expect(getEnforcementLevel()).toBe(3);
  });

  it('agent scope HALT(3) at correct hiveHome path -> 3', () => {
    const sb = makeSandbox();
    writeGlobalState(sb, 0);
    process.env.AGENTIC_FLOW_AGENT_ID = 'agent-xyz789';
    writeScopeState(sb, 'agents', 'agent-xyz789', 3);
    expect(getEnforcementLevel()).toBe(3);
  });

  it('hive scope HALT(3) at correct hiveHome path -> 3', () => {
    const sb = makeSandbox();
    writeGlobalState(sb, 0);
    process.env.HIVE_FLOW_HIVE_ID = 'hive-q1';
    writeScopeState(sb, 'hives', 'hive-q1', 3);
    expect(getEnforcementLevel()).toBe(3);
  });

  it('scope state present but env id unset -> that scope absent (no contribution)', () => {
    const sb = makeSandbox();
    writeGlobalState(sb, 0);
    // Write a HALT under a hive id but DO NOT set HIVE_FLOW_HIVE_ID.
    writeScopeState(sb, 'hives', 'hive-q1', 3);
    expect(getEnforcementLevel()).toBe(0);
  });

  // ---- global HALT + MAX walk ---------------------------------------------

  it('global level 3 + no project -> 3 (real global HALT still blocks)', () => {
    const sb = makeSandbox();
    writeGlobalState(sb, 3);
    expect(getEnforcementLevel()).toBe(3);
  });

  it('global 0 + project level 2 -> 2 (MAX over present scopes)', () => {
    const sb = makeSandbox();
    writeGlobalState(sb, 0);
    writeProjectState(sb, 2);
    expect(getEnforcementLevel()).toBe(2);
  });

  it('project level 1 only (no global file present) -> 1 (project alone applies)', () => {
    const sb = makeSandbox();
    writeProjectState(sb, 1);
    expect(getEnforcementLevel()).toBe(1);
  });

  it('global level 2 + project level 1 -> 2 (global is the max)', () => {
    const sb = makeSandbox();
    writeGlobalState(sb, 2);
    writeProjectState(sb, 1);
    expect(getEnforcementLevel()).toBe(2);
  });

  it('session 3 + project 1 + global 0 -> 3 (MAX across three present scopes)', () => {
    const sb = makeSandbox();
    writeGlobalState(sb, 0);
    writeProjectState(sb, 1);
    process.env.CLAUDE_SESSION_ID = 'sess-max';
    writeScopeState(sb, 'sessions', 'sess-max', 3);
    expect(getEnforcementLevel()).toBe(3);
  });

  // ---- tamper => fail-closed HALTED ---------------------------------------

  it('present-but-tampered project state -> HALTED (tamper still blocks, fail-closed)', () => {
    const sb = makeSandbox();
    writeGlobalState(sb, 0);
    writeTamperedProjectState(sb);
    expect(getEnforcementLevel()).toBe(3);
  });

  it('present-but-tampered GLOBAL state -> HALTED (tamper blocks at global scope too)', () => {
    const sb = makeSandbox();
    writeSharedKey(sb);
    const globalDir = join(sb.hiveHome, 'enforcement', 'global');
    mkdirSync(globalDir, { recursive: true });
    writeFileSync(
      join(globalDir, 'state.json'),
      JSON.stringify({ state: { level: 0 }, hmac: 'deadbeef' }),
      'utf8',
    );
    expect(getEnforcementLevel()).toBe(3);
  });

  it('signed project state but NO shared key on disk -> HALTED (cannot verify, fail-closed)', () => {
    const sb = makeSandbox();
    // Write the project state WITHOUT writing the shared .hmac-key.
    const id = projectScopeId(sb.projectDir);
    const projectDir = join(sb.hiveHome, 'enforcement', 'projects', id);
    mkdirSync(projectDir, { recursive: true });
    writeFileSync(join(projectDir, 'state.json'), signEnvelope({ level: 0 }, SHARED_KEY), 'utf8');
    expect(getEnforcementLevel()).toBe(3);
  });

  // ---- parity assertion: gate == scope-max computed from the same fixtures -

  it('PARITY: gate level == MAX over the on-disk scope levels for a fixture', () => {
    const sb = makeSandbox();
    process.env.CLAUDE_SESSION_ID = 'sess-parity';
    process.env.HIVE_FLOW_HIVE_ID = 'hive-parity';
    // On-disk scope levels we will MAX ourselves.
    const onDisk: Record<string, number> = {
      global: 0,
      project: 2,
      session: 1,
      hive: 3,
    };
    writeGlobalState(sb, onDisk.global);
    writeProjectState(sb, onDisk.project);
    writeScopeState(sb, 'sessions', 'sess-parity', onDisk.session);
    writeScopeState(sb, 'hives', 'hive-parity', onDisk.hive);
    const expectedMax = Math.max(...Object.values(onDisk));
    expect(getEnforcementLevel()).toBe(expectedMax);
    expect(expectedMax).toBe(3); // sanity for this fixture
  });
});
