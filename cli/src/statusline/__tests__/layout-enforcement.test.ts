// v3/@hive-flow/cli/src/statusline/__tests__/layout-enforcement.test.ts
//
// LAYOUT ENFORCEMENT SUITE — locks the documented multi-row statusline box so
// it can NEVER silently regress. The layout was once collapsed to a single
// line; these tests make that collapse impossible to ship.
//
// Source of truth (the PHYSICAL LAYOUT is non-negotiable):
//   .audit/research-line-color/Claude-statusline-design-final-2026-05-20.md
//   §2 (executive summary board), §3 (row order + per-row format), §4 (palette).
//
// Three enforcement classes (multiple tests each):
//
//   1. GOLDEN / SNAPSHOT — render a canonical full-fixture payload and assert
//      the EXACT multi-row box (row order, separators, segment formats) matches
//      a committed byte-pinned golden of the STRIPPED-ANSI structure, plus a
//      dedicated palette/color assertion so the colour scheme is also pinned.
//      A header-only/minimal fixture golden covers OMIT > FAKE.
//
//   2. ANTI-COLLAPSE GUARD — the specific past regression. Output is ALWAYS
//      multi-line (`includes('\n')`), never flattened to one line, and the
//      renderer source contains no newline-stripping code path.
//
//   3. PROPERTY / INVARIANT — for arbitrary valid snapshots: row order is
//      always header -> ... -> footer; a separator rule appears IFF >=1 body
//      row is present; every present row matches its documented format regex;
//      no fabricated/placeholder data appears (OMIT > FAKE).

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fc from 'fast-check';
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { renderClaudeCodeStatusline } from '../claude-code-renderer.js';
import { statuslinePaths } from '../paths.js';
import type {
  ScoreboardSummary,
  StatuslineSnapshotV1,
  SwarmSummary,
} from '../types.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

// eslint-disable-next-line no-control-regex
const ANSI_RE = /\x1b\[[0-9;]*m/g;
function stripAnsi(value: string): string {
  return value.replace(ANSI_RE, '');
}

// The full-width inter-row rule is 65 box-drawing horizontals (design §2 board).
const RULE = '─'.repeat(65);
const LAYOUT_TEST_SESSION_ID = 'statusline-layout-test-session';

interface Fixture {
  projectRoot: string;
  origNoColor?: string;
  origForce?: string;
  origTerm?: string;
  origHome?: string;
}

function makeFixture(): Fixture {
  const projectRoot = mkdtempSync(join(tmpdir(), 'hf-layout-'));
  const origNoColor = process.env.NO_COLOR;
  const origForce = process.env.FORCE_COLOR;
  const origTerm = process.env.TERM;
  const origHome = process.env.HIVE_FLOW_HOME;
  // 256-color so palette codes appear; redirect HOME so the suite never writes
  // into the real user cache.
  process.env.FORCE_COLOR = '3';
  process.env.TERM = 'xterm-256color';
  delete process.env.NO_COLOR;
  process.env.HIVE_FLOW_HOME = mkdtempSync(join(tmpdir(), 'hf-layout-home-'));
  return {
    projectRoot,
    ...(origNoColor !== undefined ? { origNoColor } : {}),
    ...(origForce !== undefined ? { origForce } : {}),
    ...(origTerm !== undefined ? { origTerm } : {}),
    ...(origHome !== undefined ? { origHome } : {}),
  };
}

function cleanupFixture(fix: Fixture): void {
  try {
    rmSync(fix.projectRoot, { recursive: true, force: true });
  } catch {
    /* best-effort */
  }
  if (process.env.HIVE_FLOW_HOME) {
    try {
      rmSync(process.env.HIVE_FLOW_HOME, { recursive: true, force: true });
    } catch {
      /* best-effort */
    }
  }
  if (fix.origNoColor !== undefined) process.env.NO_COLOR = fix.origNoColor;
  else delete process.env.NO_COLOR;
  if (fix.origForce !== undefined) process.env.FORCE_COLOR = fix.origForce;
  else delete process.env.FORCE_COLOR;
  if (fix.origTerm !== undefined) process.env.TERM = fix.origTerm;
  else delete process.env.TERM;
  if (fix.origHome !== undefined) process.env.HIVE_FLOW_HOME = fix.origHome;
  else delete process.env.HIVE_FLOW_HOME;
}

/**
 * Write a fully-typed snapshot to `<projectRoot>/.hive-flow/state/cache.json`
 * with a fresh `generatedAt` (snapshot mode, deterministic — no git/daemon
 * shell-outs in the hot path).
 */
function writeSnapshot(
  projectRoot: string,
  overrides: Partial<StatuslineSnapshotV1> = {},
): void {
  mkdirSync(join(projectRoot, '.hive-flow', 'state'), { recursive: true });
  const snapshot: StatuslineSnapshotV1 = {
    version: 1,
    projectRoot,
    repoIdentity: overrides.repoIdentity ?? projectRoot,
    displayName: overrides.displayName ?? 'fixture-project',
    projectKey: overrides.projectKey ?? '0123456789abcdef',
    generatedAt: overrides.generatedAt ?? new Date().toISOString(),
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
}

/**
 * The canonical Claude Code stdin payload mirrored from the design doc's
 * "one healthy session" board (§2): Opus 4.8 on a 1M window at 45% context with
 * the documented 82K in / 14K out token split.
 */
function canonicalStdin(): Record<string, unknown> {
  return {
    session_id: LAYOUT_TEST_SESSION_ID,
    workspace: { current_dir: '', project_dir: '' },
    model: { id: 'claude-opus-4-8[1m]', display_name: 'Opus 4.8' },
    context_window: {
      used_percentage: 45,
      total_input_tokens: 82_000,
      total_output_tokens: 14_000,
      context_window_size: 1_000_000,
    },
  };
}

/**
 * The canonical full-fixture snapshot: every body row populated with real data
 * (scoreboard / swarm / memory+tests+mcp / attention) plus a healthy daemon.
 * Mirrors the design doc §2 executive-summary board.
 */
function fullFixtureSnapshot(projectRoot: string): void {
  writeSnapshot(projectRoot, {
    git: { branch: 'main', staged: 2, modified: 3, untracked: 0, ahead: 3, behind: 1 },
    scoreboard: {
      agentsByProvider: {
        claude: { activeAgents: 7, idleAgents: 4, staleAgents: 0, models: { Opus: 7, Sonnet: 4 } },
        codex: { activeAgents: 3, idleAgents: 0, staleAgents: 0 },
      },
      callsByProvider: {},
      stale: false,
    },
    swarm: {
      activeAgents: 7,
      idleAgents: 0,
      queuedAgents: 0,
      maxAgents: 150,
      activeQueens: 2,
      executingQueens: 1,
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
        repoRoot: projectRoot,
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
    attention: {
      unresolved: [
        {
          id: 'a1',
          ts: new Date().toISOString(),
          severity: 'critical',
          source: 'gate',
          message: 'permission required',
          redacted: false,
          ageSeconds: 3,
        },
      ],
    },
    daemon: { running: true, health: 'healthy', observedAt: new Date().toISOString() },
  });
}

function writeJsonFixture(filePath: string, value: unknown): void {
  mkdirSync(join(filePath, '..'), { recursive: true });
  writeFileSync(filePath, JSON.stringify(value), { encoding: 'utf8', mode: 0o600 });
}

function materializedEightRowFixture(projectRoot: string): void {
  const paths = statuslinePaths(projectRoot);
  const observedAt = new Date().toISOString();

  writeJsonFixture(paths.scoreboardCurrent, {
    agentsByProvider: {
      claude: { activeAgents: 7, idleAgents: 4, staleAgents: 0, models: { Opus: 7, Sonnet: 4 } },
      codex: { activeAgents: 3, idleAgents: 0, staleAgents: 0 },
    },
    callsByProvider: {},
    stale: false,
    lastUpdatedAt: observedAt,
  });

  // Busy workers and queens require a positive currentTaskPid to count as
  // executing (phantom-activity fix). process.pid is always alive.
  writeJsonFixture(join(projectRoot, '.hive-flow', 'agents', 'store.json'), {
    version: '1.0',
    agents: Object.fromEntries([
      ...Array.from({ length: 7 }, (_, i) => [
        `worker-${i + 1}`,
        {
          agentId: `worker-${i + 1}`,
          agentType: 'worker',
          status: 'busy',
          provider: 'codex',
          ownerSessionId: LAYOUT_TEST_SESSION_ID,
          currentTaskPid: process.pid,
        },
      ]),
      [
        'queen-1',
        {
          agentId: 'queen-1',
          agentType: 'queen',
          status: 'busy',
          provider: 'claude',
          ownerSessionId: LAYOUT_TEST_SESSION_ID,
          currentTaskPid: process.pid,
        },
      ],
      [
        'queen-2',
        {
          agentId: 'queen-2',
          agentType: 'queen',
          status: 'idle',
          provider: 'claude',
          ownerSessionId: LAYOUT_TEST_SESSION_ID,
          currentTaskPid: process.pid,
        },
      ],
    ]),
  });

  writeJsonFixture(paths.memoryStats, {
    embeddings: { count: 290, source: 'hivememory', observedAt },
    memories: { count: 41_100, source: 'hivememory', observedAt },
    dbSizeBytes: 340_000,
    sourceDescription: 'hivememory',
  });

  writeJsonFixture(paths.testsCurrent, {
    suite: {
      version: 1,
      eventId: 'golden-suite',
      ts: observedAt,
      repoRoot: projectRoot,
      projectKey: '0123456789abcdef',
      runner: 'vitest',
      kind: 'suite',
      passed: 142,
      failed: 0,
      skipped: 0,
      total: 142,
      producerKind: 'wrapper',
      producerId: 'golden',
    },
  });

  writeJsonFixture(paths.mcpHealth, {
    version: 1,
    observedAt,
    probeVersion: 1,
    source: 'setup-verify-json-rpc',
    total: 7,
    configured: 7,
    runtimeUp: 5,
    state: 'config-present',
  });

  writeJsonFixture(paths.attentionCurrent, {
    unresolved: [
      {
        id: 'golden-attention',
        ts: observedAt,
        severity: 'critical',
        source: 'gate',
        message: 'permission required',
        redacted: false,
        ageSeconds: 3,
      },
    ],
  });

  writeJsonFixture(join(projectRoot, '.hive-flow', 'daemon-state.json'), {
    running: true,
    pid: process.pid,
  });
}

// ---------------------------------------------------------------------------
// Suite
// ---------------------------------------------------------------------------

describe('statusline LAYOUT ENFORCEMENT (locked multi-row box)', () => {
  let fix: Fixture;

  beforeEach(() => {
    fix = makeFixture();
  });

  afterEach(() => {
    cleanupFixture(fix);
  });

  // =========================================================================
  // 1. GOLDEN / SNAPSHOT — byte-pin the documented multi-row box structure.
  // =========================================================================

  it('GOLDEN full fixture: stripped-ANSI box is byte-pinned to the documented layout', async () => {
    fullFixtureSnapshot(fix.projectRoot);
    const output = await renderClaudeCodeStatusline(canonicalStdin(), fix.projectRoot);
    const plain = stripAnsi(output);

    // The committed golden — every row, in order, with exact segment formats.
    // Row order (design §3.1): header -> rule -> scoreboard -> swarm -> memory
    // -> attention -> rule -> footer. Separators within rows are `  │  ` and
    // the inter-row rules are 65 box-drawing horizontals.
    const golden = [
      '▊ fixture-project  │  main +2 ~3 ↑3 ↓1  │  Opus 4.8 1M  │  📖 45% ctx · 82000 in/14000 out',
      RULE,
      '🤖 Claude Opus 7 · Sonnet 4  │  Codex 3',
      '🪪 Swarm ◉ [ 7/150]  ♛2',
      '📊 Memory  Embeddings 290  │  Memories 41.1k  │  💾 333KB  │  🧪 Tests 142  │  🔌 MCP 5/7',
      '📌 attention  ! permission required',
      RULE,
      '► ⛔ ENFORCEMENT OFF · daemon on · data fresh 0s',
    ].join('\n');

    expect(plain).toBe(golden);
  });

  it('GOLDEN materialized producers: memory/stats.json and mcp/health.json populate the 8-row box', async () => {
    materializedEightRowFixture(fix.projectRoot);

    const output = await renderClaudeCodeStatusline(canonicalStdin(), fix.projectRoot);
    const plain = stripAnsi(output);
    const lines = plain.split('\n');

    expect(lines.length).toBe(8);
    expect(lines[1]).toBe(RULE);
    expect(lines[6]).toBe(RULE);
    expect(lines[4]).toBe(
      '📊 Memory  Embeddings 290  │  Memories 41.1k  │  💾 333KB  │  🧪 Tests 142  │  🔌 MCP 5/7',
    );
    expect(plain).toContain('🤖 Claude Opus 7 · Sonnet 4  │  Codex 3');
    expect(plain).toContain('🪪 Swarm ◉ [ 7/150]  ♛2');
    expect(plain).toContain('📌 attention  ! permission required');
    expect(plain).toContain('► ⛔ ENFORCEMENT OFF · daemon on · data fresh 0s');
  });

  it('GOLDEN full fixture: palette/colour codes are pinned per element (design §4)', async () => {
    fullFixtureSnapshot(fix.projectRoot);
    const output = await renderClaudeCodeStatusline(canonicalStdin(), fix.projectRoot);

    // Project anchor — bold light gray (single owner of the `▊ <project>` slot).
    expect(output).toContain('\x1b[1;38;5;253m▊ fixture-project');
    // Git branch — bright blue (single owner).
    expect(output).toContain('\x1b[1;34mmain');
    // Staged `+N` bright green; modified `~N` orange; ahead `↑N` bright cyan;
    // behind `↓N` red (design §5.3).
    expect(output).toContain('\x1b[1;32m+2');
    expect(output).toContain('\x1b[38;5;208m~3');
    expect(output).toContain('\x1b[1;36m↑3');
    expect(output).toContain('\x1b[0;31m↓1');
    // Model — magenta.
    expect(output).toContain('\x1b[0;35mOpus 4.8 1M');
    // Context <70% — safe green.
    expect(output).toContain('\x1b[1;32m📖 45% ctx');
    // Inter-row rule — separator colour (256-color = 38;5;240).
    expect(output).toContain(`\x1b[38;5;240m${RULE}`);
    // Executing swarm indicator — bright green `◉`.
    expect(output).toContain('\x1b[1;32m◉');
    // Memory label — teal.
    expect(output).toContain('\x1b[38;5;80mMemory');
    // Embeddings count — violet.
    expect(output).toContain('\x1b[38;5;141m290');
    // daemon on — bright green.
    expect(output).toContain('\x1b[1;32mdaemon on');
    // NEVER bright yellow (structurally forbidden, design §4).
    expect(output).not.toContain('\x1b[1;33m');
  });

  it('GOLDEN minimal fixture (OMIT > FAKE): header-only project renders only header plus enforcement footer', async () => {
    // No `.hive-flow/` -> header-only mode. With no body rows there are NO
    // separator rules. The persistent enforcement-installed signal still
    // renders a loud footer when the relocated engine is missing.
    const output = await renderClaudeCodeStatusline(canonicalStdin(), fix.projectRoot);
    const plain = stripAnsi(output);
    const lines = plain.split('\n');
    const goldenHeader =
      '▊ ' +
      plain.split('  │  ')[0].replace('▊ ', '') + // dynamic basename of the tmp dir
      '  │  Opus 4.8 1M  │  📖 45% ctx · 82000 in/14000 out';
    expect(lines).toEqual([goldenHeader, '► ⛔ ENFORCEMENT OFF']);
    // No fabricated body rows / separators.
    expect(plain).not.toContain('🤖');
    expect(plain).not.toContain('🪪');
    expect(plain).not.toContain('📊');
    expect(plain).not.toContain('📌');
    expect(plain).not.toContain('─');
  });

  it('GOLDEN materialized producers absent (OMIT > FAKE): missing memory/MCP files do not fabricate cells', async () => {
    mkdirSync(join(fix.projectRoot, '.hive-flow'), { recursive: true });

    const output = await renderClaudeCodeStatusline(canonicalStdin(), fix.projectRoot);
    const plain = stripAnsi(output);

    expect(plain).not.toContain('📊');
    expect(plain).not.toContain('Memory');
    expect(plain).not.toContain('Embeddings');
    expect(plain).not.toContain('Memories');
    expect(plain).not.toContain('Tests');
    expect(plain).not.toContain('MCP');
    expect(plain).not.toContain('0/0');
    expect(plain).not.toContain('Embeddings 0');
    expect(plain).not.toContain('Memories 0');
    expect(plain).not.toContain('Tests 0');
  });

  it('GOLDEN partial fixture (OMIT > FAKE): only populated rows appear, only one rule pair', async () => {
    // Only a scoreboard + daemon. No swarm / memory / attention -> those rows
    // are OMITTED, but the single body row still gets its rule pair + footer.
    writeSnapshot(fix.projectRoot, {
      scoreboard: {
        agentsByProvider: { gemini: { activeAgents: 1, idleAgents: 0, staleAgents: 0 } },
        callsByProvider: {},
        stale: false,
      },
      daemon: { running: true, health: 'healthy', observedAt: new Date().toISOString() },
    });
    const output = await renderClaudeCodeStatusline(canonicalStdin(), fix.projectRoot);
    const lines = stripAnsi(output).split('\n');

    // header, rule, scoreboard, rule, footer = 5 lines.
    expect(lines.length).toBe(5);
    expect(lines[1]).toBe(RULE);
    expect(lines[2]).toBe('🤖 Gemini 1');
    expect(lines[3]).toBe(RULE);
    expect(lines[4]).toBe('► ⛔ ENFORCEMENT OFF · daemon on · data fresh 0s');
    // No swarm / memory / attention markers fabricated.
    expect(output).not.toContain('🪪');
    expect(output).not.toContain('📊');
    expect(output).not.toContain('📌');
  });

  // =========================================================================
  // 2. ANTI-COLLAPSE GUARD — the specific past regression (single-line box).
  // =========================================================================

  it('ANTI-COLLAPSE: a populated board is ALWAYS multi-line (never flattened)', async () => {
    fullFixtureSnapshot(fix.projectRoot);
    const output = await renderClaudeCodeStatusline(canonicalStdin(), fix.projectRoot);
    // The headline guard: the output MUST contain a newline.
    expect(output.includes('\n')).toBe(true);
    // And it must have strictly more than one line of real content.
    expect(stripAnsi(output).split('\n').length).toBeGreaterThan(1);
    // Rows are joined by `\n` only — never `\r` (a flatten-to-CRLF smell).
    expect(output.includes('\r')).toBe(false);
  });

  it('ANTI-COLLAPSE: every populated permutation keeps >=1 newline (no collapse path)', async () => {
    // Any single body row already forces header + rule + body + rule + footer.
    const variants: Array<Partial<StatuslineSnapshotV1>> = [
      {
        scoreboard: {
          agentsByProvider: { codex: { activeAgents: 1, idleAgents: 0, staleAgents: 0 } },
          callsByProvider: {},
          stale: false,
        },
        daemon: { running: true, health: 'healthy', observedAt: new Date().toISOString() },
      },
      {
        swarm: {
          activeAgents: 1, idleAgents: 0, queuedAgents: 0, maxAgents: 150,
          activeQueens: 0, executingQueens: 0,
        },
        daemon: { running: true, health: 'healthy', observedAt: new Date().toISOString() },
      },
      {
        memory: {
          embeddings: { count: 5, source: 's', observedAt: new Date().toISOString() },
          sourceDescription: 's',
        },
        daemon: { running: true, health: 'healthy', observedAt: new Date().toISOString() },
      },
    ];
    for (const v of variants) {
      const proj = mkdtempSync(join(tmpdir(), 'hf-layout-variant-'));
      try {
        writeSnapshot(proj, v);
        const output = await renderClaudeCodeStatusline(canonicalStdin(), proj);
        expect(output.includes('\n')).toBe(true);
      } finally {
        rmSync(proj, { recursive: true, force: true });
      }
    }
  });

  it('ANTI-COLLAPSE: renderer source contains NO newline-stripping code path', () => {
    const source = readFileSync(
      join(__dirname, '..', 'claude-code-renderer.ts'),
      'utf8',
    );
    const code = source
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/\/\/.*$/gm, '');
    // The collapse regression replaced newlines with spaces. Forbid any code
    // that strips/normalizes `\n` or `\r` out of the composed box. Patterns
    // such as `.replace(/[\r\n]+/g, ' ')` or `.split('\n').join(' ')` MUST NOT
    // reappear in the live renderer code.
    // eslint-disable-next-line no-control-regex
    expect(code).not.toMatch(/replace\([^)]*\\[rn]/);
    expect(code).not.toMatch(/replace\([^)]*\[\\r\\n\]/);
    expect(code).not.toMatch(/split\(\s*['"]\\n['"]\s*\)\s*\.join/);
    // The composition MUST join rows with a newline (positive assertion).
    expect(code).toMatch(/\.join\(\s*['"]\\n['"]\s*\)/);
  });

  // =========================================================================
  // 3. PROPERTY / INVARIANT — arbitrary valid snapshots hold the contract.
  // =========================================================================

  // Documented per-row format regexes (stripped-ANSI). These pin segment shape
  // without pinning content, so the property tests can vary the data freely.
  const HEADER_RE = /^▊ .+/u;
  const RULE_RE = /^─+$/u;
  const SCOREBOARD_RE = /^🤖 .+/u;
  const SWARM_RE = /^🪪 Swarm [◉○] \[\s*\d+\/\d+\]/u;
  const MEMORY_RE = /^📊 Memory {2}.+/u;
  const ATTENTION_RE = /^📌 attention {2}.+/u;
  const FOOTER_RE = /^► .+/u;

  it('INVARIANT: row order is always header -> body -> footer with rule IFF >=1 body row', async () => {
    const providerArb = fc.constantFrom('codex', 'gemini', 'forge', 'cursor', 'deepseek');
    const snapshotArb = fc.record({
      withScoreboard: fc.boolean(),
      provider: providerArb,
      providerCount: fc.integer({ min: 1, max: 9 }),
      withSwarm: fc.boolean(),
      activeAgents: fc.integer({ min: 0, max: 12 }),
      withMemory: fc.boolean(),
      embeddings: fc.integer({ min: 1, max: 5000 }),
      withAttention: fc.boolean(),
    });

    await fc.assert(
      fc.asyncProperty(snapshotArb, async (s) => {
        const proj = mkdtempSync(join(tmpdir(), 'hf-layout-prop-'));
        try {
          const overrides: Partial<StatuslineSnapshotV1> = {
            daemon: { running: true, health: 'healthy', observedAt: new Date().toISOString() },
          };
          if (s.withScoreboard) {
            overrides.scoreboard = {
              agentsByProvider: {
                [s.provider]: { activeAgents: s.providerCount, idleAgents: 0, staleAgents: 0 },
              } as ScoreboardSummary['agentsByProvider'],
              callsByProvider: {},
              stale: false,
            };
          }
          if (s.withSwarm) {
            overrides.swarm = {
              activeAgents: s.activeAgents,
              idleAgents: 0,
              queuedAgents: 0,
              maxAgents: 150,
              activeQueens: 0,
              executingQueens: 0,
            } as SwarmSummary;
          }
          if (s.withMemory) {
            overrides.memory = {
              embeddings: { count: s.embeddings, source: 's', observedAt: new Date().toISOString() },
              sourceDescription: 's',
            };
          }
          if (s.withAttention) {
            overrides.attention = {
              unresolved: [
                {
                  id: 'x',
                  ts: new Date().toISOString(),
                  severity: 'warn',
                  source: 'src',
                  message: 'needs review',
                  redacted: false,
                  ageSeconds: 1,
                },
              ],
            };
          }
          writeSnapshot(proj, overrides);
          const output = await renderClaudeCodeStatusline(canonicalStdin(), proj);
          const lines = stripAnsi(output).split('\n');

          // Header is ALWAYS first.
          expect(lines[0]).toMatch(HEADER_RE);

          // Identify which body rows are present (a swarm with 0 agents + 0
          // queens omits, per OMIT > FAKE).
          const swarmRendered = s.withSwarm && (s.activeAgents > 0);
          const bodyExpected =
            (s.withScoreboard ? 1 : 0) +
            (swarmRendered ? 1 : 0) +
            (s.withMemory ? 1 : 0) +
            (s.withAttention ? 1 : 0);

          const ruleLines = lines.filter((l) => RULE_RE.test(l));
          if (bodyExpected > 0) {
            // Exactly two inter-row rules when at least one body row exists.
            expect(ruleLines.length).toBe(2);
          } else {
            // No body rows -> NO separator rules at all.
            expect(ruleLines.length).toBe(0);
          }

          // Footer (daemon on) is the last line whenever present.
          const footerIdx = lines.findIndex((l) => FOOTER_RE.test(l));
          expect(footerIdx).toBe(lines.length - 1);

          // Documented body-row order: scoreboard < swarm < memory < attention.
          const sb = lines.findIndex((l) => SCOREBOARD_RE.test(l));
          const sw = lines.findIndex((l) => SWARM_RE.test(l));
          const mem = lines.findIndex((l) => MEMORY_RE.test(l));
          const att = lines.findIndex((l) => ATTENTION_RE.test(l));
          const ordered = [sb, sw, mem, att].filter((i) => i >= 0);
          for (let i = 1; i < ordered.length; i++) {
            expect(ordered[i]).toBeGreaterThan(ordered[i - 1]);
          }
        } finally {
          rmSync(proj, { recursive: true, force: true });
        }
      }),
      { numRuns: 60 },
    );
  });

  it('INVARIANT: every present row matches its documented format regex', async () => {
    fullFixtureSnapshot(fix.projectRoot);
    const output = await renderClaudeCodeStatusline(canonicalStdin(), fix.projectRoot);
    const lines = stripAnsi(output).split('\n');
    for (const line of lines) {
      const matchesSomeRow =
        HEADER_RE.test(line) ||
        RULE_RE.test(line) ||
        SCOREBOARD_RE.test(line) ||
        SWARM_RE.test(line) ||
        MEMORY_RE.test(line) ||
        ATTENTION_RE.test(line) ||
        FOOTER_RE.test(line);
      expect(matchesSomeRow).toBe(true);
    }
  });

  it('INVARIANT (OMIT > FAKE): empty backing data never fabricates a row or a 0-placeholder', async () => {
    // Snapshot with explicitly EMPTY containers — no provider calls, a swarm of
    // zero agents/queens, memory with zero counts, no attention entries.
    writeSnapshot(fix.projectRoot, {
      scoreboard: { agentsByProvider: {}, callsByProvider: {}, stale: false },
      swarm: {
        activeAgents: 0, idleAgents: 0, queuedAgents: 0, maxAgents: 150,
        activeQueens: 0, executingQueens: 0,
      },
      memory: {
        embeddings: { count: 0, source: 's', observedAt: new Date().toISOString() },
        memories: { count: 0, source: 's', observedAt: new Date().toISOString() },
        dbSizeBytes: 0,
        sourceDescription: 's',
      },
      attention: { unresolved: [] },
      daemon: { running: true, health: 'healthy', observedAt: new Date().toISOString() },
    });
    const output = await renderClaudeCodeStatusline(canonicalStdin(), fix.projectRoot);
    const plain = stripAnsi(output);
    // None of the body-row markers appear (all gated on real data).
    expect(plain).not.toContain('🤖');
    expect(plain).not.toContain('🪪');
    expect(plain).not.toContain('📊');
    expect(plain).not.toContain('📌');
    // No separator rules (no body rows).
    expect(plain).not.toContain('─');
    // No fabricated zero placeholders for memory counts.
    expect(plain).not.toContain('Embeddings 0');
    expect(plain).not.toContain('Memories 0');
    // Header + footer survive (footer has a daemon signal).
    expect(plain.split('\n')[0]).toMatch(HEADER_RE);
    expect(plain).toContain('daemon on');
  });
});
