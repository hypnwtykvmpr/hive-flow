// cli/src/integrations/__tests__/edge-cases.test.ts
//
// §12.3 Edge cases — paste-ready integration tests.
// §12.4 Demoted scaffolds at the bottom (it.skip).

import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { mkdir, mkdtemp } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

// Re-export node:fs/promises through a mock so per-test vi.spyOn can intercept
// individual operations (used for ENOSPC and EXDEV scenarios below). The mock
// preserves all real behavior via `...actual`; only test-scoped spies alter it.
vi.mock('node:fs/promises', async () => {
  const actual = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');
  return { ...actual };
});

// vi.mock is hoisted before imports by vitest. We use a module-level variable so
// individual tests can point the stub at a real file before calling runSetup.
let _fakeMcpServerPath: string = '/dev/null/fake-mcp-server.js';

vi.mock('../../commands/setup.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../commands/setup.js')>();
  return {
    ...actual,
    resolveMcpServerEntry: () => _fakeMcpServerPath,
  };
});

import {
  MCP_LAUNCHER_BUNDLE_FILES,
  MCP_LAUNCHER_POLICY_FILES,
  resolveMcpLauncherPath,
  writeStableLauncher,
} from '../launcher.js';
import { withSetupLock } from '../lockfile.js';
import { upsertTomlBlock } from '../toml-block.js';
import { upsertJsonPath } from '../atomic-merge.js';
import { detectVariants } from '../variant-detection.js';
import { runSetup } from '../../commands/setup.js';
import { applyClaudeCodeMcp } from '../adapters/claude-code.js';
import { resolveProjectIdentity } from '../../statusline/project-identity.js';
import { resolveModelDisplay } from '../../statusline/model-display.js';
import { hiveFlowMcpEnv } from '../launcher.js';
import { requestSpawn, onAgentComplete, type SwarmState } from '../../swarm/intake.js';

// ---------------------------------------------------------------------------
// Helpers (inlined — same approach as setup-e2e.test.ts)
// ---------------------------------------------------------------------------

/** Small async sleep — used only where the test needs to let another async
 *  operation acquire a resource before we probe it. */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Build a temporary fixture tree from a map of relative-path → content.
 *  Returns a helper that exposes `cwd` (the temp dir root) and `read(path)`. */
async function setupFixture(
  files: Record<string, string>,
): Promise<{ cwd: string; read: (p: string) => Promise<string> }> {
  const cwd = await mkdtemp(join(tmpdir(), 'hive-flow-test-'));
  for (const [rel, content] of Object.entries(files)) {
    const abs = join(cwd, rel);
    mkdirSync(join(abs, '..'), { recursive: true });
    writeFileSync(abs, content, 'utf8');
  }
  return {
    cwd,
    read: (p: string) =>
      Promise.resolve(readFileSync(join(cwd, p), 'utf8')),
  };
}

/** Index an array of objects by a string key field. */
function byKey<T extends Record<string, unknown>>(
  arr: T[],
  key: keyof T,
): Record<string, T> {
  return Object.fromEntries(arr.map((item) => [item[key], item]));
}

/** isManaged predicate that always returns true (agent owns everything). */
const isManagedAlways = async (_val: unknown) => true;

/** isManaged predicate that always returns false (nothing is agent-owned). */
const isManagedNever = async (_val: unknown) => false;

// Shared temp dir for tests that need isolated scratch space.
let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'hive-flow-ec-'));
});

// ---------------------------------------------------------------------------
// §12.3 edge cases
// ---------------------------------------------------------------------------

describe('edge cases', () => {
  it('path with spaces and apostrophes round-trips in the launcher shim', async () => {
    const path = join(dir, "hive's spaces", 'launcher');
    // REAL files: the generator requires readable regular files, so a fake path
    // fixture would assert nothing about the contract it claims to cover.
    const serverDir = join(dir, "path with spaces/and 'quotes'");
    const helperDir = join(dir, "opt/hive's helpers");
    mkdirSync(serverDir, { recursive: true });
    mkdirSync(helperDir, { recursive: true });
    const server = join(serverDir, 'server.js');
    const attesting = join(helperDir, 'hive-flow-mcp-launcher.cjs');
    writeFileSync(server, '// server\n');
    writeFileSync(attesting, '// launcher\n');

    await writeStableLauncher(path, server, attesting);
    expect(existsSync(path)).toBe(true);
    const content = readFileSync(path, 'utf8');
    const esc = (v: string) => v.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/'/g, "'\\\\''");

    // The wrapper must exec the ATTESTING LAUNCHER, never the MCP server
    // directly — execing the server is the bypass that leaves the connection
    // unattested and makes owner-sensitive tools fail closed.
    expect(content).toMatch(new RegExp(`^exec node '${esc(attesting)}' "\\$@"$`, 'm'));
    expect(content).not.toMatch(new RegExp(`^exec node '${esc(server)}'`, 'm'));

    // The exact server entrypoint is forwarded, quoted, for the launcher to
    // prefer over its own layout resolution.
    expect(content).toMatch(
      new RegExp(`^export HIVE_FLOW_MCP_SERVER_ENTRYPOINT='${esc(server)}'$`, 'm'),
    );
  });

  it('refuses launcher paths that are relative, control-bearing, or not real files', async () => {
    const path = join(dir, 'launcher-guard');
    const realServer = join(dir, 'guard-server.js');
    const realLauncher = join(dir, 'guard-launcher.cjs');
    writeFileSync(realServer, '// server\n');
    writeFileSync(realLauncher, '// launcher\n');

    await expect(
      writeStableLauncher(path, realServer, 'relative/launcher.cjs'),
    ).rejects.toThrow(/must be absolute/i);
    await expect(
      writeStableLauncher(path, realServer, '/abs/laun\ncher.cjs'),
    ).rejects.toThrow(/control characters/i);
    await expect(
      writeStableLauncher(path, 'relative/server.js', realLauncher),
    ).rejects.toThrow(/must be absolute/i);
    // Absolute but nonexistent, and absolute but a directory: both must be
    // refused rather than baked into a wrapper that fails at connect time.
    await expect(
      writeStableLauncher(path, realServer, join(dir, 'no-such-launcher.cjs')),
    ).rejects.toThrow(/not a readable file/i);
    await expect(
      writeStableLauncher(path, realServer, dir),
    ).rejects.toThrow(/not a readable file/i);
    await expect(
      writeStableLauncher(path, join(dir, 'no-such-server.js'), realLauncher),
    ).rejects.toThrow(/not a readable file/i);
  });

  // Permission bits are meaningless as root and absent on Windows, so the
  // unreadable-file cases below would pass vacuously there.
  const permissionsApply = process.platform !== 'win32' && process.getuid?.() !== 0;

  it.skipIf(process.platform === 'win32')('reconcile restores the executable bit when text is already canonical', async () => {
    // The verifier rejects a wrapper without X_OK and tells the operator to run
    // `setup reconcile`. If the writer returned early on matching content, that
    // instruction could never be satisfied and the wrapper would stay unusable.
    const launcherPath = join(dir, 'reconcile-mode', 'hive-flow-mcp-server');
    const server = join(dir, 'reconcile-server.js');
    const attesting = join(dir, 'reconcile-launcher.cjs');
    writeFileSync(server, '// server\n');
    writeFileSync(attesting, '// launcher\n');

    await writeStableLauncher(launcherPath, server, attesting);
    const canonical = readFileSync(launcherPath, 'utf8');
    chmodSync(launcherPath, 0o644);

    // Identical inputs: this is exactly what `setup reconcile` re-runs.
    await writeStableLauncher(launcherPath, server, attesting);

    expect(statSync(launcherPath).mode & 0o777).toBe(0o755);
    // Content idempotence is preserved, not traded away for the mode repair.
    expect(readFileSync(launcherPath, 'utf8')).toBe(canonical);
  });

  it('refuses paths containing DEL, matching the attesting launcher runtime guard', async () => {
    // The launcher rejects /[\x00-\x1f\x7f]/ at runtime. A writer that accepted
    // DEL would install a wrapper that only fails later, at connect time.
    const launcherPath = join(dir, 'del-guard');
    const server = join(dir, 'del-server.js');
    const attesting = join(dir, 'del-launcher.cjs');
    writeFileSync(server, '// server\n');
    writeFileSync(attesting, '// launcher\n');

    await expect(
      writeStableLauncher(launcherPath, `${server}\x7f`, attesting),
    ).rejects.toThrow(/control characters/i);
    await expect(
      writeStableLauncher(launcherPath, server, `${attesting}\x7f`),
    ).rejects.toThrow(/control characters/i);
    await expect(
      writeStableLauncher(launcherPath, server, attesting, { platform: 'win32' as NodeJS.Platform }),
    ).resolves.toBeUndefined();
    await expect(
      writeStableLauncher(launcherPath, `C:\\srv\\mcp\x7f.js`, 'C:\\h\\launcher.cjs', { platform: 'win32' as NodeJS.Platform }),
    ).rejects.toThrow(/control characters/i);
  });

  it.skipIf(!permissionsApply)('refuses an entrypoint that is a regular file but unreadable', async () => {
    // `statSync().isFile()` succeeds on a mode-000 file (stat needs search
    // permission on the parent, not read on the file), so an isFile()-only check
    // would bake an unreadable path into the wrapper and fail at connect time.
    const path = join(dir, 'launcher-unreadable');
    const realLauncher = join(dir, 'ur-launcher.cjs');
    const unreadableServer = join(dir, 'ur-server.js');
    writeFileSync(realLauncher, '// launcher\n');
    writeFileSync(unreadableServer, '// server\n');
    chmodSync(unreadableServer, 0o000);
    try {
      expect(statSync(unreadableServer).isFile()).toBe(true);   // the trap isFile() alone falls into
      await expect(
        writeStableLauncher(path, unreadableServer, realLauncher),
      ).rejects.toThrow(/not a readable file/i);
    } finally {
      chmodSync(unreadableServer, 0o644);   // let temp cleanup remove it
    }
  });

  // -------------------------------------------------------------------------
  // Bundle layout selection (hive-flow-a541)
  //
  // Only two layouts ship. Both are proven here with real files, because the
  // resolver's whole job is to refuse a bundle that would fail at spawn time.
  // -------------------------------------------------------------------------

  /** Write every named file into `target` as a real regular file. */
  function seedBundle(target: string, files: readonly string[]): void {
    mkdirSync(target, { recursive: true });
    for (const file of files) writeFileSync(join(target, file), '// fixture\n');
  }

  const ALL_BUNDLE_FILES = [...MCP_LAUNCHER_BUNDLE_FILES, ...MCP_LAUNCHER_POLICY_FILES];

  it('selects the flat layout used by the published package and the relocated install', () => {
    const home = join(dir, 'flat-home');
    const binDir = join(home, '.hive-flow', 'enforcement', 'bin');
    seedBundle(binDir, ALL_BUNDLE_FILES);

    expect(resolveMcpLauncherPath(home, join(dir, 'flat-unused-project')))
      .toBe(join(binDir, MCP_LAUNCHER_BUNDLE_FILES[0]));
  });

  it('selects the source-checkout layout with policy under cli/src/permission-guard', () => {
    // The repo-root `.claude/helpers/` deliberately carries no flat policy copy,
    // so this layout is the one a source checkout actually presents.
    const project = join(dir, 'src-project');
    const helpers = join(project, '.claude', 'helpers');
    seedBundle(helpers, MCP_LAUNCHER_BUNDLE_FILES);
    seedBundle(join(project, 'cli', 'src', 'permission-guard'), MCP_LAUNCHER_POLICY_FILES);

    expect(resolveMcpLauncherPath(join(dir, 'src-empty-home'), project))
      .toBe(join(helpers, MCP_LAUNCHER_BUNDLE_FILES[0]));
  });

  it('never selects a bundle missing a transitively required helper', () => {
    // `mcp-attestation.cjs` requires `client-kind.cjs` at load, so a bundle
    // without it yields a launcher that dies at spawn — the exact failure the
    // completeness check exists to prevent.
    const home = join(dir, 'partial-home');
    const binDir = join(home, '.hive-flow', 'enforcement', 'bin');
    seedBundle(binDir, ALL_BUNDLE_FILES.filter((f) => f !== 'client-kind.cjs'));

    expect(resolveMcpLauncherPath(home, join(dir, 'partial-unused-project')))
      .not.toBe(join(binDir, MCP_LAUNCHER_BUNDLE_FILES[0]));
  });

  it('never selects a bundle whose member is a directory', () => {
    const home = join(dir, 'dir-member-home');
    const binDir = join(home, '.hive-flow', 'enforcement', 'bin');
    seedBundle(binDir, ALL_BUNDLE_FILES.filter((f) => f !== 'layout-paths.cjs'));
    mkdirSync(join(binDir, 'layout-paths.cjs'), { recursive: true });   // exists, but not a file

    expect(resolveMcpLauncherPath(home, join(dir, 'dir-member-project')))
      .not.toBe(join(binDir, MCP_LAUNCHER_BUNDLE_FILES[0]));
  });

  it.skipIf(!permissionsApply)('never selects a bundle whose member is unreadable', () => {
    const home = join(dir, 'unreadable-member-home');
    const binDir = join(home, '.hive-flow', 'enforcement', 'bin');
    seedBundle(binDir, ALL_BUNDLE_FILES);
    const blinded = join(binDir, 'mcp-attestation.cjs');
    chmodSync(blinded, 0o000);
    try {
      expect(resolveMcpLauncherPath(home, join(dir, 'unreadable-member-project')))
        .not.toBe(join(binDir, MCP_LAUNCHER_BUNDLE_FILES[0]));
    } finally {
      chmodSync(blinded, 0o644);
    }
  });

  it('concurrent setup invocations: second returns busy:locked', async () => {
    // Inject a temp lock path so this test doesn't touch ~/.hive-flow/setup.lock (Codex pass-4 item 6c).
    const lockPath = join(dir, 'concurrent.lock');
    const inflight = withSetupLock(async () => { await sleep(2000); return 'first'; }, { lockPath });
    // Small delay so `inflight` has time to acquire the lock before we try the second one.
    await sleep(50);
    const r2 = await withSetupLock(async () => 'second', { lockPath });
    expect(r2.acquired).toBe(false);
    await inflight;  // let first finish
  });

  it('TOML with comments and array-of-tables: preserves comments and detects [[name]] correctly', async () => {
    const file = join(dir, 'codex.toml');
    writeFileSync(file, `# leading comment
[mcp_servers.filesystem]
command = "fs"   # inline comment
args = ["a", "b"]

[[some_array_of_tables]]
key = "value"
`);
    await upsertTomlBlock({
      filePath: file,
      tableName: 'mcp_servers.hive-flow',
      values: { command: '/launcher', args: [] },
      ownership: 'agent',
      dryRun: false,
      createIfMissing: false,
      isManaged: isManagedNever,
      forceAdopt: false,
    });
    const after = readFileSync(file, 'utf8');
    expect(after).toContain('# leading comment');
    expect(after).toContain('# inline comment');
    expect(after).toContain('[[some_array_of_tables]]');
    expect(after).toContain('[mcp_servers.hive-flow]');
  });

  it('duplicate hive-flow entries detected (two identical headers in TOML)', async () => {
    const file = join(dir, 'dup.toml');
    writeFileSync(
      file,
      '[mcp_servers.hive-flow]\ncommand = "a"\n\n[mcp_servers.hive-flow]\ncommand = "b"\n',
    );
    const r = await upsertTomlBlock({
      filePath: file,
      tableName: 'mcp_servers.hive-flow',
      values: { command: 'c' },
      ownership: 'agent',
      dryRun: false,
      createIfMissing: false,
      isManaged: isManagedNever,
      forceAdopt: false,
    });
    expect(r.outcome).toBe('conflict:duplicate');
  });

  it('case-variant detection (HIVE-FLOW vs hive-flow vs hive_flow) — pre-flight scan', async () => {
    // Separate test from header-duplicates above. The pre-flight scan in the setup command
    // must catch case/separator variants before calling upsertJsonPath, since the merge
    // primitive is case-sensitive on key paths.
    const file = join(dir, 'variants.json');
    writeFileSync(
      file,
      JSON.stringify(
        {
          mcpServers: {
            'HIVE-FLOW': { command: 'a' },
            'hive_flow': { command: 'b' },
          },
        },
        null,
        2,
      ),
    );
    const conflicts = await detectVariants(file, 'mcpServers', 'hive-flow');
    expect(conflicts).toEqual(expect.arrayContaining(['HIVE-FLOW', 'hive_flow']));
  });

  it('verify and plan actions do NOT mutate files', async () => {
    const file = join(dir, 'no-mutation.json');
    writeFileSync(file, '{"mcpServers":{"filesystem":{"command":"fs"}}}');
    const before = readFileSync(file, 'utf8');
    await runSetup({
      action: 'verify',
      agents: ['claude-code'],
      scope: 'user',
      cwd: dir,
      homeDir: dir,
      dryRun: false,
      createConfig: false,
      forceAdopt: false,
    });
    expect(readFileSync(file, 'utf8')).toBe(before);
    await runSetup({
      action: 'plan',
      agents: ['claude-code'],
      scope: 'user',
      cwd: dir,
      homeDir: dir,
      dryRun: false,
      createConfig: false,
      forceAdopt: false,
    });
    expect(readFileSync(file, 'utf8')).toBe(before);
  });

  it('--create-config creates an absent Qwen settings file with minimal contents', async () => {
    const file = join(dir, 'absent.json');
    expect(existsSync(file)).toBe(false);
    const r = await upsertJsonPath({
      filePath: file,
      ownership: 'agent',
      jsonPath: ['mcpServers', 'hive-flow'],
      value: { command: '/launcher' },
      dryRun: false,
      createIfMissing: true,
      forceAdopt: false,
      isManaged: async () => true,
    });
    expect(r.outcome).toBe('applied');
    expect(existsSync(file)).toBe(true);
    expect(JSON.parse(readFileSync(file, 'utf8')).mcpServers['hive-flow']).toBeDefined();
  });

  it('defaults omitted scope to user scope (Codex pass-7 item 1 regression)', async () => {
    // Omits `scope:` entirely. After resolveSetupScope() normalization, this should hit user-scope
    // paths (homeDir/.claude.json), NOT the project-scope path (projectRoot/.mcp.json).
    const fixture = await setupFixture({
      'home/.claude.json': '{"mcpServers":{}}',
    });
    const homeDir = join(fixture.cwd, 'home');

    // Point the module-level mock at a real file so writeStableLauncher has a valid path.
    const fakeMcpServer = join(fixture.cwd, 'fake-mcp-server.js');
    writeFileSync(fakeMcpServer, '#!/usr/bin/env node\n');
    _fakeMcpServerPath = fakeMcpServer;

    const result = await runSetup({
      action: 'apply',
      agents: ['claude-code'],
      cwd: fixture.cwd,
      homeDir,
      lockPath: join(fixture.cwd, '.hive-flow', 'setup.lock'),
      // scope intentionally omitted
      dryRun: false,
      createConfig: false,
      forceAdopt: false,
      // Wave 4: pin to mcp-only to keep byKey('agent') collapsing semantics.
      // Default 'mcp,statusline' would add a second row that overwrites the MCP row.
      features: 'mcp',
    } as any);

    expect(byKey(result.results, 'agent')['claude-code'].outcome).toBe('applied');
    expect(existsSync(join(homeDir, '.claude.json'))).toBe(true);
    // Project-scope target must NOT be touched when scope defaulted to user.
    expect(existsSync(join(fixture.cwd, '.mcp.json'))).toBe(false);
  });

  it('stale setup.lock is reclaimed after 10-minute threshold', async () => {
    // Use the injectable lockPath so this test doesn't touch ~/.hive-flow/setup.lock.
    const lockPath = join(dir, 'setup.lock');
    writeFileSync(
      lockPath,
      'pid=999999\nstartedAt=' +
        new Date(Date.now() - 11 * 60 * 1000).toISOString() +
        '\n',
    );
    const r = await withSetupLock(async () => 'reclaimed', { lockPath });
    expect(r.acquired).toBe(true);
  });

  it('state is written after apply and recognized on second apply', async () => {
    // Build a real ClaudeCodeAdapterCtx pointing entirely at the temp dir, then call applyClaudeCodeMcp twice.
    const homeDir = join(dir, 'home');
    const projectRoot = join(dir, 'project');
    await mkdir(homeDir, { recursive: true });
    await mkdir(projectRoot, { recursive: true });
    const file = join(homeDir, '.claude.json');
    writeFileSync(file, '{"mcpServers":{}}');
    const statePath = join(homeDir, '.hive-flow', 'integrations', 'state.json');
    const launcherPath = join(homeDir, '.hive-flow', 'bin', 'hive-flow-mcp-server');
    const ctx = {
      projectRoot,
      homeDir,
      scope: 'user' as const,
      launcherPath,
      statePath,
      dryRun: false,
      forceAdopt: false,
      createConfig: false,
    };

    // First apply → applied + state file created
    const r1 = await applyClaudeCodeMcp(ctx);
    expect(r1.outcome).toBe('applied');
    expect(existsSync(statePath)).toBe(true);

    // Second apply → byte-equal so already-registered
    const r2 = await applyClaudeCodeMcp(ctx);
    expect(r2.outcome).toBe('already-registered');
  });

  it('file mode is preserved across atomic merge (0600 stays 0600)', async () => {
    const file = join(dir, 'sensitive.json');
    writeFileSync(file, '{"mcpServers":{}}', { mode: 0o600 });
    await upsertJsonPath({
      filePath: file,
      ownership: 'agent',
      jsonPath: ['mcpServers', 'hive-flow'],
      value: { command: 'x' },
      dryRun: false,
      createIfMissing: false,
      forceAdopt: false,
      isManaged: async () => true,
    });
    const mode = statSync(file).mode & 0o777;
    expect(mode).toBe(0o600);
  });

  it('project name resolves from stdin when present, otherwise package.json', async () => {
    expect(
      (
        await resolveProjectIdentity({
          stdinData: { workspace: { current_dir: '/x/y' } },
          env: {},
          cwd: '/somewhere',
        })
      ).value.source,
    ).toBe('stdin');
    expect(
      (
        await resolveProjectIdentity({
          env: {},
          cwd: '/repo-without-stdin',
        })
      ).value.source,
    ).toMatch(/package-json|git|cwd/);
  });

  it('model display reads stdin first, ignores hardcoded fallback', () => {
    const r = resolveModelDisplay(
      { model: { display_name: 'Opus 4.8', id: 'claude-opus-4-8[1m]' } },
      'claude-code',
      new Date().toISOString(),
    );
    expect(r.value.modelDisplay).toBe('Opus 4.8 1M');
    expect(r.freshness).toBe('live');
  });

  it('swarm capacity reflects new 150 working + 30 queue-depth limits', () => {
    const env = hiveFlowMcpEnv();
    expect(env.HIVE_FLOW_MAX_AGENTS).toBe('150');
    expect(env.HIVE_FLOW_AGENT_QUEUE_DEPTH).toBe('30');
    expect(env.HIVE_FLOW_AGENT_QUEUE_REJECT_ABOVE).toBe('true');
  });

  it('swarm intake: 0-149 working -> accepted-running', () => {
    const state: SwarmState = { working: new Set<string>(), queue: [] as string[], rejections: [] };
    for (let i = 1; i <= 149; i++) state.working.add(`a${i}`);
    const r = requestSpawn(state, 'a150', { maxAgents: 150, queueDepth: 30 });
    expect(r.accepted).toBe(true);
    expect((r as any).status).toBe('running');
    expect(state.working.size).toBe(150);
  });

  it('swarm intake: 150 working + queue < 30 -> accepted-queued', () => {
    const state: SwarmState = { working: new Set<string>(), queue: [] as string[], rejections: [] };
    for (let i = 1; i <= 150; i++) state.working.add(`w${i}`);
    const r = requestSpawn(state, 'q1', { maxAgents: 150, queueDepth: 30 });
    expect(r.accepted).toBe(true);
    expect((r as any).status).toBe('queued');
    expect((r as any).position).toBe(1);
    expect((r as any).advisory).toMatch(/Set a poll\/wait timer/);
    expect(state.queue.length).toBe(1);
  });

  it('swarm intake: 150 working + 30 queued -> rejected busy:queue-full', () => {
    const state: SwarmState = {
      working: new Set<string>(),
      queue: Array.from({ length: 30 }, (_, i) => `q${i}`),
      rejections: [],
    };
    for (let i = 1; i <= 150; i++) state.working.add(`w${i}`);
    const r = requestSpawn(state, 'overflow', { maxAgents: 150, queueDepth: 30 });
    expect(r.accepted).toBe(false);
    expect((r as any).code).toBe('busy:queue-full');
    expect((r as any).workingCount).toBe(150);
    expect((r as any).queuedCount).toBe(30);
    expect((r as any).capacity).toBe(180);
    expect((r as any).advisory).toMatch(/Set a timer and retry/);
    expect(state.queue.length).toBe(30);  // queue not modified by rejection
    expect(state.working.size).toBe(150);  // working not modified by rejection
    expect(state.rejections.length).toBe(1);
  });

  it('swarm: completing a working agent promotes head of FIFO queue', () => {
    const state: SwarmState = {
      working: new Set<string>(['w1', 'w2']),
      queue: ['q1', 'q2', 'q3'],
      rejections: [],
    };
    const r = onAgentComplete(state, 'w1');
    expect(r.promoted).toBe('q1');
    expect(state.working.has('q1')).toBe(true);
    expect(state.queue).toEqual(['q2', 'q3']);
  });

  // ---------------------------------------------------------------------------
  // §12.4 Additional test scenarios (scaffolds — implementer to flesh out).
  // These describe required coverage but are NOT yet paste-ready. They use
  // 'it.skip' so the §19 validation gate (npm run test) passes while these
  // are still scaffolds. Implementers should complete them and remove '.skip'
  // before considering the integration feature-complete.
  // ---------------------------------------------------------------------------

  it('symlinked agent config file: reads through, writes through, backup goes next to target', async () => {
    const realFile = join(dir, 'real-target.json');
    const symFile = join(dir, 'link-to-target.json');
    writeFileSync(realFile, '{"mcpServers":{}}');
    symlinkSync(realFile, symFile);

    const r = await upsertJsonPath({
      filePath: symFile,
      ownership: 'agent',
      jsonPath: ['mcpServers', 'hive-flow'],
      value: { command: '/launcher' },
      dryRun: false,
      createIfMissing: false,
      forceAdopt: false,
      isManaged: async () => true,
    });

    expect(r.outcome).toBe('applied');
    // Symlink survives the write (lstat shows it's still a symlink, not replaced by a regular file).
    expect(lstatSync(symFile).isSymbolicLink()).toBe(true);
    // Real target received the new content.
    expect(JSON.parse(readFileSync(realFile, 'utf8')).mcpServers['hive-flow']).toBeDefined();
    // Backup lives next to the resolved target, not next to the symlink.
    expect(existsSync(`${realFile}.hive-flow.bak`)).toBe(true);
    expect(existsSync(`${symFile}.hive-flow.bak`)).toBe(false);
  });

  it('readonly parent directory (EACCES): returns failed cleanly, no partial state', async () => {
    const lockedDir = join(dir, 'locked');
    mkdirSync(lockedDir);
    const file = join(lockedDir, 'config.json');
    writeFileSync(file, '{"mcpServers":{}}');
    const before = readFileSync(file, 'utf8');
    chmodSync(lockedDir, 0o555);
    try {
      const r = await upsertJsonPath({
        filePath: file,
        ownership: 'agent',
        jsonPath: ['mcpServers', 'hive-flow'],
        value: { command: '/launcher' },
        dryRun: false,
        createIfMissing: false,
        forceAdopt: false,
        isManaged: async () => true,
      });
      expect(r.outcome).toBe('failed');
      expect(r.message).toMatch(/EACCES/);
      // Target file is byte-identical: atomic temp+rename never overwrote it.
      expect(readFileSync(file, 'utf8')).toBe(before);
    } finally {
      chmodSync(lockedDir, 0o755);
    }
  });

  it('disk full (ENOSPC) on write: returns failed; original file unchanged due to temp-rename', async () => {
    const file = join(dir, 'will-fail.json');
    writeFileSync(file, '{"mcpServers":{"existing":{"command":"x"}}}');
    const before = readFileSync(file, 'utf8');

    const fsp = await import('node:fs/promises');
    const enospc = Object.assign(new Error('ENOSPC: no space left on device'), { code: 'ENOSPC' });
    const writeFileSpy = vi.spyOn(fsp, 'writeFile').mockRejectedValueOnce(enospc);
    try {
      const r = await upsertJsonPath({
        filePath: file,
        ownership: 'agent',
        jsonPath: ['mcpServers', 'hive-flow'],
        value: { command: '/launcher' },
        dryRun: false,
        createIfMissing: false,
        forceAdopt: false,
        isManaged: async () => true,
      });
      expect(r.outcome).toBe('failed');
      expect(r.message).toMatch(/ENOSPC/);
      // Atomic semantics: original target is byte-identical because the temp
      // file's write was the failure point; rename never ran.
      expect(readFileSync(file, 'utf8')).toBe(before);
    } finally {
      writeFileSpy.mockRestore();
    }
  });

  it('cross-device rename (EXDEV) falls back to copy+unlink', async () => {
    const file = join(dir, 'crossdev.json');
    writeFileSync(file, '{"mcpServers":{}}');

    const fsp = await import('node:fs/promises');
    const exdev = Object.assign(new Error('EXDEV: cross-device link not permitted'), { code: 'EXDEV' });
    const renameSpy = vi.spyOn(fsp, 'rename').mockRejectedValueOnce(exdev);
    try {
      const r = await upsertJsonPath({
        filePath: file,
        ownership: 'agent',
        jsonPath: ['mcpServers', 'hive-flow'],
        value: { command: '/launcher' },
        dryRun: false,
        createIfMissing: false,
        forceAdopt: false,
        isManaged: async () => true,
      });
      expect(r.outcome).toBe('applied');
      // Target file ends up with the new content via copy+unlink fallback.
      expect(JSON.parse(readFileSync(file, 'utf8')).mcpServers['hive-flow']).toBeDefined();
    } finally {
      renameSpy.mockRestore();
    }
  });
});
