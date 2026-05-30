// v3/@hive-flow/cli/src/statusline/__tests__/provider-metrics-migration.test.ts
//
// Phase 11 acceptance-matrix coverage for the provider metrics migration:
// legacy flat + nested shapes, corrupt JSON, missing file, idempotent replay,
// backup creation, and survival across `statusline repair --target scoreboard`.

import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import {
  mkdtempSync,
  rmSync,
  writeFileSync,
  existsSync,
  readFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { migrateProviderUsageJson } from '../provider-metrics-migration.js';
import { repairLedger } from '../repair.js';

describe('provider metrics migration', () => {
  let root: string;
  let input: string;
  let output: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'hf-provider-'));
    input = join(root, 'provider-usage.json');
    output = join(root, '.hive-flow', 'scoreboard', 'current.json');
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it('migrates flat provider metrics and backs up the legacy file', async () => {
    writeFileSync(input, JSON.stringify({ openai: { calls: 2, tokens: 100, ttfb_avg_ms: 50 } }));
    const r = await migrateProviderUsageJson({ projectRoot: root, projectKey: 'p', inputPath: input, outputPath: output });
    expect(r.migrated).toBe(true);
    expect(existsSync(`${input}.hive-flow.bak`)).toBe(true);
    const summary = JSON.parse(readFileSync(output, 'utf8'));
    // 'openai' normalizes to the 'codex' provider lane.
    expect(summary.callsByProvider.codex.calls).toBe(2);
    expect(summary.callsByProvider.codex.tokensTotal).toBe(100);
  });

  it('migrates nested providers metrics', async () => {
    writeFileSync(input, JSON.stringify({ providers: { gemini: { calls: 3, tokens: 120 } } }));
    const r = await migrateProviderUsageJson({ projectRoot: root, projectKey: 'p', inputPath: input, outputPath: output });
    expect(r.migrated).toBe(true);
    const summary = JSON.parse(readFileSync(output, 'utf8'));
    expect(summary.callsByProvider.gemini.calls).toBe(3);
  });

  it('does not throw and reports not-migrated when the input file is absent', async () => {
    const r = await migrateProviderUsageJson({ projectRoot: root, projectKey: 'p', inputPath: input, outputPath: output });
    expect(r.migrated).toBe(false);
    expect(r.providers).toEqual([]);
    expect(r.skippedReason).toBeUndefined();
  });

  it('reports corrupt JSON via skippedReason instead of throwing', async () => {
    writeFileSync(input, '{ this is not valid json ');
    const r = await migrateProviderUsageJson({ projectRoot: root, projectKey: 'p', inputPath: input, outputPath: output });
    expect(r.migrated).toBe(false);
    expect(r.skippedReason).toMatch(/invalid JSON/);
  });

  it('is idempotent: repeated migration runs do not double-count', async () => {
    writeFileSync(input, JSON.stringify({ openai: { calls: 2, tokens: 100 } }));
    await migrateProviderUsageJson({ projectRoot: root, projectKey: 'p', inputPath: input, outputPath: output });
    await migrateProviderUsageJson({ projectRoot: root, projectKey: 'p', inputPath: input, outputPath: output });
    const summary = JSON.parse(readFileSync(output, 'utf8'));
    expect(summary.callsByProvider.codex.calls).toBe(2);
  });

  it('does not collide when two legacy labels normalize to the same provider', async () => {
    writeFileSync(
      input,
      JSON.stringify({
        openai: { calls: 2, tokens: 100, last_used: '2026-05-29T01:00:00.000Z' },
        codex: { calls: 2, tokens: 100, last_used: '2026-05-29T01:00:00.000Z' },
      }),
    );

    await migrateProviderUsageJson({ projectRoot: root, projectKey: 'p', inputPath: input, outputPath: output });
    const summary = JSON.parse(readFileSync(output, 'utf8'));
    expect(summary.callsByProvider.codex.calls).toBe(4);
    expect(summary.callsByProvider.codex.tokensTotal).toBe(200);

    await migrateProviderUsageJson({ projectRoot: root, projectKey: 'p', inputPath: input, outputPath: output });
    const rerun = JSON.parse(readFileSync(output, 'utf8'));
    expect(rerun.callsByProvider.codex.calls).toBe(4);
    expect(rerun.callsByProvider.codex.tokensTotal).toBe(200);
  });

  it('survives scoreboard repair and repeated migration runs', async () => {
    writeFileSync(input, JSON.stringify({ openai: { calls: 2, tokens: 100 } }));
    await migrateProviderUsageJson({ projectRoot: root, projectKey: 'p', inputPath: input, outputPath: output });
    await migrateProviderUsageJson({ projectRoot: root, projectKey: 'p', inputPath: input, outputPath: output });
    await repairLedger({ projectRoot: root, target: 'scoreboard' });
    const summary = JSON.parse(readFileSync(output, 'utf8'));
    expect(summary.callsByProvider.codex.calls).toBe(2);
    expect(summary.callsByProvider.codex.tokensTotal).toBe(100);
  });

  it('skips providers with zero or non-positive call counts', async () => {
    writeFileSync(input, JSON.stringify({ openai: { calls: 0 }, gemini: { calls: 3 } }));
    const r = await migrateProviderUsageJson({ projectRoot: root, projectKey: 'p', inputPath: input, outputPath: output });
    expect(r.providers).toEqual(['gemini']);
    const summary = JSON.parse(readFileSync(output, 'utf8'));
    expect(summary.callsByProvider.codex).toBeUndefined();
    expect(summary.callsByProvider.gemini.calls).toBe(3);
  });
});
