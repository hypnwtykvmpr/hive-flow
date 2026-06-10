// v3/@hive-flow/cli/src/integrations/__tests__/wrapper-mode-adapter.test.ts

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createWrapperModeAdapter } from '../adapters/wrapper-mode.js';

let root: string;
let binDir: string;
let hiveHome: string;
let projectRoot: string;
let originalPath: string | undefined;
let originalHiveHome: string | undefined;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'hf-wrapper-adapter-'));
  binDir = join(root, 'host-bin');
  hiveHome = join(root, 'global-home');
  projectRoot = join(root, 'project');
  originalPath = process.env.PATH;
  originalHiveHome = process.env.HIVE_FLOW_HOME;
  process.env.HIVE_FLOW_HOME = hiveHome;
  process.env.PATH = `${binDir}${process.env.PATH ? `:${process.env.PATH}` : ''}`;
});

afterEach(() => {
  if (originalPath === undefined) delete process.env.PATH;
  else process.env.PATH = originalPath;
  if (originalHiveHome === undefined) delete process.env.HIVE_FLOW_HOME;
  else process.env.HIVE_FLOW_HOME = originalHiveHome;
  rmSync(root, { recursive: true, force: true });
});

function writeHostBinary(name: string): void {
  rmSync(binDir, { recursive: true, force: true });
  writeFileSync(join(root, '.keep'), '');
  mkdirSync(binDir, { recursive: true });
  writeFileSync(join(binDir, name), '#!/usr/bin/env bash\nexit 0\n');
  chmodSync(join(binDir, name), 0o755);
}

describe('createWrapperModeAdapter', () => {
  it('installs user-scoped wrappers under resolveHiveHome().home/bin', async () => {
    writeHostBinary('codex');
    const adapter = createWrapperModeAdapter({
      target: 'codex',
      hostCli: 'codex',
      hostBin: 'codex',
    });

    const result = await adapter.install({
      projectRoot,
      cliBin: '/usr/local/bin/hive-flow',
      scope: 'user',
      dryRun: true,
    });

    expect(result).toEqual({
      wrote: [join(hiveHome, 'bin', 'codex')],
      skipped: [],
    });
  });
});
