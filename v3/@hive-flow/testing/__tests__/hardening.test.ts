import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import { existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import {
  assertNoSecretLeak,
  createFakeHttpServer,
  createTempProject,
  propertyRunsFromEnv,
  runProcess,
} from '../src/helpers/hardening.js';

describe('hardening test helpers', () => {
  it('creates and cleans isolated temp projects', () => {
    const project = createTempProject('hf-hardening-');
    try {
      const marker = join(project.root, 'marker.txt');
      writeFileSync(marker, 'ok');
      expect(existsSync(marker)).toBe(true);
    } finally {
      project.cleanup();
    }
    expect(existsSync(project.root)).toBe(false);
  });

  it('normalizes property run counts from env with a safe fallback', () => {
    fc.assert(
      fc.property(fc.oneof(fc.integer({ min: 1, max: 10_000 }).map(String), fc.constant('bad')), (raw) => {
        const env = { HIVE_FLOW_PROPERTY_RUNS: raw };
        const result = propertyRunsFromEnv(env, 77);
        if (/^[1-9][0-9]*$/.test(raw)) {
          expect(result).toBe(Number(raw));
        } else {
          expect(result).toBe(77);
        }
      }),
      { seed: 20_601, numRuns: 100 },
    );
  });

  it('runs child processes with stdin/stdout/stderr capture', async () => {
    const result = await runProcess(process.execPath, ['-e', 'process.stdin.pipe(process.stdout)'], {
      input: 'hello',
      timeoutMs: 5_000,
    });
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe('hello');
    expect(result.stderr).toBe('');
    expect(result.timedOut).toBe(false);
  });

  it('serves local HTTP responses without touching external networks', async () => {
    const server = await createFakeHttpServer((_req, res, body) => {
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ body }));
    });
    try {
      const response = await fetch(server.origin, { method: 'POST', body: 'ping' });
      await expect(response.json()).resolves.toEqual({ body: 'ping' });
    } finally {
      await server.close();
    }
  });

  it('detects secret-like output before logs or snapshots persist it', () => {
    expect(() => assertNoSecretLeak('plain diagnostic output')).not.toThrow();
    expect(() => assertNoSecretLeak('Authorization: Bearer sk-or-v1-abcdefghijklmnopqrstuvwxyz')).toThrow(
      /Secret-like value leaked/,
    );
  });
});
