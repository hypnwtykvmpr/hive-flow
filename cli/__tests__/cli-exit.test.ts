import { spawnSync } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const here = dirname(fileURLToPath(import.meta.url));
const CLI_BIN = resolve(here, '..', 'bin', 'cli.js');

describe('CLI process exit', () => {
  it('force-exits after a successful normal CLI run even when live handles remain', () => {
    const root = mkdtempSync(resolve(tmpdir(), 'hf-cli-exit-'));
    try {
      mkdirSync(resolve(root, 'bin'), { recursive: true });
      mkdirSync(resolve(root, 'dist/src'), { recursive: true });
      writeFileSync(resolve(root, 'package.json'), JSON.stringify({ type: 'module' }), 'utf8');
      cpSync(CLI_BIN, resolve(root, 'bin/cli.js'));
      cpSync(resolve(here, '..', 'bin', 'npx-repair.js'), resolve(root, 'bin/npx-repair.js'));
      writeFileSync(
        resolve(root, 'dist/src/index.js'),
        [
          'export class CLI {',
          '  async run() {',
          '    setInterval(() => {}, 1000);',
          '    console.log("stub CLI run resolved");',
          '  }',
          '}',
          '',
        ].join('\n'),
        'utf8',
      );

      const result = spawnSync(process.execPath, [resolve(root, 'bin/cli.js'), 'canary'], {
        timeout: 1500,
        encoding: 'utf8',
        env: {
          ...process.env,
          HOME: root,
        },
      });

      expect(result.status).not.toBeNull();
      expect(result.status).toBe(0);
      expect(result.stdout).toContain('stub CLI run resolved');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('exits successfully after --version without parking on live handles', () => {
    const result = spawnSync(process.execPath, [CLI_BIN, '--version'], {
      timeout: 5000,
      encoding: 'utf8',
    });

    expect(result.status).not.toBeNull();
    expect(result.status).toBe(0);
    expect(result.stdout).toMatch(/hive-flow/);
  });
});
