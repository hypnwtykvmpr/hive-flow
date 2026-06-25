// v3/@hive-flow/cli/src/statusline/__tests__/claude-code-renderer.test.ts
//
// Phase 12 — Renderer replacement regression suite.
//
// Covers the three rendering modes (snapshot / inline-collector / header-only),
// the <200ms render budget assertion, the no-bright-yellow guarantee, the
// last-render write contract, the failure paths, and the static-audit rules
// (no shell-outs / no execSync / no synchronous readFileSync in the renderer
// source).
//
// The renderer signature accepted here is `renderClaudeCodeStatusline(stdin?, projectRoot?)`
// where `stdin` may be either a parsed object or a raw string (`unknown` at
// the boundary — defensively narrowed in renderer code).

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir, homedir } from 'node:os';
import { performance } from 'node:perf_hooks';

import { sessionKeyFor } from '../../shared/index.js';

import {
  renderClaudeCodeStatusline,
  renderClaudeCodeStatuslineWithMeta,
  readStatuslineStdin,
  resolveActiveCwd,
} from '../claude-code-renderer.js';
import { resolveProjectScope } from '../project-scope.js';
import type { StatuslineSnapshotV1 } from '../types.js';
// last-render helpers are dynamically imported in individual tests so test
// runs don't pay the import cost up front. Direct named imports are not used
// at module scope because tests need to read after redirected HIVE_FLOW_HOME.

/**
 * Mirror the wrapper contract from `bin/statusline.js` and
 * `src/commands/statusline.ts`: render via the meta API, then persist the
 * last-render mirror via `writeLastRender`. The pure renderer is
 * side-effect-free; the wrapper owns persistence.
 *
 * Tests use this helper instead of calling `writeLastRender` inline so the
 * assertion targets the wrapper contract (which is what production runs).
 */
async function renderAndPersist(
  stdin: unknown,
  projectRoot: string,
): Promise<{ rendered: string; mode: string }> {
  const meta = await renderClaudeCodeStatuslineWithMeta(stdin, projectRoot);
  if (meta.projectKey && meta.projectRoot) {
    const { writeLastRender } = await import('../last-render.js');
    await writeLastRender({
      rendered: meta.rendered,
      mode: meta.mode,
      projectRoot: meta.projectRoot,
      projectKey: meta.projectKey,
      ...(meta.snapshot !== undefined ? { snapshot: meta.snapshot } : {}),
    }).catch(() => undefined);
  }
  return { rendered: meta.rendered, mode: meta.mode };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function stripAnsi(value: string): string {
  // eslint-disable-next-line no-control-regex
  return value.replace(/\x1b\[[0-9;]*m/g, '');
}

interface Fixture {
  projectRoot: string;
  home: string;
  origHome?: string;
  origNoColor?: string;
  origForce?: string;
  origActive?: string;
  origTerm?: string;
  projectKey?: string;
}

function makeFixture(): Fixture {
  const projectRoot = mkdtempSync(join(tmpdir(), 'hf-render-proj-'));
  const home = mkdtempSync(join(tmpdir(), 'hf-render-home-'));
  const origHome = process.env.HIVE_FLOW_HOME;
  const origNoColor = process.env.NO_COLOR;
  const origForce = process.env.FORCE_COLOR;
  const origActive = process.env.HIVE_FLOW_STATUSLINE_ACTIVE;
  const origTerm = process.env.TERM;
  process.env.HIVE_FLOW_HOME = home;
  // Default to 256-color rendering so palette codes appear in tests. Tests
  // that need NO_COLOR / 16-color flip the env explicitly.
  process.env.FORCE_COLOR = '3';
  delete process.env.NO_COLOR;
  delete process.env.HIVE_FLOW_STATUSLINE_ACTIVE;
  return {
    projectRoot,
    home,
    ...(origHome !== undefined ? { origHome } : {}),
    ...(origNoColor !== undefined ? { origNoColor } : {}),
    ...(origForce !== undefined ? { origForce } : {}),
    ...(origActive !== undefined ? { origActive } : {}),
    ...(origTerm !== undefined ? { origTerm } : {}),
  };
}

function cleanupFixture(fix: Fixture): void {
  try {
    rmSync(fix.projectRoot, { recursive: true, force: true });
  } catch {
    /* best-effort */
  }
  try {
    rmSync(fix.home, { recursive: true, force: true });
  } catch {
    /* best-effort */
  }
  if (fix.origHome !== undefined) process.env.HIVE_FLOW_HOME = fix.origHome;
  else delete process.env.HIVE_FLOW_HOME;
  if (fix.origNoColor !== undefined) process.env.NO_COLOR = fix.origNoColor;
  else delete process.env.NO_COLOR;
  if (fix.origForce !== undefined) process.env.FORCE_COLOR = fix.origForce;
  else delete process.env.FORCE_COLOR;
  if (fix.origActive !== undefined) process.env.HIVE_FLOW_STATUSLINE_ACTIVE = fix.origActive;
  else delete process.env.HIVE_FLOW_STATUSLINE_ACTIVE;
  if (fix.origTerm !== undefined) process.env.TERM = fix.origTerm;
  else delete process.env.TERM;
}

/**
 * Write a synthetic snapshot to `<projectRoot>/.hive-flow/state/cache.json`.
 * The `generatedAt` defaults to "now" so the snapshot is fresh; pass an
 * older ISO string to simulate a stale cache.
 */
function writeSnapshot(projectRoot: string, overrides: Partial<StatuslineSnapshotV1> = {}): StatuslineSnapshotV1 {
  mkdirSync(join(projectRoot, '.hive-flow', 'state'), { recursive: true });
  const generatedAt = overrides.generatedAt ?? new Date().toISOString();
  const snapshot: StatuslineSnapshotV1 = {
    version: 1,
    projectRoot,
    repoIdentity: overrides.repoIdentity ?? projectRoot,
    displayName: overrides.displayName ?? 'fixture-project',
    projectKey: overrides.projectKey ?? '0123456789abcdef',
    generatedAt,
    sources: overrides.sources ?? {},
    ...(overrides.git !== undefined ? { git: overrides.git } : {}),
    ...(overrides.scoreboard !== undefined ? { scoreboard: overrides.scoreboard } : {}),
    ...(overrides.sessions !== undefined ? { sessions: overrides.sessions } : {}),
    ...(overrides.swarm !== undefined ? { swarm: overrides.swarm } : {}),
    ...(overrides.memory !== undefined ? { memory: overrides.memory } : {}),
    ...(overrides.tests !== undefined ? { tests: overrides.tests } : {}),
    ...(overrides.mcp !== undefined ? { mcp: overrides.mcp } : {}),
    ...(overrides.attention !== undefined ? { attention: overrides.attention } : {}),
    ...(overrides.context !== undefined ? { context: overrides.context } : {}),
    ...(overrides.daemon !== undefined ? { daemon: overrides.daemon } : {}),
    ...(overrides.rendererHints !== undefined ? { rendererHints: overrides.rendererHints } : {}),
  };
  writeFileSync(
    join(projectRoot, '.hive-flow', 'state', 'cache.json'),
    JSON.stringify(snapshot),
    'utf8',
  );
  return snapshot;
}

function writeAgentStore(projectRoot: string, agents: Record<string, Record<string, unknown>>): void {
  mkdirSync(join(projectRoot, '.hive-flow', 'agents'), { recursive: true });
  writeFileSync(
    join(projectRoot, '.hive-flow', 'agents', 'store.json'),
    JSON.stringify({ version: '1.0', agents }),
    'utf8',
  );
}

function liveAgent(
  id: string,
  status: 'busy' | 'idle' = 'busy',
  agentType = 'coder',
): Record<string, unknown> {
  return {
    agentId: id,
    agentType,
    status,
    ownerSessionId: 'session-a',
    currentTaskPid: process.pid,
  };
}

/**
 * Standard Claude Code stdin payload used by most tests.
 */
function stdinPayload(extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    workspace: { current_dir: '', project_dir: '' },
    model: { id: 'claude-opus-4-8[1m]', display_name: 'Opus 4.8' },
    context_window: {
      used_percentage: 45,
      total_input_tokens: 82_000,
      total_output_tokens: 14_000,
      context_window_size: 1_000_000,
    },
    ...extra,
  };
}

// ---------------------------------------------------------------------------
// Suite
// ---------------------------------------------------------------------------

describe('claude-code statusline renderer (Phase 12)', () => {
  let fix: Fixture;

  beforeEach(() => {
    fix = makeFixture();
  });

  afterEach(() => {
    cleanupFixture(fix);
  });

  // -------------------------------------------------------------------------
  // 1. Snapshot mode — happy path
  // -------------------------------------------------------------------------
  it('snapshot mode: pre-populated fresh cache.json drives all rows', async () => {
    writeAgentStore(fix.projectRoot, {
      w1: liveAgent('w1'),
      w2: liveAgent('w2'),
      w3: liveAgent('w3'),
      w4: liveAgent('w4'),
      w5: liveAgent('w5'),
      w6: liveAgent('w6'),
      w7: liveAgent('w7'),
      q1: liveAgent('queen-1', 'busy', 'queen'),
      q2: liveAgent('queen-2', 'idle', 'queen'),
    });
    writeSnapshot(fix.projectRoot, {
      git: { branch: 'main', staged: 2, modified: 1, untracked: 0, ahead: 3, behind: 0 },
      scoreboard: {
        agentsByProvider: { codex: { activeAgents: 3, idleAgents: 0, staleAgents: 0 } },
        callsByProvider: {},
        stale: false,
      },
      swarm: {
        activeAgents: 99,
        idleAgents: 0,
        queuedAgents: 0,
        maxAgents: 150,
        activeQueens: 99,
        executingQueens: 99,
      },
      memory: {
        embeddings: { count: 290, source: 'hivememory', observedAt: new Date().toISOString() },
        memories: { count: 41_100, source: 'hivememory', observedAt: new Date().toISOString() },
        dbSizeBytes: 340_000,
        sourceDescription: 'hivememory',
      },
      tests: {
        suite: {
          version: 1,
          eventId: 'e1',
          ts: new Date().toISOString(),
          repoRoot: fix.projectRoot,
          projectKey: '0123456789abcdef',
          runner: 'vitest',
          kind: 'suite',
          passed: 142,
          failed: 0,
          skipped: 0,
          total: 142,
          producerKind: 'wrapper',
          producerId: 'test',
        },
      },
      mcp: {
        version: 1,
        observedAt: new Date().toISOString(),
        probeVersion: 1,
        source: 'setup-verify-json-rpc',
        total: 7,
        configured: 7,
        runtimeUp: 5,
        state: 'config-present',
      },
      daemon: { running: true, health: 'healthy', observedAt: new Date().toISOString() },
    });

    const output = await renderClaudeCodeStatusline(stdinPayload(), fix.projectRoot);
    const plain = stripAnsi(output);
    expect(plain).toContain('fixture-project');
    expect(plain).toContain('main');
    expect(plain).toContain('Opus 4.8');
    expect(plain).toContain('45% ctx');
    expect(plain).toContain('Swarm');
    expect(plain).toMatch(/\[\s*7\/150\]/);
    expect(plain).toContain('♛2');
    expect(plain).toContain('Memory');
    expect(plain).toContain('Embeddings 290');
    expect(plain).toContain('Tests');
    expect(plain).toContain('142');
    expect(plain).toMatch(/MCP\s+5\/7/);
    expect(plain).toContain('daemon on');
    expect(plain).toContain('Codex');
  });

  it('swarm slot displays live spawned agents, not executing-only agents, without redundant detail text', async () => {
    writeAgentStore(fix.projectRoot, {
      w1: liveAgent('w1', 'idle'),
      w2: liveAgent('w2', 'idle'),
      w3: liveAgent('w3', 'idle'),
      w4: liveAgent('w4', 'idle'),
      w5: liveAgent('w5', 'idle'),
    });
    writeSnapshot(fix.projectRoot, {
      swarm: {
        activeAgents: 0,
        idleAgents: 5,
        queuedAgents: 0,
        maxAgents: 150,
        activeQueens: 0,
        executingQueens: 0,
      },
      rendererHints: {
        activeAgentDetail: 'off',
        useRoleIcons: false,
        allow16ColorYellowFallback: false,
        openRouterBreakdown: 'aggregate',
      },
      daemon: { running: true, health: 'healthy', observedAt: new Date().toISOString() },
    });

    const output = await renderClaudeCodeStatusline(stdinPayload(), fix.projectRoot);
    const plain = stripAnsi(output);
    expect(plain).toContain('Swarm');
    // idle-only swarm (activeAgents=0, total=5) => hollow ○ indicator (teal), not filled ◉.
    expect(plain).toContain('Swarm ○');
    expect(plain).not.toContain('Swarm ◉');
    expect(plain).toMatch(/\[\s*5\/150\]/);
    expect(plain).not.toMatch(/\[\s*0\/150\]/);
    expect(plain).not.toContain('agents off');
  });

  it('fresh cache cannot render a stale Swarm row without current live process evidence', async () => {
    writeAgentStore(fix.projectRoot, {
      ownerless: {
        agentId: 'ownerless',
        agentType: 'tester',
        status: 'busy',
        currentTaskPid: process.pid,
      },
      noPid: {
        agentId: 'no-pid',
        agentType: 'tester',
        status: 'busy',
        ownerSessionId: 'session-a',
      },
    });
    writeSnapshot(fix.projectRoot, {
      swarm: {
        activeAgents: 1,
        idleAgents: 0,
        queuedAgents: 0,
        maxAgents: 150,
        activeQueens: 0,
        executingQueens: 0,
      },
    });

    const output = await renderClaudeCodeStatusline(stdinPayload(), fix.projectRoot);
    const plain = stripAnsi(output);

    expect(plain).not.toContain('Swarm');
  });

  it('snapshot mode reads sessions instead of treating them as dead cache data', async () => {
    writeSnapshot(fix.projectRoot, {
      sessions: {
        active: 2,
        degraded: 0,
        stale: 0,
        byHost: {},
      },
    });

    const output = await renderClaudeCodeStatusline(stdinPayload(), fix.projectRoot);
    const plain = stripAnsi(output);
    expect(plain).toMatch(/Sessions\s+2/);
  });

  it('inline merge does not render stale cached sessions under a fresh timestamp', async () => {
    writeSnapshot(fix.projectRoot, {
      generatedAt: '2020-01-01T00:00:00.000Z',
      sessions: {
        active: 2,
        degraded: 0,
        stale: 0,
        byHost: {},
      },
    });

    const output = await renderClaudeCodeStatusline(stdinPayload(), fix.projectRoot);
    const plain = stripAnsi(output);

    expect(plain).not.toMatch(/Sessions\s+2/);
    expect(plain).toContain('data fresh');
  });

  it('snapshot mode falls back to the global project/session cache from a non-project cwd', async () => {
    const launchCwd = mkdtempSync(join(tmpdir(), 'hf-render-launch-'));
    try {
      const scope = resolveProjectScope({ cwd: fix.projectRoot });
      const sessionId = 'claude-global-session-a';
      const sessionKey = sessionKeyFor({ session_id: sessionId, client_kind: 'claude-code' }, {});
      const cachePath = join(
        fix.home,
        'statusline',
        'projects',
        scope.projectKey,
        'sessions',
        sessionKey,
        'state',
        'cache.json',
      );
      mkdirSync(dirname(cachePath), { recursive: true });

      const snapshot: StatuslineSnapshotV1 = {
        version: 1,
        projectRoot: fix.projectRoot,
        repoIdentity: scope.repoIdentity,
        displayName: 'global-index-project',
        projectKey: scope.projectKey,
        generatedAt: new Date().toISOString(),
        sources: {},
        scoreboard: {
          agentsByProvider: { codex: { activeAgents: 2, idleAgents: 0, staleAgents: 0 } },
          callsByProvider: {},
          stale: false,
        },
        swarm: {
          activeAgents: 3,
          idleAgents: 0,
          queuedAgents: 0,
          maxAgents: 150,
          activeQueens: 0,
          executingQueens: 0,
        },
      };
      writeAgentStore(fix.projectRoot, {
        w1: liveAgent('w1'),
        w2: liveAgent('w2'),
        w3: liveAgent('w3'),
      });
      writeFileSync(cachePath, JSON.stringify(snapshot), 'utf8');

      const origCwd = process.cwd();
      process.chdir(launchCwd);
      try {
        const output = await renderClaudeCodeStatusline(stdinPayload({
          session_id: sessionId,
          client_kind: 'claude-code',
          workspace: { current_dir: fix.projectRoot, project_dir: fix.projectRoot },
        }));
        const plain = stripAnsi(output);
        expect(plain).toContain('global-index-project');
        expect(plain).toContain('Codex 2');
        expect(plain).toContain('Swarm');
        expect(plain).toMatch(/\[\s*3\/150\]/);
      } finally {
        process.chdir(origCwd);
      }
    } finally {
      rmSync(launchCwd, { recursive: true, force: true });
    }
  });

  // -------------------------------------------------------------------------
  // 2. Inline-collector mode — no cache, `.hive-flow/` exists, store.json
  // present, real agents
  // -------------------------------------------------------------------------
  it('inline-collector mode: no cache but .hive-flow/ exists -> inline collector runs', async () => {
    mkdirSync(join(fix.projectRoot, '.hive-flow', 'agents'), { recursive: true });
    writeFileSync(
      join(fix.projectRoot, '.hive-flow', 'agents', 'store.json'),
      JSON.stringify({
        version: '1.0',
        agents: {
          w1: {
            agentId: 'W1',
            agentType: 'coder',
            status: 'busy',
            ownerSessionId: 'session-a',
            currentTaskPid: process.pid,
          },
          q1: {
            agentId: 'Q1',
            agentType: 'queen',
            status: 'idle',
            ownerSessionId: 'session-a',
            currentTaskPid: process.pid,
          },
        },
      }),
      'utf8',
    );

    // The pure renderer is side-effect-free; the WRAPPER (bin/statusline.js,
    // commands/statusline.ts) persists the last-render mirror. We mirror that
    // wrapper contract here via `renderAndPersist` so the test exercises the
    // SAME write path production runs.
    const { rendered } = await renderAndPersist(stdinPayload({ session_id: 'session-a' }), fix.projectRoot);
    const plain = stripAnsi(rendered);
    // The inline-collector populates swarm; we expect it to render.
    expect(plain).toContain('Swarm');
    expect(plain).toContain('Opus 4.8');

    // Mode must be `inline-collector` in the last-render record.
    // We don't know the projectKey ahead of time (project scope derives it).
    // Read via the global mirror current pointer instead.
    const { readLastRenderViaCurrentPointer } = await import('../last-render.js');
    const record = await readLastRenderViaCurrentPointer({ env: { HIVE_FLOW_HOME: fix.home } });
    expect(record).toBeDefined();
    expect(record?.mode).toBe('inline-collector');
  });

  it('inline-collector mode renders all owned live agents regardless of stdin session', async () => {
    mkdirSync(join(fix.projectRoot, '.hive-flow', 'agents'), { recursive: true });
    writeFileSync(
      join(fix.projectRoot, '.hive-flow', 'agents', 'store.json'),
      JSON.stringify({
        version: '1.0',
        agents: {
          mine: {
            agentId: 'mine',
            agentType: 'coder',
            status: 'busy',
            ownerSessionId: 'session-a',
            currentTaskPid: process.pid,
          },
          other: {
            agentId: 'other',
            agentType: 'coder',
            status: 'busy',
            ownerSessionId: 'session-b',
            currentTaskPid: process.pid,
          },
          unowned: {
            agentId: 'unowned',
            agentType: 'tester',
            status: 'busy',
            currentTaskPid: process.pid,
          },
          emptyOwner: {
            agentId: 'empty-owner',
            agentType: 'tester',
            status: 'busy',
            ownerSessionId: '',
            currentTaskPid: process.pid,
          },
          nullOwner: {
            agentId: 'null-owner',
            agentType: 'tester',
            status: 'busy',
            ownerSessionId: null,
            currentTaskPid: process.pid,
          },
        },
      }),
      'utf8',
    );

    const output = await renderClaudeCodeStatusline(
      stdinPayload({ session_id: 'session-a' }),
      fix.projectRoot,
    );
    const plain = stripAnsi(output);

    expect(plain).toContain('Swarm ◉');
    expect(plain).not.toContain('Swarm ○');
    expect(plain).toMatch(/\[\s*2\/150\]/);
    expect(plain).not.toMatch(/\[\s*1\/150\]/);
    expect(plain).not.toMatch(/\[\s*5\/150\]/);
    expect(plain).not.toContain('unowned');
  });

  // -------------------------------------------------------------------------
  // 3. Header-only mode — no `.hive-flow/`
  // -------------------------------------------------------------------------
  it('header-only mode: no .hive-flow/ directory -> only project + git + model rendered', async () => {
    // Wrapper-contract path: pure renderer + writeLastRender persistence.
    const { rendered } = await renderAndPersist(stdinPayload(), fix.projectRoot);
    const plain = stripAnsi(rendered);
    expect(plain).toContain('Opus 4.8');
    expect(plain).toContain('45% ctx');
    // No swarm / memory / scoreboard rows.
    expect(plain).not.toContain('Swarm');
    expect(plain).not.toContain('Memory');
    expect(plain).not.toContain('🪪');
    expect(plain).not.toContain('📊');

    const { readLastRenderViaCurrentPointer } = await import('../last-render.js');
    const record = await readLastRenderViaCurrentPointer({ env: { HIVE_FLOW_HOME: fix.home } });
    expect(record).toBeDefined();
    expect(record?.mode).toBe('header-only');
  });

  // -------------------------------------------------------------------------
  // 4. Mode resolution: last-render.json mode matches actual mode
  // -------------------------------------------------------------------------
  it('mode resolution: snapshot path writes mode=snapshot to last-render', async () => {
    writeSnapshot(fix.projectRoot, {
      daemon: { running: true, health: 'healthy', observedAt: new Date().toISOString() },
    });
    // Wrapper-contract path: pure renderer + writeLastRender persistence.
    await renderAndPersist(stdinPayload(), fix.projectRoot);
    const { readLastRenderViaCurrentPointer } = await import('../last-render.js');
    const record = await readLastRenderViaCurrentPointer({ env: { HIVE_FLOW_HOME: fix.home } });
    expect(record).toBeDefined();
    expect(record?.mode).toBe('snapshot');
    expect(typeof record?.rendered).toBe('string');
  });

  // -------------------------------------------------------------------------
  // 5. <200ms render budget — concrete assertion (Codex round-5 must-have)
  // -------------------------------------------------------------------------
  it('render budget: completes well under 200ms in all three modes', async () => {
    // Snapshot mode
    writeSnapshot(fix.projectRoot, {
      daemon: { running: true, health: 'healthy', observedAt: new Date().toISOString() },
    });
    const snapStart = performance.now();
    await renderClaudeCodeStatusline(stdinPayload(), fix.projectRoot);
    const snapElapsed = performance.now() - snapStart;
    expect(snapElapsed).toBeLessThan(200);

    // Header-only mode (clean project)
    const cleanProj = mkdtempSync(join(tmpdir(), 'hf-render-budget-'));
    try {
      const headerStart = performance.now();
      await renderClaudeCodeStatusline(stdinPayload(), cleanProj);
      const headerElapsed = performance.now() - headerStart;
      expect(headerElapsed).toBeLessThan(200);
    } finally {
      rmSync(cleanProj, { recursive: true, force: true });
    }

    // Inline-collector mode
    const inlineProj = mkdtempSync(join(tmpdir(), 'hf-render-inline-'));
    try {
      mkdirSync(join(inlineProj, '.hive-flow', 'agents'), { recursive: true });
      writeFileSync(
        join(inlineProj, '.hive-flow', 'agents', 'store.json'),
        JSON.stringify({ agents: {} }),
        'utf8',
      );
      const inlineStart = performance.now();
      await renderClaudeCodeStatusline(stdinPayload(), inlineProj);
      const inlineElapsed = performance.now() - inlineStart;
      expect(inlineElapsed).toBeLessThan(200);
    } finally {
      rmSync(inlineProj, { recursive: true, force: true });
    }
  });

  // -------------------------------------------------------------------------
  // 6. NO bright-yellow CSI body in any rendering path / palette config
  // -------------------------------------------------------------------------
  it('no \\x1b[1;33m anywhere — across modes + palette variants', async () => {
    const forbidden = '\x1b[' + '1;' + '33m';

    // Snapshot mode under 256-color (default for the suite)
    writeSnapshot(fix.projectRoot, {
      daemon: { running: true, health: 'healthy', observedAt: new Date().toISOString() },
      rendererHints: {
        activeAgentDetail: 'on',
        useRoleIcons: true,
        allow16ColorYellowFallback: true,
        openRouterBreakdown: 'aggregate',
      },
    });
    let output = await renderClaudeCodeStatusline(stdinPayload(), fix.projectRoot);
    expect(output).not.toContain(forbidden);

    // Header-only under 256-color
    const cleanProj = mkdtempSync(join(tmpdir(), 'hf-render-noyel-'));
    try {
      output = await renderClaudeCodeStatusline(stdinPayload(), cleanProj);
      expect(output).not.toContain(forbidden);
    } finally {
      rmSync(cleanProj, { recursive: true, force: true });
    }

    // 16-color terminal with allow16ColorYellowFallback=true
    delete process.env.FORCE_COLOR;
    process.env.TERM = 'xterm';
    const proj16 = mkdtempSync(join(tmpdir(), 'hf-render-16-'));
    try {
      writeSnapshot(proj16, {
        rendererHints: {
          activeAgentDetail: 'off',
          useRoleIcons: false,
          allow16ColorYellowFallback: true,
          openRouterBreakdown: 'aggregate',
        },
      });
      // Configure project to opt-in to the yellow fallback via config file too
      mkdirSync(join(proj16, '.hive-flow'), { recursive: true });
      writeFileSync(
        join(proj16, '.hive-flow', 'statusline.config.json'),
        JSON.stringify({ allow16ColorYellowFallback: true }),
        'utf8',
      );
      output = await renderClaudeCodeStatusline(stdinPayload(), proj16);
      expect(output).not.toContain(forbidden);
    } finally {
      rmSync(proj16, { recursive: true, force: true });
    }

    // NO_COLOR mode
    process.env.NO_COLOR = '1';
    const projNoColor = mkdtempSync(join(tmpdir(), 'hf-render-noc-'));
    try {
      output = await renderClaudeCodeStatusline(stdinPayload(), projNoColor);
      expect(output).not.toContain(forbidden);
    } finally {
      rmSync(projNoColor, { recursive: true, force: true });
    }
  });

  // -------------------------------------------------------------------------
  // 7. writeLastRender is called with correct mode + projectKey + snapshot
  // -------------------------------------------------------------------------
  it('writeLastRender receives mode + projectKey + snapshot for snapshot mode', async () => {
    const snapshot = writeSnapshot(fix.projectRoot, {
      daemon: { running: true, health: 'healthy', observedAt: new Date().toISOString() },
    });
    // Wrapper-contract path: pure renderer + writeLastRender persistence.
    await renderAndPersist(stdinPayload(), fix.projectRoot);

    const { readLastRenderViaCurrentPointer } = await import('../last-render.js');
    const record = await readLastRenderViaCurrentPointer({ env: { HIVE_FLOW_HOME: fix.home } });
    expect(record).toBeDefined();
    expect(record?.mode).toBe('snapshot');
    // The persisted projectKey must be 16-char lowercase hex (matches scope).
    expect(record?.projectKey).toMatch(/^[0-9a-f]{16}$/);
    // The snapshot payload round-tripped through writeLastRender.
    expect(record?.snapshot?.version).toBe(1);
    expect(record?.snapshot?.daemon?.running).toBe(true);
    void snapshot;
  });

  // -------------------------------------------------------------------------
  // 8. Failure path: corrupted cache.json falls back to inline-collector
  // -------------------------------------------------------------------------
  it('failure path: corrupted cache.json -> inline-collector mode (no crash)', async () => {
    mkdirSync(join(fix.projectRoot, '.hive-flow', 'state'), { recursive: true });
    mkdirSync(join(fix.projectRoot, '.hive-flow', 'agents'), { recursive: true });
    // Write a garbage cache.json
    writeFileSync(
      join(fix.projectRoot, '.hive-flow', 'state', 'cache.json'),
      '{not valid json}',
      'utf8',
    );
    // Write a minimal store.json so the inline collector has data
    writeFileSync(
      join(fix.projectRoot, '.hive-flow', 'agents', 'store.json'),
      JSON.stringify({ agents: { w1: { agentId: 'W1', agentType: 'coder', status: 'idle' } } }),
      'utf8',
    );

    // Wrapper-contract path: pure renderer + writeLastRender persistence.
    const { rendered } = await renderAndPersist(stdinPayload(), fix.projectRoot);
    expect(rendered).toBeTruthy();
    const { readLastRenderViaCurrentPointer } = await import('../last-render.js');
    const record = await readLastRenderViaCurrentPointer({ env: { HIVE_FLOW_HOME: fix.home } });
    expect(record).toBeDefined();
    // Corrupt cache + .hive-flow/ present => inline-collector
    expect(record?.mode).toBe('inline-collector');
  });

  // -------------------------------------------------------------------------
  // 9. Failure path: corrupted stdin renders with defaults
  // -------------------------------------------------------------------------
  it('failure path: corrupted stdin -> renders with cwd defaults (no crash)', async () => {
    // Pass a totally garbage stdin payload (string that is not JSON).
    const garbage = 'this-is-not-json';
    const output = await renderClaudeCodeStatusline(garbage, fix.projectRoot);
    expect(typeof output).toBe('string');
    // Should not crash; produces at least the project anchor.
    const plain = stripAnsi(output);
    expect(plain.length).toBeGreaterThan(0);
    // Pass an array (non-object) — narrowed to undefined.
    const output2 = await renderClaudeCodeStatusline([1, 2, 3], fix.projectRoot);
    expect(typeof output2).toBe('string');
  });

  // -------------------------------------------------------------------------
  // 10. NO_COLOR=1 -> render contains zero ANSI escapes
  // -------------------------------------------------------------------------
  it('NO_COLOR=1 -> render contains zero ANSI escapes', async () => {
    process.env.NO_COLOR = '1';
    writeSnapshot(fix.projectRoot, {
      git: { branch: 'main', staged: 1, modified: 0, untracked: 0, ahead: 0, behind: 0 },
      daemon: { running: true, health: 'healthy', observedAt: new Date().toISOString() },
    });
    const output = await renderClaudeCodeStatusline(stdinPayload(), fix.projectRoot);
    // Zero ANSI sequences in the output.
    // eslint-disable-next-line no-control-regex
    expect(output.match(/\x1b\[/g)).toBeNull();
    expect(output).toContain('main');
    expect(output).toContain('Opus 4.8');
  });

  // -------------------------------------------------------------------------
  // 11. Locked visual design — required color codes present
  // -------------------------------------------------------------------------
  it('locked visual design: branch color 1;34 and project anchor 1;38;5;253 present', async () => {
    writeSnapshot(fix.projectRoot, {
      git: { branch: 'main', staged: 0, modified: 0, untracked: 0, ahead: 0, behind: 0 },
      daemon: { running: true, health: 'healthy', observedAt: new Date().toISOString() },
    });
    const output = await renderClaudeCodeStatusline(stdinPayload(), fix.projectRoot);
    // Project anchor (bold light gray) — 256-color path.
    expect(output).toContain('\x1b[1;38;5;253m');
    // Git branch (bright blue) — single owner.
    expect(output).toContain('\x1b[1;34m');
  });

  // -------------------------------------------------------------------------
  // 12. Render output is a MULTI-ROW box (documented layout) — header /
  //     separator rule / body rows (scoreboard / swarm / memory / attention) /
  //     separator rule / footer, joined by '\n'.
  //     Source of truth: .audit/research-line-color/
  //     Claude-statusline-design-final-2026-05-20.md §2-§3.
  // -------------------------------------------------------------------------
  it('render output is the documented multi-row box (newlines + separator rules + ordered rows)', async () => {
    writeAgentStore(fix.projectRoot, {
      w1: liveAgent('w1'),
      w2: liveAgent('w2'),
      w3: liveAgent('w3'),
      w4: liveAgent('w4'),
      w5: liveAgent('w5'),
      q1: liveAgent('queen-1', 'busy', 'queen'),
    });
    writeSnapshot(fix.projectRoot, {
      git: { branch: 'main', staged: 0, modified: 0, untracked: 0, ahead: 0, behind: 0 },
      scoreboard: {
        agentsByProvider: { claude: { activeAgents: 5, idleAgents: 0, staleAgents: 0, models: { Opus: 5 } } },
        callsByProvider: {},
        stale: false,
      },
      swarm: {
        activeAgents: 5, idleAgents: 0, queuedAgents: 0, maxAgents: 150,
        activeQueens: 1, executingQueens: 1,
      },
      memory: {
        embeddings: { count: 100, source: 's', observedAt: new Date().toISOString() },
        memories: { count: 5000, source: 's', observedAt: new Date().toISOString() },
        dbSizeBytes: 500_000,
        sourceDescription: 's',
      },
      attention: {
        unresolved: [
          { id: 'a1', ts: new Date().toISOString(), severity: 'critical', source: 'gate', message: 'permission required', redacted: false, ageSeconds: 3 },
        ],
      },
      daemon: { running: true, health: 'healthy', observedAt: new Date().toISOString() },
    });
    const output = await renderClaudeCodeStatusline(stdinPayload(), fix.projectRoot);

    // Multi-line output (no longer collapsed to a single line).
    expect(output.includes('\n')).toBe(true);
    // No carriage returns — rows are joined by '\n' only.
    expect(output.includes('\r')).toBe(false);

    const plainLines = stripAnsi(output).split('\n');
    // Header + 2 separator rules + 4 body rows + footer = 8 rows for this
    // fully-populated fixture.
    expect(plainLines.length).toBe(8);

    // Row 0 = header (project anchor + branch + model + ctx).
    expect(plainLines[0]).toContain('fixture-project');
    expect(plainLines[0]).toContain('main');
    expect(plainLines[0]).toContain('Opus 4.8');

    // Two full-width separator rules (box-drawing '─') are present, one after
    // the header and one before the footer.
    const ruleLines = plainLines.filter((l) => /^─+$/.test(l));
    expect(ruleLines.length).toBe(2);

    // Body rows appear in the documented order: scoreboard -> swarm ->
    // memory -> attention.
    const scoreboardIdx = plainLines.findIndex((l) => l.includes('🤖'));
    const swarmIdx = plainLines.findIndex((l) => l.includes('Swarm'));
    const memoryIdx = plainLines.findIndex((l) => l.includes('Memory'));
    const attentionIdx = plainLines.findIndex((l) => l.includes('attention'));
    const footerIdx = plainLines.findIndex((l) => l.includes('daemon on'));
    expect(scoreboardIdx).toBeGreaterThan(0);
    expect(swarmIdx).toBeGreaterThan(scoreboardIdx);
    expect(memoryIdx).toBeGreaterThan(swarmIdx);
    expect(attentionIdx).toBeGreaterThan(memoryIdx);
    // Footer is the last row, after the second separator rule.
    expect(footerIdx).toBe(plainLines.length - 1);
  });

  it('header-only project renders header plus enforcement-off footer when the engine is missing', async () => {
    // No .hive-flow/ -> header-only mode. The collapse rule: no body rows ->
    // no separator rules. The persistent enforcement-installed signal still
    // renders a loud footer when the relocated engine is missing.
    const cleanProj = mkdtempSync(join(tmpdir(), 'hf-render-header-only-'));
    try {
      const output = await renderClaudeCodeStatusline(stdinPayload(), cleanProj);
      const plainLines = stripAnsi(output).split('\n');
      expect(plainLines.length).toBe(2);
      expect(plainLines[0]).toContain('Opus 4.8');
      expect(plainLines[1]).toContain('ENFORCEMENT OFF');
      // No separator rules when there are no body rows.
      expect(output).not.toMatch(/─+/);
    } finally {
      rmSync(cleanProj, { recursive: true, force: true });
    }
  });

  // -------------------------------------------------------------------------
  // 13. Hot-path integrity: renderer source contains no shell-outs etc.
  // -------------------------------------------------------------------------
  it('hot-path integrity: renderer source has no shell-outs / sync I/O / TODO markers', async () => {
    const source = readFileSync(
      join(__dirname, '..', 'claude-code-renderer.ts'),
      'utf8',
    );
    // Drop comments before substring scans so we only check live code.
    const code = source
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/\/\/.*$/gm, '');
    // No du -sh, no gh pr, no execSync, no synchronous readFileSync.
    expect(code).not.toMatch(/du\s+-sh/);
    expect(code).not.toMatch(/gh\s+pr/);
    expect(code).not.toMatch(/\bexecSync\b/);
    expect(code).not.toMatch(/\bspawnSync\b/);
    expect(code).not.toMatch(/\breadFileSync\b/);
    // No TODO / FIXME / XXX / HACK markers.
    expect(code).not.toMatch(/TODO|FIXME|XXX|HACK/);
    // No `as any` casts.
    expect(code).not.toMatch(/\bas\s+any\b/);
    // No literal bright-yellow CSI body. Source uses the FORBIDDEN constant by
    // name (via types.ts) but the raw byte sequence must not appear here.
    // eslint-disable-next-line no-control-regex
    expect(code).not.toMatch(/\x1b\[1;33m/);
  });

  // -------------------------------------------------------------------------
  // 14. Patch B regression — OpenRouter aggregate (default) collapses to a
  //     single token with the combined call count; no per-model split.
  // -------------------------------------------------------------------------
  it('patch B: OpenRouter defaults to aggregate (single token, no per-model split)', async () => {
    writeSnapshot(fix.projectRoot, {
      scoreboard: {
        agentsByProvider: {
          openrouter: {
            activeAgents: 3,
            idleAgents: 0,
            staleAgents: 0,
            models: { grok: 2, mimo: 1 },
          },
        },
        callsByProvider: {},
        stale: false,
      },
      daemon: { running: true, health: 'healthy', observedAt: new Date().toISOString() },
      // No rendererHints → openRouterBreakdown defaults to 'aggregate'.
    });
    const output = await renderClaudeCodeStatusline(stdinPayload(), fix.projectRoot);
    const plain = stripAnsi(output);
    // Single token with combined count (3 active agents).
    expect(plain).toContain('OpenRouter 3');
    // NO per-model breakdown.
    expect(plain).not.toContain('grok 2');
    expect(plain).not.toContain('mimo 1');
  });

  it('patch B: OpenRouter aggregate explicit hint also collapses to a single token', async () => {
    writeSnapshot(fix.projectRoot, {
      scoreboard: {
        agentsByProvider: {
          openrouter: {
            activeAgents: 2,
            idleAgents: 1,
            staleAgents: 0,
            models: { grok: 2, minimax: 1 },
          },
        },
        callsByProvider: {},
        stale: false,
      },
      rendererHints: {
        activeAgentDetail: 'off',
        useRoleIcons: false,
        allow16ColorYellowFallback: false,
        openRouterBreakdown: 'aggregate',
      },
      daemon: { running: true, health: 'healthy', observedAt: new Date().toISOString() },
    });
    const output = await renderClaudeCodeStatusline(stdinPayload(), fix.projectRoot);
    const plain = stripAnsi(output);
    expect(plain).toContain('OpenRouter 3'); // 2 active + 1 idle = 3.
    expect(plain).not.toContain('grok 2');
    expect(plain).not.toContain('minimax 1');
  });

  it('colors provider agent counts green only for active agents and orange for idle-only spawned agents', async () => {
    writeSnapshot(fix.projectRoot, {
      scoreboard: {
        agentsByProvider: {
          codex: {
            activeAgents: 1,
            idleAgents: 2,
            staleAgents: 0,
          },
          openrouter: {
            activeAgents: 0,
            idleAgents: 3,
            staleAgents: 0,
          },
        },
        callsByProvider: {},
        stale: false,
      },
      daemon: { running: true, health: 'healthy', observedAt: new Date().toISOString() },
    });

    const output = await renderClaudeCodeStatusline(stdinPayload(), fix.projectRoot);
    const plain = stripAnsi(output);
    expect(plain).toContain('Codex 3');
    expect(plain).toContain('OpenRouter 3');
    expect(output).toMatch(/Codex\x1b\[0m \x1b\[1;32m3\x1b\[0m/);
    expect(output).toMatch(/OpenRouter\x1b\[0m \x1b\[38;5;208m3\x1b\[0m/);
  });

  // -------------------------------------------------------------------------
  // 15. Patch B regression — `openRouterBreakdown: 'model'` opts INTO the
  //     per-model split. Claude is unaffected (always model-split when
  //     models present).
  // -------------------------------------------------------------------------
  it('patch B: OpenRouter `model` mode emits per-model breakdown', async () => {
    writeSnapshot(fix.projectRoot, {
      scoreboard: {
        agentsByProvider: {
          openrouter: {
            activeAgents: 2,
            idleAgents: 1,
            staleAgents: 0,
            models: { grok: 2, mimo: 1 },
          },
        },
        callsByProvider: {},
        stale: false,
      },
      rendererHints: {
        activeAgentDetail: 'off',
        useRoleIcons: false,
        allow16ColorYellowFallback: false,
        openRouterBreakdown: 'model',
      },
      daemon: { running: true, health: 'healthy', observedAt: new Date().toISOString() },
    });
    const output = await renderClaudeCodeStatusline(stdinPayload(), fix.projectRoot);
    const plain = stripAnsi(output);
    // Per-model parts present.
    expect(plain).toContain('grok 2');
    expect(plain).toContain('mimo 1');
    // The aggregate "OpenRouter <total>" form must NOT appear when per-model
    // breakdown is on (the token is `OpenRouter grok 2 · mimo 1` instead).
    expect(plain).not.toMatch(/OpenRouter\s+3(\s|$)/);
  });

  it('patch B: Claude is unaffected by openRouterBreakdown (always model-split)', async () => {
    writeSnapshot(fix.projectRoot, {
      scoreboard: {
        agentsByProvider: {
          claude: {
            activeAgents: 4,
            idleAgents: 0,
            staleAgents: 0,
            models: { Opus: 3, Sonnet: 1 },
          },
        },
        callsByProvider: {},
        stale: false,
      },
      rendererHints: {
        activeAgentDetail: 'off',
        useRoleIcons: false,
        allow16ColorYellowFallback: false,
        openRouterBreakdown: 'aggregate',
      },
      daemon: { running: true, health: 'healthy', observedAt: new Date().toISOString() },
    });
    const output = await renderClaudeCodeStatusline(stdinPayload(), fix.projectRoot);
    const plain = stripAnsi(output);
    // Claude shows per-model breakdown regardless of openRouterBreakdown.
    expect(plain).toContain('Opus 3');
    expect(plain).toContain('Sonnet 1');
  });

  // -------------------------------------------------------------------------
  // 16. Patch C regression — terminal agents dropped from the Active row.
  //     `normalizeAgentStatus` returns `undefined` for terminated/failed/
  //     complete/cancelled; the renderer must filter them out, NOT fall
  //     back to 'stale'.
  // -------------------------------------------------------------------------
  it('patch C: terminal agents (terminated/failed/complete/cancelled) are dropped from Active row', async () => {
    writeAgentStore(fix.projectRoot, {
      w1: liveAgent('W1', 'busy'),
      w2: {
        agentId: 'W2',
        agentType: 'coder',
        status: 'terminated',
        ownerSessionId: 'session-a',
        currentTaskPid: process.pid,
      },
      w3: {
        agentId: 'W3',
        agentType: 'tester',
        status: 'failed',
        ownerSessionId: 'session-a',
        currentTaskPid: process.pid,
      },
      w4: {
        agentId: 'W4',
        agentType: 'reviewer',
        status: 'complete',
        ownerSessionId: 'session-a',
        currentTaskPid: process.pid,
      },
      w5: {
        agentId: 'W5',
        agentType: 'analyst',
        status: 'cancelled',
        ownerSessionId: 'session-a',
        currentTaskPid: process.pid,
      },
    });
    writeSnapshot(fix.projectRoot, {
      swarm: {
        activeAgents: 1,
        idleAgents: 0,
        queuedAgents: 0,
        maxAgents: 150,
        activeQueens: 0,
        executingQueens: 0,
        agents: [
          // Live agent — must render.
          {
            id: 'W1',
            role: 'coder',
            status: 'busy' as never,
          },
          // Terminal agents — must be filtered out entirely.
          {
            id: 'W2',
            role: 'coder',
            status: 'terminated' as never,
          },
          {
            id: 'W3',
            role: 'tester',
            status: 'failed' as never,
          },
          {
            id: 'W4',
            role: 'reviewer',
            status: 'complete' as never,
          },
          {
            id: 'W5',
            role: 'analyst',
            status: 'cancelled' as never,
          },
        ],
      },
      rendererHints: {
        activeAgentDetail: 'on',
        useRoleIcons: false,
        allow16ColorYellowFallback: false,
        openRouterBreakdown: 'aggregate',
      },
      daemon: { running: true, health: 'healthy', observedAt: new Date().toISOString() },
    });
    const output = await renderClaudeCodeStatusline(stdinPayload(), fix.projectRoot);
    const plain = stripAnsi(output);
    // The live busy agent appears.
    expect(plain).toContain('W1');
    // Terminal agents are DROPPED — neither their IDs nor a 'stale' fallback
    // should appear in the Active row.
    expect(plain).not.toContain('W2');
    expect(plain).not.toContain('W3');
    expect(plain).not.toContain('W4');
    expect(plain).not.toContain('W5');
    // Explicit: no 'terminated' / 'failed' / 'complete' / 'cancelled' words
    // and no 'stale' fallback resurrection.
    expect(plain).not.toContain('terminated');
    expect(plain).not.toContain('failed');
    expect(plain).not.toContain('complete');
    expect(plain).not.toContain('cancelled');
  });

  it('patch C: terminal-only swarm yields no Active row (filter removes ALL agents)', async () => {
    writeSnapshot(fix.projectRoot, {
      swarm: {
        activeAgents: 0,
        idleAgents: 0,
        queuedAgents: 0,
        maxAgents: 150,
        activeQueens: 1,
        executingQueens: 0,
        agents: [
          {
            id: 'W1',
            role: 'coder',
            status: 'terminated' as never,
          },
          {
            id: 'W2',
            role: 'tester',
            status: 'failed' as never,
          },
        ],
      },
      rendererHints: {
        activeAgentDetail: 'on',
        useRoleIcons: false,
        allow16ColorYellowFallback: false,
        openRouterBreakdown: 'aggregate',
      },
      daemon: { running: true, health: 'healthy', observedAt: new Date().toISOString() },
    });
    const output = await renderClaudeCodeStatusline(stdinPayload(), fix.projectRoot);
    const plain = stripAnsi(output);
    // No Active row marker (🜁) because all rows were filtered out.
    expect(plain).not.toContain('🜁');
    expect(plain).not.toContain('W1');
    expect(plain).not.toContain('W2');
  });

  // -------------------------------------------------------------------------
  // Helpers (legacy export sanity)
  // -------------------------------------------------------------------------
  it('resolveActiveCwd honours workspace.current_dir override', () => {
    const cwd = resolveActiveCwd({ workspace: { current_dir: '/tmp/explicit' } });
    expect(cwd).toBe('/tmp/explicit');
  });

  it('readStatuslineStdin export is a callable async function', () => {
    // The renderer module preserves the `readStatuslineStdin` export so
    // `bin/statusline.js` and `commands/statusline.ts` continue to compile.
    // We do not actually exercise process.stdin here (vitest leaves it
    // bound to the test runner) — verifying the export shape is enough.
    expect(typeof readStatuslineStdin).toBe('function');
    expect(readStatuslineStdin.constructor.name).toBe('AsyncFunction');
  });
});

// ---------------------------------------------------------------------------
// Type-only: `homedir()` is imported above so any forced fallback in tests
// where HIVE_FLOW_HOME is removed still resolves to a stable directory.
// ---------------------------------------------------------------------------
void homedir;
