/**
 * RVFA runner compatibility tests.
 *
 * Uses the Node.js built-in test runner (node:test).
 * Run: npx tsx --test v3/__tests__/appliance/rvfa-runner.test.ts
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  RvfaWriter,
  createDefaultHeader,
  type RvfaModelConfig,
} from '../../@hive-flow/cli/src/appliance/rvfa-format.js';
import { RvfaRunner } from '../../@hive-flow/cli/src/appliance/rvfa-runner.js';

function buildRunnableAppliance(
  sectionId: 'hive-flow' | 'ruflo',
  provider: RvfaModelConfig['provider'] = 'local-llm',
): Buffer {
  const header = createDefaultHeader('offline');
  const writer = new RvfaWriter({
    ...header,
    name: `${sectionId}-runner-test`,
    boot: { ...header.boot, entrypoint: process.execPath, args: [] },
    models: { ...header.models, provider },
  });
  writer.addSection(sectionId, Buffer.from('console.log("runner-section-ok");\n'), {
    compression: 'none',
    type: 'application/javascript',
  });
  return writer.build();
}

describe('RvfaRunner CLI section compatibility', () => {
  it('boots a new appliance with the hive-flow section id', async () => {
    const result = await RvfaRunner
      .fromBuffer(buildRunnableAppliance('hive-flow'))
      .runNative({ mode: 'cli', isolation: 'native' });

    assert.equal(result.exitCode, 0, result.stderr);
    assert.equal(result.stdout.trim(), 'runner-section-ok');
  });

  it('boots a legacy appliance with the old CLI section id', async () => {
    const result = await RvfaRunner
      .fromBuffer(buildRunnableAppliance('ruflo', 'ruvllm'))
      .runNative({ mode: 'cli', isolation: 'native' });

    assert.equal(result.exitCode, 0, result.stderr);
    assert.equal(result.stdout.trim(), 'runner-section-ok');
  });
});
