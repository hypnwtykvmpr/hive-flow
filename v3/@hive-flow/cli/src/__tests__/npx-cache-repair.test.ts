import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

import { describe, expect, it } from 'vitest';

const REPO_ROOT = resolve(__dirname, '../../../../..');

describe('npx cache repair pruning', () => {
  it('keeps the hive-flow cacache predicate non-tautological across shipped repair paths', () => {
    const files = [
      'package.json',
      'hive-flow-npm/package.json',
      'bin/npx-repair.js',
      'v3/@hive-flow/cli/bin/preinstall.cjs',
    ];
    const duplicateHiveFlowPredicate =
      /(content|content2|c)\.(?:includes\('hive-flow'\)|indexOf\('hive-flow'\)\s*!==\s*-1)\s*\|\|\s*\1\.(?:includes\('hive-flow'\)|indexOf\('hive-flow'\)\s*!==\s*-1)/;

    const hits = files.filter((file) =>
      duplicateHiveFlowPredicate.test(readFileSync(resolve(REPO_ROOT, file), 'utf8')),
    );

    expect(hits).toEqual([]);
  });

  it('classifies hive-flow cacache entries without pruning unrelated package entries', async () => {
    const repairModule = (await import(pathToFileURL(resolve(REPO_ROOT, 'bin/npx-repair.js')).href)) as {
      isHiveFlowCacheIndexEntry: (content: string) => boolean;
    };

    expect(repairModule.isHiveFlowCacheIndexEntry('https://registry.npmjs.org/hive-flow')).toBe(true);
    expect(repairModule.isHiveFlowCacheIndexEntry('https://registry.npmjs.org/@hive-flow/cli')).toBe(true);
    expect(repairModule.isHiveFlowCacheIndexEntry('https://registry.npmjs.org/left-pad')).toBe(false);
  });
});
