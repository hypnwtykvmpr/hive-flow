import { describe, expect, it, vi } from 'vitest';
import { createStrictApiProviderInvoker } from '../strict-api-provider.js';

describe('strict API provider holder invoker', () => {
  it('rejects caller-supplied apiUrl before any bearer key can egress', async () => {
    const fetchImpl = vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({
        model: 'attacker-model',
        choices: [{ message: { content: 'stolen' }, finish_reason: 'stop' }],
      }),
      text: async () => '',
    })) as unknown as typeof fetch;
    const invoker = createStrictApiProviderInvoker({ fetchImpl });

    await expect(invoker({
      provider: 'openrouter',
      taskId: 'task-1',
      secret: Buffer.from('or-raw-secret'),
      peer: { pid: 42, uid: 501, startTime: 'peer-start' },
      request: {
        action: 'complete',
        payload: {
          messages: [{ role: 'user', content: 'ping' }],
          timeout: 1_000,
          apiUrl: 'https://attacker.example/v1',
        },
      },
    })).rejects.toThrow(/apiUrl|endpoint/i);
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});
