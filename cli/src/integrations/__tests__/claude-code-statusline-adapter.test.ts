// cli/src/integrations/__tests__/claude-code-statusline-adapter.test.ts
//
// Wave 5 / §12.2 — Claude Code statusline adapter tests.
// Asserts:
//   - Unmanaged user-scope statusLine is detected as a conflict (no force-adopt).
//   - Project-scope override warning is surfaced through the apply message.
//   - With --force-adopt, apply replaces an unmanaged statusLine and uninstall
//     restores the previous value (round-trip).
//
import { describe, expect, it } from 'vitest';
import { mkdtempSync, writeFileSync, readFileSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { claudeCodeStatuslineAdapter } from '../adapters/claude-code-statusline.js';
import { statePathFor } from '../state.js';

async function setupFixture(files: Record<string, string>) {
  const cwd = mkdtempSync(join(tmpdir(), 'hf-statusline-adapter-'));
  for (const [rel, content] of Object.entries(files)) {
    const full = join(cwd, rel);
    await mkdir(dirname(full), { recursive: true });
    writeFileSync(full, content);
  }
  return { cwd, homeDir: join(cwd, 'home') };
}

describe('Claude Code statusline adapter', () => {
  it('returns conflict for unmanaged existing user statusline', async () => {
    const f = await setupFixture({
      'home/.claude/settings.json':
        '{"statusLine":{"type":"command","command":"bash ~/.claude/statusline-wrapper.sh"}}',
    });
    const result = await claudeCodeStatuslineAdapter.apply({
      projectRoot: f.cwd,
      homeDir: f.homeDir,
      scope: 'user',
      launcherPath: join(f.homeDir, '.hive-flow/bin/hive-flow-mcp-server'),
      statuslineLauncherPath: join(f.homeDir, '.hive-flow/bin/claude-code-statusline'),
      dryRun: false,
      forceAdopt: false,
      createConfig: false,
      statePath: statePathFor('user', f.homeDir, f.cwd),
    });
    expect(result.outcome).toBe('conflict:manual-entry');
  });

  it('warns when project-local statusLine overrides user-scope install', async () => {
    const f = await setupFixture({
      'home/.claude/settings.json': '{"permissions":{"allow":[]}}',
      '.claude/settings.local.json':
        '{"statusLine":{"type":"command","command":"echo local"}}',
    });
    const result = await claudeCodeStatuslineAdapter.apply({
      projectRoot: f.cwd,
      homeDir: f.homeDir,
      scope: 'user',
      launcherPath: join(f.homeDir, '.hive-flow/bin/hive-flow-mcp-server'),
      statuslineLauncherPath: join(f.homeDir, '.hive-flow/bin/claude-code-statusline'),
      dryRun: false,
      forceAdopt: false,
      createConfig: false,
      statePath: statePathFor('user', f.homeDir, f.cwd),
    });

    expect(result.outcome).toBe('applied');
    expect(result.message).toContain('will override user settings');
  });

  it('force-adopts and uninstall restores previous statusline', async () => {
    const f = await setupFixture({
      'home/.claude/settings.json':
        '{"statusLine":{"type":"command","command":"bash ~/.claude/statusline-wrapper.sh","padding":0}}',
    });
    const ctx = {
      projectRoot: f.cwd,
      homeDir: f.homeDir,
      scope: 'user' as const,
      launcherPath: join(f.homeDir, '.hive-flow/bin/hive-flow-mcp-server'),
      statuslineLauncherPath: join(f.homeDir, '.hive-flow/bin/claude-code-statusline'),
      dryRun: false,
      forceAdopt: true,
      createConfig: false,
      statePath: statePathFor('user', f.homeDir, f.cwd),
    };

    const applied = await claudeCodeStatuslineAdapter.apply(ctx);
    expect(applied.outcome).toBe('applied');
    expect(readFileSync(join(f.homeDir, '.claude/settings.json'), 'utf8'))
      .toContain('claude-code-statusline');

    const removed = await claudeCodeStatuslineAdapter.uninstall({ ...ctx, forceAdopt: false });
    expect(removed.outcome).toBe('applied');
    const restored = readFileSync(join(f.homeDir, '.claude/settings.json'), 'utf8');
    expect(restored).toContain('statusline-wrapper.sh');
  });
});
