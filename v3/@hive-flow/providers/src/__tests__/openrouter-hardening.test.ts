import { afterEach, describe, expect, it } from 'vitest';
import { createFakeHttpServer, assertNoSecretLeak } from '@hive-flow/testing/helpers';

import { OpenRouterProvider } from '../openrouter-provider.js';
import { AuthenticationError } from '../types.js';

const SECRET = 'sk-or-v1-abcdefghijklmnopqrstuvwxyz123456';

afterEach(() => {
  delete process.env.OPENROUTER_API_KEY;
});

describe('OpenRouter provider hardening with local fake server', () => {
  it('completes against a local server without external network access', async () => {
    const seenAuth: string[] = [];
    const server = await createFakeHttpServer((req, res) => {
      seenAuth.push(String(req.headers.authorization || ''));
      if (req.url === '/models') {
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify({ data: [{ id: 'test/model', context_length: 4096 }] }));
        return;
      }
      if (req.url === '/chat/completions') {
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify({
          id: 'chatcmpl-test',
          object: 'chat.completion',
          created: 1,
          model: 'test/model',
          choices: [{ index: 0, message: { role: 'assistant', content: 'PONG' }, finish_reason: 'stop' }],
          usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
        }));
        return;
      }
      res.statusCode = 404;
      res.end('not found');
    });
    try {
      const provider = new OpenRouterProvider({
        config: {
          provider: 'openrouter',
          model: 'test/model',
          apiKey: SECRET,
          apiUrl: server.origin,
          timeout: 2_000,
        },
      });
      await provider.initialize();
      const response = await provider.complete({ messages: [{ role: 'user', content: 'ping' }] });
      expect(response.content).toBe('PONG');
      expect(seenAuth).toContain(`Bearer ${SECRET}`);
    } finally {
      await server.close();
    }
  });

  it('fails authentication without leaking the configured key in the thrown error', async () => {
    const server = await createFakeHttpServer((req, res) => {
      if (req.url === '/models') {
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify({ data: [{ id: 'test/model', context_length: 4096 }] }));
        return;
      }
      res.statusCode = 401;
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ error: { message: 'invalid credentials' } }));
    });
    try {
      const provider = new OpenRouterProvider({
        config: {
          provider: 'openrouter',
          model: 'test/model',
          apiKey: SECRET,
          apiUrl: server.origin,
          timeout: 2_000,
        },
      });
      await provider.initialize();
      let thrown: unknown;
      try {
        await provider.complete({ messages: [{ role: 'user', content: 'ping' }] });
      } catch (err) {
        thrown = err;
      }
      expect(thrown).toBeInstanceOf(AuthenticationError);
      assertNoSecretLeak(String((thrown as Error | undefined)?.message || thrown));
    } finally {
      await server.close();
    }
  });
});
