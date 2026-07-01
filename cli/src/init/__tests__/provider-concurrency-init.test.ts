import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import { executeInit } from '../executor.js';
import { DEFAULT_INIT_OPTIONS, type InitOptions } from '../types.js';

function runtimeOnlyOptions(targetDir: string, force = false): InitOptions {
  return {
    ...DEFAULT_INIT_OPTIONS,
    targetDir,
    force,
    interactive: false,
    components: {
      ...DEFAULT_INIT_OPTIONS.components,
      settings: false,
      skills: false,
      commands: false,
      agents: false,
      helpers: false,
      statusline: false,
      mcp: false,
      runtime: true,
      claudeMd: false,
    },
  };
}

describe('provider concurrency init', () => {
  it('creates an empty probe-populated provider concurrency config on first runtime init', async () => {
    const root = mkdtempSync(join(tmpdir(), 'hf-provider-concurrency-init-'));
    try {
      const result = await executeInit(runtimeOnlyOptions(root, true));
      expect(result.errors, result.errors.join('\n')).toEqual([]);
      expect(result.success).toBe(true);

      const configPath = join(root, '.hive-flow', 'provider-concurrency.json');
      const config = JSON.parse(readFileSync(configPath, 'utf8'));
      expect(config).toEqual({
        version: 1,
        updatedAt: null,
        providers: {},
      });
      expect(result.created.files).toContain('.hive-flow/provider-concurrency.json');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('does not overwrite probe-generated provider caps on normal re-init', async () => {
    const root = mkdtempSync(join(tmpdir(), 'hf-provider-concurrency-preserve-'));
    try {
      const first = await executeInit(runtimeOnlyOptions(root, true));
      expect(first.success).toBe(true);

      const configPath = join(root, '.hive-flow', 'provider-concurrency.json');
      const probed = {
        version: 1,
        updatedAt: '2026-06-28T00:00:00.000Z',
        providers: {
          deepseek: {
            maxConcurrentTasks: 29,
            probedAt: '2026-06-28T00:00:00.000Z',
            evidence: { attempted: 30, successful: 29, rejected: 1 },
          },
        },
      };
      writeFileSync(configPath, `${JSON.stringify(probed, null, 2)}\n`, 'utf8');

      const second = await executeInit(runtimeOnlyOptions(root, false));
      expect(second.errors, second.errors.join('\n')).toEqual([]);
      expect(second.success).toBe(true);
      expect(JSON.parse(readFileSync(configPath, 'utf8'))).toEqual(probed);
      expect(second.skipped).toContain('.hive-flow/provider-concurrency.json');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
