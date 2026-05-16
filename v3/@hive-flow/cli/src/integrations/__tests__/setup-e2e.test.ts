// integrations/__tests__/setup-e2e.test.ts
//
// §12.2 Real-world test: full setup against a fixture tree
// Helpers are inlined (option a) to avoid cross-file coupling.
//
import { it, expect, vi } from 'vitest';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { mkdir, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

// vi.mock is hoisted before imports by vitest, so we must capture the fake path lazily.
// We use a module-level variable that each test sets before calling runSetup.
let _fakeMcpServerPath: string = '/dev/null/fake-mcp-server.js';

vi.mock('../../commands/setup.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../commands/setup.js')>();
  return {
    ...actual,
    resolveMcpServerEntry: () => _fakeMcpServerPath,
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
});
