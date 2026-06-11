import { describe, expect, it, vi } from 'vitest';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { createStrictApiProviderInvoker, defaultCredentialHolderSocketPath } from '../strict-api-provider.js';

describe('credential holder socket path resolution', () => {
  it('keeps explicit holder socket ahead of all defaults', () => {
    expect(defaultCredentialHolderSocketPath({
      HIVE_FLOW_CREDENTIAL_HOLDER_SOCKET: '/tmp/explicit-holder.sock',
      XDG_RUNTIME_DIR: '/tmp/runtime',
      HIVE_FLOW_HOME: '/tmp/hive-home',
      HOME: '/tmp/home',
    })).toBe('/tmp/explicit-holder.sock');
  });

  it('keeps XDG_RUNTIME_DIR ahead of HIVE_FLOW_HOME on POSIX', () => {
    if (process.platform === 'win32') return;
    expect(defaultCredentialHolderSocketPath({
      XDG_RUNTIME_DIR: '/tmp/runtime',
      HIVE_FLOW_HOME: '/tmp/hive-home',
      HOME: '/tmp/home',
    })).toBe(join('/tmp/runtime', 'credential-holder.sock'));
  });

  it('uses HIVE_FLOW_HOME run dir when XDG_RUNTIME_DIR is not set on POSIX', () => {
    if (process.platform === 'win32') return;
    expect(defaultCredentialHolderSocketPath({
      HIVE_FLOW_HOME: '/tmp/hive-home',
      HOME: '/tmp/home',
    })).toBe(join('/tmp/hive-home', 'run', 'credential-holder.sock'));
  });

  it('uses os.homedir instead of process cwd when HOME is unset on POSIX', () => {
    if (process.platform === 'win32') return;
    const socketPath = defaultCredentialHolderSocketPath({ HOME: '' });

    expect(socketPath).toBe(join(homedir(), '.hive-flow', 'run', 'credential-holder.sock'));
    expect(socketPath).not.toBe(join(process.cwd(), '.hive-flow', 'run', 'credential-holder.sock'));
  });
});

describe('strict API provider holder invoker', () => {
  it('forwards OpenAI-compatible tools, tool_choice, and tool-result messages without exposing holder-owned secrets', async () => {
    let observedBody: Record<string, unknown> | undefined;
    const fetchImpl = vi.fn(async (_url, init) => {
      observedBody = JSON.parse(String(init?.body || '{}'));
      return new Response(JSON.stringify({
        model: 'deepseek-v4-pro',
        choices: [{
          message: {
            content: '',
            tool_calls: [{
              id: 'call_read_version',
              type: 'function',
              function: {
                name: 'read_file',
                arguments: JSON.stringify({ path: 'package.json' }),
              },
            }],
          },
          finish_reason: 'tool_calls',
        }],
        usage: { prompt_tokens: 12, completion_tokens: 4, total_tokens: 16 },
      }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }) as unknown as typeof fetch;
    const invoker = createStrictApiProviderInvoker({ fetchImpl });

    const result = await invoker({
      provider: 'deepseek',
      taskId: 'task-tools',
      secret: Buffer.from('ds-holder-secret-material'),
      peer: { pid: 42, uid: 501, startTime: 'peer-start' },
      request: {
        action: 'complete',
        payload: {
          messages: [
            { role: 'system', content: 'Use tools.' },
            { role: 'user', content: 'Read package.json.' },
            {
              role: 'assistant',
              content: '',
              toolCalls: [{
                id: 'call_existing',
                type: 'function',
                function: {
                  name: 'read_file',
                  arguments: JSON.stringify({ path: 'package.json' }),
                },
              }],
            },
            {
              role: 'tool',
              toolCallId: 'call_existing',
              name: 'read_file',
              content: '{"version":"1.0.0"}',
            },
          ],
          tools: [{
            type: 'function',
            function: {
              name: 'read_file',
              description: 'Read a jailed project file.',
              parameters: {
                type: 'object',
                properties: { path: { type: 'string' } },
                required: ['path'],
              },
            },
          }],
          toolChoice: 'auto',
          timeout: 1_000,
        },
      },
    });

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(observedBody).toMatchObject({
      model: 'deepseek-v4-pro',
      tool_choice: 'auto',
      tools: [{
        type: 'function',
        function: {
          name: 'read_file',
        },
      }],
    });
    expect(observedBody?.messages).toEqual([
      { role: 'system', content: 'Use tools.' },
      { role: 'user', content: 'Read package.json.' },
      {
        role: 'assistant',
        content: '',
        tool_calls: [{
          id: 'call_existing',
          type: 'function',
          function: {
            name: 'read_file',
            arguments: JSON.stringify({ path: 'package.json' }),
          },
        }],
      },
      {
        role: 'tool',
        content: '{"version":"1.0.0"}',
        tool_call_id: 'call_existing',
        name: 'read_file',
      },
    ]);
    expect(JSON.stringify(observedBody)).not.toContain('ds-holder-secret-material');
    expect(result.toolCalls?.[0]).toMatchObject({
      id: 'call_read_version',
      function: { name: 'read_file' },
    });
    expect(result.finishReason).toBe('tool_calls');
  });

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

  it('redacts provider failure bodies before surfacing errors', async () => {
    const plantedBearer = 'Bearer sk-ant-' + 'a'.repeat(48);
    const plantedOpenRouterKey = 'or-' + 'b'.repeat(48);
    const plantedBlob = Buffer.from('strict-api-provider-error-leak-fixture'.repeat(3)).toString('base64');
    const fetchImpl = vi.fn(async () => new Response(
      `upstream rejected ${plantedBearer} ${plantedOpenRouterKey} ${plantedBlob}`,
      { status: 401 },
    )) as unknown as typeof fetch;
    const invoker = createStrictApiProviderInvoker({ fetchImpl });

    let message = '';
    try {
      await invoker({
        provider: 'openrouter',
        taskId: 'task-1',
        secret: Buffer.from('or-holder-secret-material'),
        peer: { pid: 42, uid: 501, startTime: 'peer-start' },
        request: {
          action: 'complete',
          payload: {
            messages: [{ role: 'user', content: 'ping' }],
            timeout: 1_000,
          },
        },
      });
    } catch (error) {
      message = (error as Error).message;
    }

    expect(message).toContain('[REDACTED]');
    expect(message).not.toContain(plantedBearer);
    expect(message).not.toContain(plantedOpenRouterKey);
    expect(message).not.toContain(plantedBlob);
    expect(message).not.toContain('or-holder-secret-material');
  });
});
