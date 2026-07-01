/**
 * HF-12 (grep timeout / no-hang) + HF-6-T8 (result-limit disclosure) regression.
 *
 * HF-12: the grep `execFileSync` had `maxBuffer` but NO `timeout`, so a
 *   pathological ERE on the GNU-grep fallback or a slow large-repo match hung
 *   the bridge synchronously. A timeout/kill must surface as a NON-GROUNDING
 *   honest error (status:'error'), never a fabricated successful empty search.
 *   The `rg --version` probe gets its own short timeout too.
 * HF-6-T8: when matches exceed maxResults the handler truncated SILENTLY; it
 *   must now disclose the truncation with a [RESULTS TRUNCATED: …] marker.
 *
 * Harness mirrors provider-bridge-grep-behavior.test.mjs: a fake `rg` on PATH
 * driven through the exported `executeBridgeFilesystemTool('grep', …)` in a
 * child with cwd=projectRoot.
 */
import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const bridgePath = resolve(here, '../scripts/provider-agent-bridge.mjs');

/**
 * A fake `rg` whose body is supplied per-test. Every variant must answer
 * `--version` (the probe) unless the test wants to exercise probe behavior.
 */
function makeFixture(rgSource) {
  const projectRoot = mkdtempSync(join(tmpdir(), 'hf-grep-hard-'));
  const fakeBin = join(projectRoot, 'fake-bin');
  mkdirSync(fakeBin, { recursive: true });
  const rgPath = join(fakeBin, 'rg');
  writeFileSync(rgPath, rgSource, 'utf8');
  chmodSync(rgPath, 0o755);

  mkdirSync(join(projectRoot, '.hive-flow', 'enforcement'), { recursive: true });
  mkdirSync(join(projectRoot, 'src'), { recursive: true });
  writeFileSync(join(projectRoot, '.hive-flow', 'enforcement', '.hmac-key'),
    '0'.repeat(64) + '\n', 'utf8');
  writeFileSync(join(projectRoot, 'src', 'public.txt'), 'searchable\n', 'utf8');
  return { projectRoot, fakeBin };
}

function runBridgeGrep(projectRoot, fakeBin, args) {
  const bridgeUrl = pathToFileURL(bridgePath).href;
  const script = `
    const bridge = await import(${JSON.stringify(bridgeUrl)});
    const result = await bridge.executeBridgeFilesystemTool('grep', ${JSON.stringify(args)});
    process.stdout.write(typeof result === 'string' ? JSON.stringify({ __string: result }) : JSON.stringify(result));
  `;
  const out = execFileSync(process.execPath, ['--input-type=module', '-e', script], {
    cwd: projectRoot,
    env: { ...process.env, PATH: fakeBin + delimiter + process.env.PATH, CLAUDE_PROJECT_DIR: projectRoot },
    encoding: 'utf8',
  });
  const parsed = JSON.parse(out);
  return Object.prototype.hasOwnProperty.call(parsed, '__string') ? parsed.__string : parsed;
}

// Fake rg that answers --version then emits N matching lines.
const rgEmitting = (n) => `#!/usr/bin/env node
const args = process.argv.slice(2);
if (args.includes('--version')) { console.log('ripgrep 14.1.0'); process.exit(0); }
const lines = [];
for (let i = 0; i < ${n}; i++) lines.push('src/public.txt:' + (i + 1) + ':match ' + i);
console.log(lines.join('\\n'));
`;

// Fake rg that answers --version then HANGS on the real search (simulates a
// pathological/slow match). A real timeout on the execFileSync must kill it.
const rgHangOnSearch = `#!/usr/bin/env node
const args = process.argv.slice(2);
if (args.includes('--version')) { console.log('ripgrep 14.1.0'); process.exit(0); }
setTimeout(() => {}, 600000); // hang far longer than GREP_TIMEOUT_MS
`;

// Fake rg whose --version PROBE itself hangs (HF-12 probe timeout).
const rgHangOnProbe = `#!/usr/bin/env node
setTimeout(() => {}, 600000);
`;

// Fake rg whose --version probe FAILS (non-zero) so the handler falls back to
// GNU grep — used to exercise the grep fallback timeout (HF-12).
const rgProbeFails = `#!/usr/bin/env node
process.exit(2);
`;

// Fake grep that HANGS on a real search (no maxBuffer/exit). The grep fallback
// execFileSync timeout must kill it.
const grepHangs = `#!/usr/bin/env node
setTimeout(() => {}, 600000);
`;

/**
 * Fixture variant that ALSO shadows `grep` in fakeBin (prepended on PATH so it
 * wins over system grep). `node` stays resolvable via the inherited PATH so the
 * shebang scripts run.
 */
function makeFixtureWithGrep(rgSource, grepSource) {
  const { projectRoot, fakeBin } = makeFixture(rgSource);
  const grepPath = join(fakeBin, 'grep');
  writeFileSync(grepPath, grepSource, 'utf8');
  chmodSync(grepPath, 0o755);
  return { projectRoot, fakeBin };
}

describe('HF-12 grep timeout (no synchronous hang)', () => {
  it('a slow/hanging search is killed and returns a non-grounding error, not fake success', () => {
    const { projectRoot, fakeBin } = makeFixture(rgHangOnSearch);
    const start = Date.now();
    const r = runBridgeGrep(projectRoot, fakeBin, { pattern: 'needle' });
    const elapsed = Date.now() - start;
    // Must NOT hang for the full 600s child sleep; the bridge timeout fires.
    expect(elapsed).toBeLessThan(120_000);
    // Honest error result — NOT a fabricated "No matches found" success string.
    expect(r).not.toBe('No matches found');
    expect(typeof r).toBe('object');
    expect(r.status).toBe('error');
    expect(r.tool).toBe('grep');
    expect(r.error).toMatch(/timed out|Search failed/i);
  }, 130_000);

  it('a hanging `rg --version` probe is killed and does not hang the bridge', () => {
    const { projectRoot, fakeBin } = makeFixture(rgHangOnProbe);
    const start = Date.now();
    // Probe times out → falls back to grep (which is real on PATH after fakeBin),
    // OR surfaces an error. Either way it must return quickly, never hang.
    runBridgeGrep(projectRoot, fakeBin, { pattern: 'searchable' });
    expect(Date.now() - start).toBeLessThan(60_000);
  }, 70_000);

  it('the GNU-grep FALLBACK timeout fires (rg absent) → non-grounding error, not fake success', () => {
    // rg probe fails (exit 2) → handler falls back to GNU grep, which hangs.
    // Search `src` (no protected subtree) so needsProtectedFilter is false and
    // the fallback reaches the grep execFileSync instead of the protected guard.
    const { projectRoot, fakeBin } = makeFixtureWithGrep(rgProbeFails, grepHangs);
    const start = Date.now();
    const r = runBridgeGrep(projectRoot, fakeBin, { pattern: 'searchable', path: 'src' });
    expect(Date.now() - start).toBeLessThan(120_000);
    expect(r).not.toBe('No matches found');
    expect(typeof r).toBe('object');
    expect(r.status).toBe('error');
    expect(r.tool).toBe('grep');
    expect(r.error).toMatch(/timed out|Search failed/i);
  }, 130_000);
});

describe('HF-6-T8 grep result-limit disclosure', () => {
  it('discloses truncation when matches exceed maxResults', () => {
    const { projectRoot, fakeBin } = makeFixture(rgEmitting(120));
    const r = runBridgeGrep(projectRoot, fakeBin, { pattern: 'match' }); // default maxResults=50
    expect(typeof r).toBe('string');
    expect(r).toMatch(/\[RESULTS TRUNCATED: showing 50 of 120 matches/);
    // Still returns exactly maxResults match lines plus the marker line.
    const matchLines = r.split('\n').filter((l) => l.startsWith('src/public.txt:'));
    expect(matchLines.length).toBe(50);
  });

  it('respects an explicit max_results in the disclosure', () => {
    const { projectRoot, fakeBin } = makeFixture(rgEmitting(30));
    const r = runBridgeGrep(projectRoot, fakeBin, { pattern: 'match', max_results: 10 });
    expect(r).toMatch(/\[RESULTS TRUNCATED: showing 10 of 30 matches/);
  });

  it('does NOT add a truncation marker when matches are within maxResults', () => {
    const { projectRoot, fakeBin } = makeFixture(rgEmitting(5));
    const r = runBridgeGrep(projectRoot, fakeBin, { pattern: 'match' });
    expect(r).not.toMatch(/RESULTS TRUNCATED/);
    expect(r.split('\n').filter((l) => l.startsWith('src/public.txt:')).length).toBe(5);
  });

  it('negative control: a normal grep returns its lines', () => {
    const { projectRoot, fakeBin } = makeFixture(rgEmitting(3));
    const r = runBridgeGrep(projectRoot, fakeBin, { pattern: 'match' });
    expect(r).toMatch(/src\/public\.txt:1:match 0/);
  });
});
