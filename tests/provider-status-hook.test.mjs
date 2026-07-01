import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, '..');
const SCRIPT = join(REPO_ROOT, 'v3/@hive-flow/cli/src/commands/provider-hook-runtime.ts');

describe('provider hook runtime (WP-43)', () => {
  it('should not contain bare execSync (only execFileSync)', () => {
    const source = readFileSync(SCRIPT, 'utf-8');

    // Match execSync that is NOT preceded by "File" (i.e. not execFileSync)
    const unsafeMatches = source.match(/(?<!File)execSync\s*\(/g);
    assert.equal(
      unsafeMatches,
      null,
      `File should not contain bare execSync calls. Found: ${JSON.stringify(unsafeMatches)}`,
    );
  });

  it('should import execFileSync from node:child_process', () => {
    const source = readFileSync(SCRIPT, 'utf-8');
    assert.ok(
      /import\s*\{[^}]*execFileSync[^}]*\}\s*from\s*['"]node:child_process['"]/.test(source),
      'Should import execFileSync from node:child_process',
    );
  });

  it('should not use template literal interpolation in any exec calls', () => {
    const source = readFileSync(SCRIPT, 'utf-8');

    // Look for any exec-family calls that use template literals with interpolation
    const templateExecPattern = /exec(?:File)?Sync\s*\(\s*`[^`]*\$\{/g;
    const templateMatches = source.match(templateExecPattern);
    assert.equal(
      templateMatches,
      null,
      `No exec calls should use template literal interpolation. Found: ${JSON.stringify(templateMatches)}`,
    );
  });

  it('should use array arguments for execFileSync calls', () => {
    const source = readFileSync(SCRIPT, 'utf-8');

    assert.ok(
      source.includes("execFile('which', [binary]"),
      'which probe should pass binary as an execFile array argument',
    );
    assert.ok(
      source.includes("execFile(binary, ['--version']"),
      'version probe should pass --version as an execFile array argument',
    );
  });
});
