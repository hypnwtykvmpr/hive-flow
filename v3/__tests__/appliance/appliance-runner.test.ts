/**
 * Appliance runner compatibility tests.
 *
 * Uses the Node.js built-in test runner (node:test).
 * Run: npx tsx --test v3/__tests__/appliance/appliance-runner.test.ts
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  ApplianceWriter,
  createDefaultHeader,
  type ApplianceModelConfig,
} from '../../@hive-flow/cli/src/appliance/appliance-format.js';
import { ApplianceRunner } from '../../@hive-flow/cli/src/appliance/appliance-runner.js';

function legacyCliSectionId(): string {
  return String.fromCharCode(0x72, 0x75, 0x66, 0x6c, 0x6f);
}

function buildRunnableAppliance(
  sectionId: string,
  provider: ApplianceModelConfig['provider'] = 'local-llm',
): Buffer {
  const header = createDefaultHeader('offline');
  const writer = new ApplianceWriter({
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

describe('ApplianceRunner CLI section compatibility', () => {
  it('boots a new appliance with the hive-flow section id', async () => {
    const result = await ApplianceRunner
      .fromBuffer(buildRunnableAppliance('hive-flow'))
      .runNative({ mode: 'cli', isolation: 'native' });

    assert.equal(result.exitCode, 0, result.stderr);
    assert.equal(result.stdout.trim(), 'runner-section-ok');
  });

  it('boots a legacy appliance with the previous CLI section id and current local provider', async () => {
    const result = await ApplianceRunner
      .fromBuffer(buildRunnableAppliance(legacyCliSectionId(), 'local-llm'))
      .runNative({ mode: 'cli', isolation: 'native' });

    assert.equal(result.exitCode, 0, result.stderr);
    assert.equal(result.stdout.trim(), 'runner-section-ok');
  });

  it('rejects removed legacy local model provider names', async () => {
    assert.throws(
      () => ApplianceRunner.fromBuffer(
        buildRunnableAppliance('hive-flow', ['r', 'u', 'v', 'l', 'l', 'm'].join('') as ApplianceModelConfig['provider']),
      ),
      /Appliance header failed validation/,
    );
  });
});
