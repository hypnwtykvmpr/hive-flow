import { existsSync, mkdirSync, readFileSync, writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { GEMINI_CLI_DEFAULT_MODEL } from '@hive-flow/providers';
import { providersCommand } from '../providers.js';
import {
  collectProviderStatuses,
  renderProviderRouteHook,
  renderProviderStatusHook,
  type ProviderHookRuntime,
} from '../provider-hook-runtime.js';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '../../../..');
const SETUP_PROVIDER_AGENTS_PATH = 'cli/packages/providers/scripts/setup-provider-agents.ts';

function makeHome(): string {
  return mkdtempSync(join(tmpdir(), 'hf-provider-hook-test-'));
}

describe('providers hook command surface', () => {
  it('exposes hidden provider hook subcommands through the CLI command tree', () => {
    const hookCommand = providersCommand.subcommands?.find((cmd) => cmd.name === 'hook');

    expect(hookCommand).toMatchObject({ hidden: true });
    expect(hookCommand?.subcommands?.map((cmd) => cmd.name).sort()).toEqual(['route', 'status']);
  });

  it('renders route suggestions from Claude-style hook stdin and cached provider status', () => {
    const home = makeHome();
    const cacheDir = join(home, '.hive-flow');
    mkdirSync(cacheDir, { recursive: true });
    writeFileSync(join(cacheDir, 'provider-status-cache.json'), JSON.stringify({
      timestamp: 1_000,
      providers: {
        'gemini-cli': {
          found: true,
          version: 'agy 1.2.3',
          binary: 'agy',
          timestamp: 1_000,
        },
      },
    }));

    const output = renderProviderRouteHook(
      JSON.stringify({ message: { content: 'Ask Gemini to review this change.' } }),
      { env: { HOME: home }, now: () => 1_000 },
    );

    expect(output).toContain('[PROVIDER_SUGGESTION] gemini-cli available (agy 1.2.3)');
    expect(output).toContain('provider: "gemini-cli"');
    expect(output).toContain(`model: "${GEMINI_CLI_DEFAULT_MODEL}"`);
  });

  it('detects provider status with agy as the gemini-cli binary and writes the status cache', () => {
    const home = makeHome();
    const execFile: ProviderHookRuntime['execFile'] = ((file: string, args?: readonly string[]) => {
      const argv = Array.from(args ?? []);
      if (file === 'which') {
        if (argv[0] === 'agy') return '/usr/bin/agy\n';
        throw new Error(`${argv[0]} not found`);
      }
      if (file === 'agy' && argv[0] === '--version') {
        return 'agy 1.2.3\n';
      }
      throw new Error(`unexpected command: ${file} ${argv.join(' ')}`);
    }) as ProviderHookRuntime['execFile'];

    const providers = collectProviderStatuses({
      env: { HOME: home },
      execFile,
      now: () => 2_000,
    });

    expect(providers['gemini-cli']).toMatchObject({
      found: true,
      version: 'agy 1.2.3',
      binary: 'agy',
    });
    expect(providers['codex-cli']).toMatchObject({ found: false });
    expect(renderProviderStatusHook(providers)).toContain('[PROVIDERS] gemini-cli: agy 1.2.3');
    expect(existsSync(join(home, '.hive-flow', 'provider-status-cache.json'))).toBe(true);
  });

  it('installs stable CLI hook commands instead of provider script paths', () => {
    const setupProviderAgentsPath = resolve(repoRoot, SETUP_PROVIDER_AGENTS_PATH);
    expect(setupProviderAgentsPath).toBeTruthy();
    expect(existsSync(setupProviderAgentsPath)).toBe(true);

    const source = readFileSync(
      setupProviderAgentsPath,
      'utf8',
    );

    expect(source).toContain('hive-flow providers hook route');
    expect(source).toContain('hive-flow providers hook status');
    expect(source).not.toContain('provider-route-hook.mjs');
    expect(source).not.toContain('provider-status-hook.mjs');
  });
});
