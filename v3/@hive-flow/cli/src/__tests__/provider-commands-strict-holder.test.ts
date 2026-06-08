import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  healthCalls: [] as string[],
  holderStatus: vi.fn(() => ({ available: false, reason: 'missing holder' })),
}));

vi.mock('@hive-flow/shared', () => ({
  ProviderRegistry: class {
    get size() {
      return 2;
    }

    async initialize() {
      return undefined;
    }

    getAll() {
      return [
        {
          metadata: {
            id: 'openrouter',
            name: 'OpenRouter',
            type: 'openrouter',
            models: ['model-a'],
            apiKeyEnvVar: 'OPENROUTER_API_KEY',
          },
        },
        {
          metadata: {
            id: 'anthropic',
            name: 'Anthropic',
            type: 'anthropic',
            models: ['claude'],
            apiKeyEnvVar: 'ANTHROPIC_API_KEY',
          },
        },
      ];
    }

    getAllIds() {
      return ['openrouter', 'anthropic'];
    }

    async checkHealth(id: string) {
      mocks.healthCalls.push(id);
      return { status: 'healthy', latencyMs: 1 };
    }
  },
}));

vi.mock('../credential-store/strict-api-provider.js', async () => {
  const actual = await vi.importActual<typeof import('../credential-store/strict-api-provider.js')>(
    '../credential-store/strict-api-provider.js',
  );
  return {
    ...actual,
    probeCredentialHolderStatus: mocks.holderStatus,
  };
});

import { providersCommand } from '../commands/providers.js';
import { output } from '../output.js';
import type { CommandContext } from '../types.js';

function ctx(flags: Record<string, unknown> = {}): CommandContext {
  return {
    args: [],
    flags: { _: [], ...flags } as CommandContext['flags'],
    cwd: process.cwd(),
    interactive: false,
  };
}

function subcommand(name: string) {
  const command = providersCommand.subcommands?.find((candidate) => candidate.name === name);
  if (!command?.action) throw new Error(`missing providers ${name} action`);
  return command;
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.healthCalls.length = 0;
  mocks.holderStatus.mockReturnValue({ available: false, reason: 'missing holder' });
  delete process.env.OPENROUTER_API_KEY;
  delete process.env.ANTHROPIC_API_KEY;
});

describe('providers command strict API holder status', () => {
  it('does not mark strict API providers active from ambient env keys', async () => {
    process.env.OPENROUTER_API_KEY = 'or-secret-that-must-not-matter';
    const table = vi.spyOn(output, 'printTable').mockImplementation(() => undefined);
    vi.spyOn(output, 'writeln').mockImplementation(() => undefined);
    vi.spyOn(output, 'printInfo').mockImplementation(() => undefined);

    await subcommand('list').action!(ctx());

    const data = table.mock.calls[0]?.[0].data as Array<Record<string, string>>;
    const openrouter = data.find((row) => row.provider === 'OpenRouter');
    expect(openrouter?.status).toContain('Holder needed');
    expect(JSON.stringify(data)).not.toContain('or-secret-that-must-not-matter');
  });

  it('does not call registry env health for strict API provider tests', async () => {
    const spinner = {
      start: vi.fn(),
      succeed: vi.fn(),
      fail: vi.fn(),
      stop: vi.fn(),
      setText: vi.fn(),
    };
    vi.spyOn(output, 'createSpinner').mockReturnValue(spinner);
    vi.spyOn(output, 'writeln').mockImplementation(() => undefined);
    vi.spyOn(output, 'printInfo').mockImplementation(() => undefined);

    await subcommand('test').action!(ctx({ provider: 'openrouter' }));

    expect(mocks.healthCalls).toEqual([]);
    expect(spinner.stop).toHaveBeenCalledWith(expect.stringContaining('holder needed'));
  });
});
