import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { embeddingsTools } from '../embeddings-tools.js';

const initNeuralTool = embeddingsTools.find((tool) => tool.name === 'embeddings_neural');
const statusTool = embeddingsTools.find((tool) => tool.name === 'embeddings_status');

describe('embeddings hivector config compatibility', () => {
  let originalCwd: string;
  let tempDir: string;

  beforeEach(() => {
    originalCwd = process.cwd();
    tempDir = mkdtempSync(join(tmpdir(), 'hive-flow-embeddings-compat-'));
    process.chdir(tempDir);
  });

  afterEach(() => {
    process.chdir(originalCwd);
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('writes the primary hivector key when initializing neural kernels', async () => {
    expect(initNeuralTool).toBeDefined();
    mkdirSync('.hive-flow', { recursive: true });
    writeFileSync(
      join('.hive-flow', 'embeddings.json'),
      JSON.stringify(baseConfig(), null, 2),
      'utf8',
    );

    const result = await initNeuralTool!.handler({ action: 'init' }) as { success: boolean };
    const written = JSON.parse(readFileSync(join('.hive-flow', 'embeddings.json'), 'utf8'));

    expect(result.success).toBe(true);
    expect(written.neural.hivector).toEqual({
      enabled: true,
      sona: true,
      flashAttention: true,
      ewcPlusPlus: true,
    });
    expect(written.neural.ruvector).toBeUndefined();
  });

  it('still reads legacy ruvector configs as enabled hivector status', async () => {
    expect(statusTool).toBeDefined();
    mkdirSync('.hive-flow', { recursive: true });
    writeFileSync(
      join('.hive-flow', 'embeddings.json'),
      JSON.stringify({
        ...baseConfig(),
        neural: {
          enabled: true,
          driftThreshold: 0.3,
          decayRate: 0.01,
          ruvector: {
            enabled: true,
            sona: true,
            flashAttention: true,
            ewcPlusPlus: true,
          },
        },
      }, null, 2),
      'utf8',
    );

    const result = await statusTool!.handler({}) as {
      success: boolean;
      config: { neural: { hivector: boolean } };
    };

    expect(result.success).toBe(true);
    expect(result.config.neural.hivector).toBe(true);
  });
});

function baseConfig() {
  return {
    model: 'all-MiniLM-L6-v2',
    modelPath: '.hive-flow/models',
    dimension: 384,
    cacheSize: 256,
    hyperbolic: {
      enabled: true,
      curvature: -1,
      epsilon: 1e-15,
      maxNorm: 1 - 1e-5,
    },
    neural: {
      enabled: true,
      driftThreshold: 0.3,
      decayRate: 0.01,
    },
    initialized: '2026-06-07T00:00:00.000Z',
  };
}
