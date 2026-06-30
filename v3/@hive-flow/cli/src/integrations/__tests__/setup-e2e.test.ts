// integrations/__tests__/setup-e2e.test.ts
//
// §12.2 Real-world test: full setup against a fixture tree
// §12.3 Setup wiring tests: --features mcp,statusline
// Helpers are inlined (option a) to avoid cross-file coupling.
//
import { it, expect, vi } from 'vitest';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { mkdir, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

// vi.mock is hoisted before imports by vitest, so we must capture the fake paths lazily.
// Each test sets these module-level variables before calling runSetup.
let _fakeMcpServerPath: string = '/dev/null/fake-mcp-server.js';
// When non-null, the launcher module's resolveStatuslineRuntimeEntrypoint is
// overridden with this value. When null (the default), the real implementation
// runs. This lets the §12.2 test (which never sets it) keep its prior
// behavior untouched by the new §12.3 mock plumbing.
let _fakeStatuslineRuntimePath: string | null = null;

vi.mock('../../commands/setup.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../commands/setup.js')>();
  return {
    ...actual,
    resolveMcpServerEntry: () => _fakeMcpServerPath,
  };
});

// resolveStatuslineRuntimeEntrypoint is consumed inside runMutating via the
// `../integrations/launcher.js` import in commands/setup.ts. We mock the
// launcher module so the §12.3 fixture-cwd path resolution does not need a
// real bin/statusline.js adjacent to the temp directory. When
// _fakeStatuslineRuntimePath is null we delegate to the real implementation
// so the pre-existing §12.2 test is unaffected.
vi.mock('../../integrations/launcher.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../integrations/launcher.js')>();
  return {
    ...actual,
    resolveStatuslineRuntimeEntrypoint: (projectRoot: string) =>
      _fakeStatuslineRuntimePath ?? actual.resolveStatuslineRuntimeEntrypoint(projectRoot),
  };
});

import { runSetup } from '../../commands/setup.js';

// ---------------------------------------------------------------------------
// Inlined test helpers (§12.1 preamble — used by §12.2 and §12.3)
// ---------------------------------------------------------------------------

async function setupFixture(
  files: Record<string, string>,
): Promise<{ cwd: string; read: (rel: string) => Promise<string> }> {
  const root = mkdtempSync(join(tmpdir(), 'hf-e2e-'));
  for (const [rel, content] of Object.entries(files)) {
    const full = join(root, rel);
    await mkdir(dirname(full), { recursive: true });
    writeFileSync(full, content);
  }
  return {
    cwd: root,
    read: async (rel) => (await readFile(join(root, rel))).toString('utf8'),
  };
}

function byKey<T extends Record<string, unknown>>(
  items: T[],
  key: string,
): Record<string, T> {
  return Object.fromEntries(items.map((item) => [item[key], item]));
}

// ---------------------------------------------------------------------------
// §12.2 test
// ---------------------------------------------------------------------------

it('detects 7 agents, merges 5 existing configs, returns missing-config for absent Qwen', async () => {
  const fixture = await setupFixture({
    'home/.codex/config.toml': '[mcp_servers.filesystem]\ncommand = "fs"\n',
    'home/.gemini/settings.json': '{"mcpServers":{"filesystem":{"command":"fs"}}}',
    'home/.cursor/mcp.json': '{"mcpServers":{"claude-mem":{"command":"cm"}}}',
    'home/.config/opencode/opencode.json': '{"plugin":["x"]}',
    // .qwen absent intentionally
    'home/.claude.json': '{"mcpServers":{"filesystem":{"command":"fs"}}}',
  });

  // homeDir override redirects user-scope config paths into the fixture; without this the test
  // would write to the real ~/.codex / ~/.gemini / etc. (Codex pass-4 item 3).
  // Explicit agent list (Codex pass-5 item 4): `agents: 'detected'` would shell out to `which` for
  // each CLI and skip any not installed on the dev/CI machine, breaking the test deterministically
  // only on workstations where all 7 happen to be present. The explicit list makes the test run
  // identical fixtures everywhere; a separate detection test (§12.4) covers the `'detected'` path.

  // Point the mocked resolveMcpServerEntry at a real file in the fixture dir so
  // writeStableLauncher (called during apply) receives a valid path argument.
  const fakeMcpServer = join(fixture.cwd, 'fake-mcp-server.js');
  writeFileSync(fakeMcpServer, '#!/usr/bin/env node\n');
  _fakeMcpServerPath = fakeMcpServer;

  const result = await runSetup({
    action: 'apply',
    agents: ['claude-code', 'codex', 'forgecode', 'opencode', 'cursor-cli', 'qwen', 'gemini'],
    scope: 'user',
    cwd: fixture.cwd, homeDir: join(fixture.cwd, 'home'),
    lockPath: join(fixture.cwd, '.hive-flow', 'setup.lock'),
    dryRun: false, createConfig: false, forceAdopt: false,
    // Scope this test to the MCP feature only — the Wave 4 default of
    // 'mcp,statusline' would add a second result row per agent and cause
    // byKey (which collapses by agent ID) to overwrite the MCP row with the
    // statusline row. The statusline feature has its own dedicated test below.
    features: 'mcp',
  });

  const byAgent = byKey(result.results as Array<Record<string, unknown>>, 'agent');

  expect(byAgent['codex'].outcome).toBe('applied');
  expect(byAgent['gemini'].outcome).toBe('applied');
  expect(byAgent['cursor-cli'].outcome).toBe('applied');
  expect(byAgent['opencode'].outcome).toBe('applied');
  expect(byAgent['qwen'].outcome).toBe('missing-config');
  expect(byAgent['claude-code'].outcome).toBe('applied');

  // Sibling keys preserved
  expect(await fixture.read('home/.gemini/settings.json')).toContain('"filesystem"');

  const codexConfig = await fixture.read('home/.codex/config.toml');
  expect(codexConfig).toContain('env_vars = ["CODEX_SESSION_ID", "CODEX_THREAD_ID"]');
  expect(codexConfig).toContain('[mcp_servers.hive-flow.env]');
});

// ---------------------------------------------------------------------------
// §12.3 — applies Claude Code MCP and statusline as separate features
// ---------------------------------------------------------------------------

it('applies Claude Code MCP and statusline as separate features', async () => {
  const fixture = await setupFixture({
    'home/.claude.json': '{"mcpServers":{}}',
    'home/.claude/settings.json': '{"permissions":{"allow":[]}}',
  });

  // Point both mocked entry-point resolvers at real files in the fixture so
  // writeStableLauncher / writeStableStatuslineLauncher receive valid paths.
  const fakeMcpServer = join(fixture.cwd, 'fake-mcp-server.js');
  writeFileSync(fakeMcpServer, '#!/usr/bin/env node\n');
  _fakeMcpServerPath = fakeMcpServer;

  const fakeStatuslineRuntime = join(fixture.cwd, 'fake-statusline-runtime.js');
  writeFileSync(fakeStatuslineRuntime, '#!/usr/bin/env node\n');
  _fakeStatuslineRuntimePath = fakeStatuslineRuntime;

  const result = await runSetup({
    action: 'apply',
    agents: ['claude-code'],
    scope: 'user',
    cwd: fixture.cwd,
    homeDir: join(fixture.cwd, 'home'),
    lockPath: join(fixture.cwd, '.hive-flow', 'setup.lock'),
    dryRun: false,
    createConfig: false,
    forceAdopt: false,
    features: 'mcp,statusline',
  });

  expect(result.results).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ agent: 'claude-code', feature: 'mcp', outcome: 'applied' }),
      expect.objectContaining({ agent: 'claude-code', feature: 'statusline', outcome: 'applied' }),
    ]),
  );

  // The statusline launcher path is embedded into Claude Code's
  // settings.json `statusLine.command`, and its basename is the literal
  // 'claude-code-statusline' string defined in resolveStatuslineLauncherPath.
  expect(await fixture.read('home/.claude/settings.json')).toContain('claude-code-statusline');
});
