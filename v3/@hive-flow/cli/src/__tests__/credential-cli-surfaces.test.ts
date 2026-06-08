import { beforeEach, describe, expect, it, vi } from 'vitest';

const runtimeMocks = vi.hoisted(() => ({
  initializeCredentialVault: vi.fn(async () => ({
    backend: { available: true },
    vaultPath: '/tmp/hive-flow-vault.json.gcm',
    createdVault: true,
    decrypts: true,
  })),
  storeProviderCredential: vi.fn(async () => ({
    provider: 'openrouter',
    vaultReady: true,
    stored: true,
  })),
  inspectCredentialKeyStatus: vi.fn(async () => ({
    provider: 'openrouter',
    present: true,
    drift: false,
    holderCache: false,
    unlock: 'available',
  })),
  repairCredentialVault: vi.fn(async () => ({
    repaired: true,
    vaultReady: true,
  })),
  removeProviderCredential: vi.fn(async () => ({
    provider: 'openrouter',
    removed: true,
  })),
}));

vi.mock('../credential-store/holder-runtime.js', async () => {
  const actual = await vi.importActual<typeof import('../credential-store/holder-runtime.js')>(
    '../credential-store/holder-runtime.js',
  );
  return {
    ...actual,
    initializeCredentialVault: runtimeMocks.initializeCredentialVault,
    storeProviderCredential: runtimeMocks.storeProviderCredential,
    inspectCredentialKeyStatus: runtimeMocks.inspectCredentialKeyStatus,
    repairCredentialVault: runtimeMocks.repairCredentialVault,
    removeProviderCredential: runtimeMocks.removeProviderCredential,
  };
});

vi.mock('@hive-flow/shared', () => ({
  ProviderRegistry: class {
    async initialize() {
      return undefined;
    }

    getAllIds() {
      return ['openrouter'];
    }

    async checkHealth() {
      return { status: 'healthy', latencyMs: 1 };
    }
  },
}));

import { configCommand } from '../commands/config.js';
import { doctorCommand } from '../commands/doctor.js';
import { providersCommand } from '../commands/providers.js';
import { setupCommand } from '../commands/setup.js';
import { output } from '../output.js';
import type { Command, CommandContext } from '../types.js';

function ctx(flags: Record<string, unknown> = {}, args: string[] = []): CommandContext {
  return {
    args,
    flags: { _: [], ...flags } as CommandContext['flags'],
    cwd: process.cwd(),
    interactive: false,
  };
}

function subcommand(command: Command, name: string): Command {
  const sub = command.subcommands?.find(candidate => candidate.name === name);
  if (!sub) throw new Error(`missing subcommand ${command.name} ${name}`);
  return sub;
}

function nested(command: Command, first: string, second: string): Command {
  return subcommand(subcommand(command, first), second);
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(output, 'writeln').mockImplementation(() => undefined);
  vi.spyOn(output, 'printInfo').mockImplementation(() => undefined);
  vi.spyOn(output, 'printSuccess').mockImplementation(() => undefined);
  vi.spyOn(output, 'printError').mockImplementation(() => undefined);
  vi.spyOn(output, 'printJson').mockImplementation(() => undefined);
  vi.spyOn(output, 'printBox').mockImplementation(() => undefined);
  vi.spyOn(output, 'createSpinner').mockReturnValue({
    start: vi.fn(),
    succeed: vi.fn(),
    fail: vi.fn(),
    stop: vi.fn(),
    setText: vi.fn(),
  });
});

describe('credential CLI surfaces', () => {
  it('config key set stores provider material through the credential runtime', async () => {
    const result = await nested(configCommand, 'key', 'set').action!(
      ctx({ provider: 'OpenRouter', value: 'or-cli-secret' }),
    );

    expect(result?.success).toBe(true);
    expect(runtimeMocks.storeProviderCredential).toHaveBeenCalledWith(expect.objectContaining({
      provider: 'OpenRouter',
      secret: 'or-cli-secret',
    }));
    expect(JSON.stringify(result)).not.toContain('or-cli-secret');
  });

  it('config key status reports non-secret presence, drift, holder-cache, and unlock fields', async () => {
    const result = await nested(configCommand, 'key', 'status').action!(
      ctx({ provider: 'openrouter', json: true, format: 'json' }),
    );

    expect(result?.success).toBe(true);
    expect(result?.data).toMatchObject({
      provider: 'openrouter',
      present: true,
      drift: false,
      holderCache: false,
      unlock: 'available',
    });
    expect(JSON.stringify(result)).not.toContain('or-cli-secret');
  });

  it('config key repair and remove delegate to credential runtime helpers', async () => {
    await nested(configCommand, 'key', 'repair').action!(ctx({ degraded: true }));
    await nested(configCommand, 'key', 'remove').action!(ctx({ provider: 'openrouter' }));

    expect(runtimeMocks.repairCredentialVault).toHaveBeenCalledWith(expect.objectContaining({
      allowDegraded: true,
    }));
    expect(runtimeMocks.removeProviderCredential).toHaveBeenCalledWith(expect.objectContaining({
      provider: 'openrouter',
    }));
  });

  it('providers configure --key stores the key through the vault-backed credential runtime', async () => {
    const result = await subcommand(providersCommand, 'configure').action!(
      ctx({ provider: 'openrouter', key: 'or-provider-secret' }),
    );

    expect(result?.success).toBe(true);
    expect(runtimeMocks.storeProviderCredential).toHaveBeenCalledWith(expect.objectContaining({
      provider: 'openrouter',
      secret: 'or-provider-secret',
    }));
    expect(JSON.stringify(result)).not.toContain('or-provider-secret');
  });

  it('setup credentials creates the per-machine KEK and empty vault', async () => {
    const result = await subcommand(setupCommand, 'credentials').action!(ctx({ degraded: true }));

    expect(result?.success).toBe(true);
    expect(runtimeMocks.initializeCredentialVault).toHaveBeenCalledWith(expect.objectContaining({
      allowDegraded: true,
    }));
  });

  it('doctor -c credentials reports credential health without values', async () => {
    const result = await doctorCommand.action!(ctx({ component: 'credentials' }));

    expect(result?.success).toBe(true);
    const data = result?.data as { results?: Array<{ name: string; message: string }> };
    expect(data.results?.some(row => row.name === 'Credential Store')).toBe(true);
    expect(JSON.stringify(result)).not.toContain('or-cli-secret');
  });
});
