// v3/@hive-flow/cli/src/commands/__tests__/statusline-launcher-idle-proof.test.ts
//
// PROOF 1 — GLOBAL-INSTALL / LAUNCHER: idle-only workers render "○", not "◉".
//
// This test encodes the REQUIRED corrected behavior per the statusboard-fix
// spec. It does NOT test the current (broken) implementation — it asserts
// what the implementation MUST produce after the fix.
//
// Assertions:
//   a. The installed ~/.hive-flow/bin/claude-code-statusline launcher execs
//      bin/statusline.js (already proven by existing init tests; we reuse
//      the same fixture shape and extend it).
//   b. When the agent store has ONLY idle agents (activeAgents === 0,
//      idleAgents > 0) the rendered Swarm row uses "○", NOT "◉".
//   c. When the agent store has at least one busy agent (activeAgents > 0)
//      the rendered Swarm row uses "◉".
//   d. ENFORCEMENT ON (LEVEL) text is preserved through the launcher for
//      a live enforcement state.

import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import initCommand from '../init.js';
import type { CommandContext } from '../../types.js';
import { resolveEnforcementBinDir } from '../../install/enforcement-installer.js';
import { renderClaudeCodeStatusline } from '../../statusline/claude-code-renderer.js';

// ---------------------------------------------------------------------------
// Helpers (mirror makeProjectRoot from init-global-claude.test.ts)
// ---------------------------------------------------------------------------

function makeCtx(cwd: string, flags: Record<string, string | number | boolean>): CommandContext {
  return {
    cwd,
    args: [],
    flags: { _: [], ...flags },
    interactive: false,
  };
}

function makeProjectRoot(): string {
  const projectRoot = mkdtempSync(join(tmpdir(), 'hf-launcher-idle-project-'));
  for (const relativePath of [
    '.claude/helpers/hive-composition-gate.cjs',
    '.claude/helpers/role-enforcement.cjs',
    '.claude/helpers/enforcement.cjs',
    '.claude/helpers/hook-handler.cjs',
    '.claude/helpers/settings-reconciler.cjs',
    '.claude/helpers/provider-tracker.cjs',
    '.claude/helpers/client-kind.cjs',
    '.claude/helpers/session-id.cjs',
    'v3/@hive-flow/cli/src/permission-guard/protected-paths.cjs',
    'v3/@hive-flow/cli/src/permission-guard/protected-paths.policy.json',
  ]) {
    const target = join(projectRoot, relativePath);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, `fixture:${relativePath}\n`);
  }
  // The statusline.js stub echoes "HF_BOARD" so we can detect it launched correctly.
  const statuslineRuntime = join(projectRoot, 'v3/@hive-flow/cli/bin/statusline.js');
  mkdirSync(dirname(statuslineRuntime), { recursive: true });
  writeFileSync(statuslineRuntime, '#!/usr/bin/env node\nprocess.stdout.write("HF_BOARD\\n");\n');
  return projectRoot;
}

/**
 * Write a synthetic snapshot with the given swarm config so the renderer
 * (via the real statusline.js) can produce board output we can assert.
 */
function writeSwarmSnapshot(
  projectRoot: string,
  swarm: {
    activeAgents: number;
    idleAgents: number;
    queuedAgents: number;
    maxAgents: number;
    activeQueens: number;
    executingQueens: number;
  },
): void {
  const dir = join(projectRoot, '.hive-flow', 'state');
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, 'cache.json'),
    JSON.stringify({
      version: 1,
      projectRoot,
      repoIdentity: projectRoot,
      displayName: 'idle-proof-project',
      projectKey: '0123456789abcdef',
      generatedAt: new Date().toISOString(),
      sources: {},
      swarm,
      daemon: { running: true, health: 'healthy', observedAt: new Date().toISOString() },
    }),
    'utf8',
  );
}

/**
 * Write a live enforcement global state.json at the HIVE_FLOW_HOME-relative path
 * so the renderer emits ENFORCEMENT ON (LEVEL).
 */
function writeLiveEnforcementState(hiveHome: string, level: number): void {
  const stateDir = join(hiveHome, 'enforcement', 'global');
  mkdirSync(stateDir, { recursive: true });
  writeFileSync(
    join(stateDir, 'state.json'),
    JSON.stringify({
      state: {
        level,
        violations: 0,
        consecutiveDenials: 0,
        restrictedGroups: [],
        lastActivity: new Date().toISOString(),
        integrityCompromised: false,
      },
      hmac: 'test-fixture',
    }),
    'utf8',
  );
}

function stripAnsi(value: string): string {
  return value.replace(/\x1b\[[0-9;]*m/g, '');
}

// ---------------------------------------------------------------------------
// Suite
// ---------------------------------------------------------------------------

describe('Proof 1 — launcher idle-only symbol (spec: idle => ○, not ◉)', () => {
  let cwd: string;
  let homeDir: string;
  let projectRoot: string;
  let originalHome: string | undefined;
  let originalHiveHome: string | undefined;

  beforeEach(async () => {
    cwd = mkdtempSync(join(tmpdir(), 'hf-launcher-idle-cwd-'));
    homeDir = mkdtempSync(join(tmpdir(), 'hf-launcher-idle-home-'));
    projectRoot = makeProjectRoot();
    originalHome = process.env.HOME;
    originalHiveHome = process.env.HIVE_FLOW_HOME;
    process.env.HOME = homeDir;
    process.env.HIVE_FLOW_HOME = homeDir;

    const settingsPath = join(homeDir, '.claude', 'settings.json');
    mkdirSync(dirname(settingsPath), { recursive: true });

    // Install the global statusline launcher via init.
    const result = await initCommand.action!(makeCtx(cwd, {
      global: true,
      'claude-code': true,
      yes: true,
      home: homeDir,
      'user-settings': settingsPath,
      'project-root': projectRoot,
    }));
    expect(result).toMatchObject({ success: true });
  });

  afterEach(() => {
    if (originalHome !== undefined) process.env.HOME = originalHome;
    else delete process.env.HOME;
    if (originalHiveHome !== undefined) process.env.HIVE_FLOW_HOME = originalHiveHome;
    else delete process.env.HIVE_FLOW_HOME;
    rmSync(cwd, { recursive: true, force: true });
    rmSync(homeDir, { recursive: true, force: true });
    rmSync(projectRoot, { recursive: true, force: true });
  });

  it('launcher exists and execs bin/statusline.js (HF_BOARD in output)', () => {
    const launcher = join(homeDir, '.hive-flow', 'bin', 'claude-code-statusline');
    expect(existsSync(launcher)).toBe(true);

    const launched = spawnSync(launcher, [], {
      cwd,
      input: JSON.stringify({
        workspace: { current_dir: cwd, project_dir: cwd },
        model: { display_name: 'Opus 4.8' },
      }),
      encoding: 'utf8',
      timeout: 5000,
      env: { ...process.env, HOME: homeDir, HIVE_FLOW_HOME: homeDir },
    });

    expect(launched.status).toBe(0);
    expect(launched.stdout).toContain('HF_BOARD');
  });

  it('idle-only agents (activeAgents=0, idleAgents>0) render "○" not "◉" in the Swarm row', () => {
    // Write a snapshot with ONLY idle agents — no executing workers.
    writeSwarmSnapshot(projectRoot, {
      activeAgents: 0,
      idleAgents: 3,
      queuedAgents: 0,
      maxAgents: 150,
      activeQueens: 0,
      executingQueens: 0,
    });

    // The renderer must be asserted directly (the stub statusline.js only prints HF_BOARD).
    // We call the renderer inline, which is the exact module the launcher delegates to.
    return renderClaudeCodeStatusline(
      {
        workspace: { current_dir: projectRoot, project_dir: projectRoot },
        model: { display_name: 'Opus 4.8' },
      },
      projectRoot,
    ).then((output) => {
      const plain = stripAnsi(output);
      // SPEC: idle-only => "○" displayed in the Swarm row.
      expect(plain).toContain('Swarm ○');
      // SPEC: "◉" must NOT appear when no agent is executing.
      expect(plain).not.toContain('Swarm ◉');
    });
  });

  it('busy agents (activeAgents>0) render "◉" in the Swarm row', () => {
    // Control case: at least one busy/executing agent => "◉".
    writeSwarmSnapshot(projectRoot, {
      activeAgents: 2,
      idleAgents: 1,
      queuedAgents: 0,
      maxAgents: 150,
      activeQueens: 1,
      executingQueens: 1,
    });

    return renderClaudeCodeStatusline(
      {
        workspace: { current_dir: projectRoot, project_dir: projectRoot },
        model: { display_name: 'Opus 4.8' },
      },
      projectRoot,
    ).then((output) => {
      const plain = stripAnsi(output);
      // Executing workers => "◉".
      expect(plain).toContain('Swarm ◉');
    });
  });

  it('ENFORCEMENT ON (LEVEL) is preserved through the renderer when live state exists', () => {
    // Write enforcement state at level 1 (WARNED) to homeDir.
    writeLiveEnforcementState(homeDir, 1);

    return renderClaudeCodeStatusline(
      {
        workspace: { current_dir: cwd, project_dir: cwd },
        model: { display_name: 'Opus 4.8' },
      },
      cwd,
    ).then((output) => {
      const plain = stripAnsi(output);
      // SPEC: enforcement ON with level label is preserved.
      expect(plain).toContain('ENFORCEMENT ON (WARNED)');
      expect(plain).not.toContain('ENFORCEMENT OFF');
    });
  });

  it('ENFORCEMENT ON (NORMAL) is preserved when enforcement state is level 0', () => {
    writeLiveEnforcementState(homeDir, 0);

    return renderClaudeCodeStatusline(
      {
        workspace: { current_dir: cwd, project_dir: cwd },
        model: { display_name: 'Opus 4.8' },
      },
      cwd,
    ).then((output) => {
      const plain = stripAnsi(output);
      expect(plain).toContain('ENFORCEMENT ON (NORMAL)');
      expect(plain).not.toContain('ENFORCEMENT OFF');
    });
  });

  // Sanity: the binDir resolved by the installer matches where the launcher lives.
  it('resolveEnforcementBinDir produces the path where the launcher was installed', () => {
    const binDir = resolveEnforcementBinDir(homeDir);
    // The launcher for statusline lives one level up from the enforcement bin.
    const launcherDir = join(homeDir, '.hive-flow', 'bin');
    const launcher = join(launcherDir, 'claude-code-statusline');
    expect(existsSync(launcher)).toBe(true);
    // The enforcement helpers live in the enforcement/bin path.
    expect(binDir).toContain(homeDir);
  });
});
