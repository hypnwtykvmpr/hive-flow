import { describe, expect, it, vi } from 'vitest';
import {
  buildProviderConfig,
  isProviderAuthError,
  notifyProviderAuthRequired,
} from '../scripts/provider-auth-helpers.mjs';

describe('provider auth helpers', () => {
  it('does not map OPENROUTER_API_KEY into strict OpenRouter config or child env', () => {
    const config = buildProviderConfig({
      providerName: 'openrouter',
      model: 'opus-model',
      timeoutMs: 9000,
      agentToken: 'spawn-token',
      defaults: {},
      env: { OPENROUTER_API_KEY: 'or-env-secret' },
      cwd: '/tmp/project',
    });

    expect(config).toMatchObject({
      provider: 'openrouter',
      model: 'opus-model',
      timeout: 9000,
      retryAttempts: 2,
      retryDelay: 1000,
      env: {
        HIVE_FLOW_AGENT_TOKEN: 'spawn-token',
      },
    });
    expect(config).not.toHaveProperty('apiKey');
    expect(config.env ?? {}).not.toHaveProperty('OPENROUTER_API_KEY');
    expect(JSON.stringify(config)).not.toContain('or-env-secret');
  });

  it('ignores config-file OpenRouter credential references in serialized provider config', () => {
    const config = buildProviderConfig({
      providerName: 'openrouter',
      model: undefined,
      timeoutMs: undefined,
      agentToken: '',
      defaults: { openrouter: 'default-openrouter-model' },
      env: {
        OPENROUTER_API_KEY: 'or-env-secret',
        HF_OPENROUTER_KEY: 'or-config-secret',
      },
      cwd: '/tmp/project',
      fs: {
        existsSync: () => true,
        readFileSync: () => JSON.stringify({
          values: {
            openrouter: {
              credentialSource: 'env:HF_OPENROUTER_KEY',
            },
          },
        }),
      },
    });

    expect(config.model).toBe('default-openrouter-model');
    expect(config).not.toHaveProperty('apiKey');
    expect(config.env ?? {}).not.toHaveProperty('OPENROUTER_API_KEY');
    expect(JSON.stringify(config)).not.toContain('or-env-secret');
    expect(JSON.stringify(config)).not.toContain('or-config-secret');
  });

  it('does not hydrate OpenRouter from config-file env references when OPENROUTER_API_KEY is absent', () => {
    const config = buildProviderConfig({
      providerName: 'openrouter',
      model: 'custom',
      timeoutMs: 0,
      agentToken: '',
      defaults: {},
      env: { HF_OPENROUTER_KEY: 'or-config-secret' },
      cwd: '/tmp/project',
      fs: {
        existsSync: () => true,
        readFileSync: () => JSON.stringify({
          values: {
            openrouter: {
              credentialSource: 'env:HF_OPENROUTER_KEY',
            },
          },
        }),
      },
    });

    expect(config).not.toHaveProperty('apiKey');
    expect(config.env ?? {}).not.toHaveProperty('OPENROUTER_API_KEY');
    expect(JSON.stringify(config)).not.toContain('or-config-secret');
  });

  it('does not hydrate OpenRouter from bare apiKeyEnv references', () => {
    const config = buildProviderConfig({
      providerName: 'openrouter',
      model: 'custom',
      timeoutMs: undefined,
      agentToken: '',
      defaults: {},
      env: { HF_OPENROUTER_KEY: 'or-config-secret' },
      cwd: '/tmp/project',
      fs: {
        existsSync: () => true,
        readFileSync: () => JSON.stringify({
          values: {
            openrouter: {
              apiKeyEnv: 'HF_OPENROUTER_KEY',
            },
          },
        }),
      },
    });

    expect(config).not.toHaveProperty('apiKey');
    expect(config.env ?? {}).not.toHaveProperty('OPENROUTER_API_KEY');
    expect(JSON.stringify(config)).not.toContain('or-config-secret');
  });

  it('classifies provider auth failures without marking generic errors as auth', () => {
    const auth = new Error('Authentication failed for provider');
    auth.code = 'AUTHENTICATION';
    auth.statusCode = 401;
    auth.retryable = false;

    expect(isProviderAuthError(auth)).toBe(true);
    expect(isProviderAuthError(new Error('binary not found'))).toBe(false);
  });

  it('sends a hooks_notify escalation without leaking credentials', async () => {
    const callMCPTool = vi.fn(async () => ({ delivered: true }));

    await notifyProviderAuthRequired({
      providerName: 'openrouter',
      reason: '401 invalid api key or-secret-value',
      callMCPTool,
    });

    expect(callMCPTool).toHaveBeenCalledWith('hooks_notify', expect.objectContaining({
      target: 'human',
      priority: 'high',
      message: expect.stringContaining('OpenRouter credentials missing/invalid'),
      data: expect.objectContaining({
        provider: 'openrouter',
        reason: '401 invalid api key [redacted]',
      }),
    }));
    const payload = callMCPTool.mock.calls[0][1];
    expect(JSON.stringify(payload)).not.toContain('or-secret-value');
  });
});
