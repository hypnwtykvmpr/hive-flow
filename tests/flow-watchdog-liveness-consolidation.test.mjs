// hive-flow-8b69 (Option B, Slice 3): prove the divergent watchdog liveness classifier
// is consolidated onto the single shared source of truth
// `cli/src/progress/hiveflow-task-liveness.cjs`, and that BOTH the source consumers
// (watchdog + progress-authority-classifier.ts) and the built dist consumer resolve the
// SAME implementation.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join } from 'node:path';
import { readFileSync, existsSync } from 'node:fs';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, '..');
const WATCHDOG = join(repoRoot, 'scripts', 'flow-watchdog.cjs');
const SHARED_SRC = join(repoRoot, 'cli', 'src', 'progress', 'hiveflow-task-liveness.cjs');
const SHARED_DIST = join(repoRoot, 'cli', 'dist', 'src', 'progress', 'hiveflow-task-liveness.cjs');
const CLASSIFIER_DIST = join(repoRoot, 'cli', 'dist', 'src', 'progress', 'progress-authority-classifier.js');

const requireFrom = createRequire(pathToFileURL(WATCHDOG));

describe('flow-watchdog liveness consolidation (hive-flow-8b69 Slice 3)', () => {
  it('the watchdog no longer defines its own classifyHiveFlowTaskLiveness', () => {
    const src = readFileSync(WATCHDOG, 'utf8');
    assert.equal(/function\s+classifyHiveFlowTaskLiveness\b/.test(src), false,
      'watchdog must not contain an inline classifyHiveFlowTaskLiveness implementation');
  });

  it('the watchdog and the shared source module export the SAME function reference', () => {
    const watchdog = requireFrom(WATCHDOG);
    const shared = requireFrom(SHARED_SRC);
    assert.equal(typeof shared.classifyHiveFlowTaskLiveness, 'function');
    assert.equal(watchdog.classifyHiveFlowTaskLiveness, shared.classifyHiveFlowTaskLiveness,
      'watchdog must use the shared source-of-truth classifier, not a copy');
  });

  it('the built dist copy is byte-identical to the shared source (build-copy proof)', () => {
    assert.ok(existsSync(SHARED_DIST),
      `expected build-copy to place ${SHARED_DIST} — run \`npm run build\` first`);
    assert.ok(readFileSync(SHARED_DIST).equals(readFileSync(SHARED_SRC)),
      'dist copy must be byte-identical to the tracked source');
  });

  it('the built dist classifier resolves the copied .cjs and behaves identically to source', async () => {
    if (!existsSync(CLASSIFIER_DIST)) {
      // Post-build gate: only meaningful once `cli` has been built.
      console.error(`[skip] ${CLASSIFIER_DIST} absent — run \`npm run build\` to exercise dist resolution.`);
      return;
    }
    const distMod = await import(pathToFileURL(CLASSIFIER_DIST));
    assert.equal(typeof distMod.classifyHiveFlowTaskLiveness, 'function',
      'dist classifier must resolve the copied .cjs re-export');
    const sourceClassify = requireFrom(SHARED_SRC).classifyHiveFlowTaskLiveness;
    // Same inputs → same verdict across source and dist consumers.
    const opts = { taskId: '', nowMs: 1_000 };
    assert.deepEqual(distMod.classifyHiveFlowTaskLiveness(opts), sourceClassify(opts));
  });
});
