// hive-flow-8b69 (Option B, Slice 1): the tracked canonical flow-watchdog source
// must load successfully as a module WITHOUT running its main watch loop, and must
// expose the watchdog's public surface. The live runtime copy under
// `.hive-flow/data/tmux-router/flow-watchdog.cjs` is generated from this tracked
// source by the install path (Slice 2) and stays untracked runtime state.
//
// `main()` in the source is guarded by `require.main === module`; requiring it from
// this test never makes it the process entry module, so the loop does not run.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const CANONICAL = join(here, '..', 'scripts', 'flow-watchdog.cjs');
const requireCanonical = createRequire(pathToFileURL(CANONICAL));

describe('flow-watchdog canonical tracked source (hive-flow-8b69 Slice 1)', () => {
  it('loads successfully without executing the main run loop', () => {
    let mod;
    assert.doesNotThrow(() => {
      mod = requireCanonical(CANONICAL);
    }, 'canonical source should require() cleanly and be module-level side-effect free');
    assert.equal(typeof mod, 'object');
  });

  it('exposes the watchdog public surface as functions', () => {
    const mod = requireCanonical(CANONICAL);
    for (const name of [
      'classifyHiveFlowTaskLiveness',
      'classifyPane',
      'classifyPaneStatus',
      'createWatchState',
      'hasActiveRouterHumanBlocker',
      'maintainKnotsLeases',
      'runOnce',
    ]) {
      assert.equal(typeof mod[name], 'function', `export ${name} should be a function`);
    }
  });
});
