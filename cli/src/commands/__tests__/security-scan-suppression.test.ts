// cli/src/commands/__tests__/security-scan-suppression.test.ts
//
// dc69: context-first false-positive suppression for `security scan`.
//
// The scanner self-flags its own detector definitions, its detector test
// fixtures, and documented examples. `classifySuppression` suppresses those
// ONLY when the *line context* proves the match is a detector definition, a
// detector fixture/example input, or a structurally impossible placeholder —
// never on a value marker substring and never on file path alone.
//
// These tests are the detection-preservation gate: real high-entropy
// credentials and real prod-looking unsafe patterns MUST still flag with
// suppression on, in both test and production paths. `--strict` reproduces the
// raw match set exactly.
//
// Secret/unsafe shapes are assembled at RUNTIME so this source file contains no
// literal that trips the repo's own secret scanner or the security write-hook.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import securityCommand, { classifySuppression } from '../security.js';
import type { Command, CommandContext } from '../../types.js';

// ---------------------------------------------------------------------------
// Runtime builders (no offending literal appears in this source)
// ---------------------------------------------------------------------------

const rnd = (n: number, upper = false): string => {
  const set = upper
    ? 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789'
    : 'abcdefghijklmnopqrstuvwxyz0123456789';
  let s = '';
  for (let i = 0; i < n; i++) s += set[(i * 7 + 5) % set.length];
  return s;
};
const q = (v: string): string => "'" + v + "'";

const skLive = 'sk_' + 'live_' + rnd(26); // real high-entropy Stripe live key
const skTest = 'sk_' + 'test_' + rnd(26); // real high-entropy Stripe TEST-mode key
const ghp = 'ghp_' + rnd(36); // real GitHub token
const aws = 'AKIA' + rnd(16, true); // real AWS access key
const weakPw = 'adm' + 'in123'; // hardcoded weak password
const EVAL = 'ev' + 'al';
const EXEC = 'ex' + 'ec';
const CP = 'child_' + 'process';

const PROD_PATH = 'cli/src/app/config.ts';
const TEST_PATH = 'cli/src/app/__tests__/config.test.ts';
const DETECTION_SOURCE = 'cli/src/commands/security.ts';

// ---------------------------------------------------------------------------
// Detection preservation — real secrets STILL flag with suppression on
// ---------------------------------------------------------------------------

describe('classifySuppression — real secrets still flag (suppression on)', () => {
  const shapes: Array<[string, string]> = [
    ['sk_live', skLive],
    ['sk_test', skTest],
    ['ghp', ghp],
    ['aws', aws],
  ];

  for (const [name, value] of shapes) {
    for (const relPath of [PROD_PATH, TEST_PATH]) {
      it(`${name} on a normal line in ${relPath.includes('__tests__') ? 'test' : 'prod'} file flags`, () => {
        const line = 'const credential = ' + q(value) + ';';
        expect(classifySuppression(line, q(value), relPath, 'secret')).toEqual({
          suppress: false,
        });
      });
    }
  }

  it('a marker substring in the value (sk_test) never suppresses — same value, context decides', () => {
    // Same test-mode key: flagged on a normal line, suppressed only in a
    // detector-definition call context. This proves suppression is
    // context-first, not value-marker-first.
    const normalLine = 'const k = ' + q(skTest) + ';';
    const detectorLine = 'evaluateSecrets(' + q(skTest) + ');';
    expect(classifySuppression(normalLine, q(skTest), PROD_PATH, 'secret').suppress).toBe(false);
    expect(classifySuppression(detectorLine, q(skTest), TEST_PATH, 'secret').suppress).toBe(true);
  });

  it('a real token on a NON-detector line inside a detection-source file still flags', () => {
    // Path is corroboration only: security.ts is a detector-source file, but a
    // credential on a plain assignment line there is not a detector definition.
    const line = 'const leaked = ' + q(skLive) + ';';
    expect(classifySuppression(line, q(skLive), DETECTION_SOURCE, 'secret')).toEqual({
      suppress: false,
    });
  });

  it('a hardcoded weak password in prod-looking code still flags', () => {
    const line = 'const p = ' + q(weakPw) + ';';
    expect(classifySuppression(line, q(weakPw), PROD_PATH, 'secret').suppress).toBe(false);
  });

  it('a fixture field (content:) holding a real secret in a PROD path still flags', () => {
    // Fixture suppression requires a corroborating test/fixture/detector path.
    const line = 'content: ' + q('api_key = "' + skLive + '"') + ',';
    expect(classifySuppression(line, q(skLive), PROD_PATH, 'secret').suppress).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Detection preservation — real unsafe patterns STILL flag (Codex constraint)
// ---------------------------------------------------------------------------

describe('classifySuppression — real unsafe patterns still flag (suppression on)', () => {
  it('a real prod dynamic-code-execution call flags', () => {
    const line = 'const out = ' + EVAL + '(userInput);';
    expect(classifySuppression(line, EVAL + '(', PROD_PATH, 'unsafe').suppress).toBe(false);
  });

  it('a real prod child-process exec call flags', () => {
    const line = CP + '.' + EXEC + '(userCommand, cb);';
    expect(classifySuppression(line, CP + '.' + EXEC + '(', PROD_PATH, 'unsafe').suppress).toBe(false);
  });

  it('a real prod SQL-template interpolation flags', () => {
    // 'sq'+'l' keeps this source file itself out of the scanner's SQL matcher.
    const frag = 'sq' + 'l += ` WHERE id=' + '${' + 'userId}`;';
    expect(classifySuppression(frag, '${' + 'userId}', PROD_PATH, 'unsafe').suppress).toBe(false);
  });

  it('does not apply placeholder logic to unsafe matches (no cross-contamination)', () => {
    // A template interpolation is a placeholder for a SECRET value, but for an
    // unsafe SQL match it is the injection itself — must NOT be suppressed.
    const line = 'query(`SELECT * FROM t WHERE x=' + '${' + 'v}`);';
    expect(classifySuppression(line, '${' + 'v}', PROD_PATH, 'unsafe').suppress).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Suppression positives — detector definitions / fixtures / placeholders
// ---------------------------------------------------------------------------

describe('classifySuppression — suppresses source-grounded false positives', () => {
  it('detector-definition: secret passed to a detection API', () => {
    const line = 'const r = detectSecrets(' + q(skLive) + ');';
    expect(classifySuppression(line, q(skLive), TEST_PATH, 'secret')).toEqual({
      suppress: true,
      reason: 'detector-definition',
    });
  });

  it('detector-definition: must-not-contain rule value', () => {
    // 'pass'+'word=' keeps this source file itself out of the scanner's secret matcher.
    const line = "{ type: 'must-not-contain', value: '" + 'pass' + 'word=' + "', severity: 'critical' },";
    expect(classifySuppression(line, "'password='", 'cli/src/guidance/analyzer.ts', 'secret').reason).toBe(
      'detector-definition',
    );
  });

  it('detector-definition: pattern object field with a regex literal (unsafe self-match)', () => {
    const line = '{ pattern: /' + EVAL + '\\s*\\(/g, type: ' + q('Eval Usage') + ' },';
    expect(classifySuppression(line, EVAL + '(', DETECTION_SOURCE, 'unsafe').reason).toBe(
      'detector-definition',
    );
  });

  it('detector-definition: standalone whole-line regex array element (unsafe self-match)', () => {
    const line = '  /\\b' + CP + '\\.(?:' + EXEC + '|spawn)\\b/,';
    expect(classifySuppression(line, CP + '.' + EXEC, 'cli/src/permission-guard/deep-inspect.ts', 'unsafe').reason).toBe(
      'detector-definition',
    );
  });

  it('detector-definition: altPattern regex field', () => {
    const line = 'altPattern: /' + CP + '.*' + EXEC + '.*\\+/gi,';
    expect(
      classifySuppression(line, CP + '.' + EXEC, 'cli/src/testing/regression/security-regression.ts', 'unsafe').reason,
    ).toBe('detector-definition');
  });

  it('detector-fixture: content field in a test file', () => {
    const line = 'content: ' + q('api_key = "' + skLive + '"') + ',';
    expect(classifySuppression(line, q(skLive), TEST_PATH, 'secret')).toEqual({
      suppress: true,
      reason: 'detector-fixture',
    });
  });

  it('placeholder-value: angle-bracket, template, masked, fill-in token, all-x', () => {
    const cases = ['<your-key>', '${' + 'ENV_KEY}', '****', 'YOUR_KEY_HERE', 'xxxxxxxxxxxx'];
    for (const v of cases) {
      const line = 'const apiKey = ' + q(v) + ';';
      expect(classifySuppression(line, q(v), PROD_PATH, 'secret')).toEqual({
        suppress: true,
        reason: 'placeholder-value',
      });
    }
  });

  it('placeholder-value is NOT applied to unsafe matches', () => {
    const line = 'const x = ' + q('<your-key>') + ';';
    // matchType 'unsafe' never reaches the placeholder rule.
    expect(classifySuppression(line, q('<your-key>'), PROD_PATH, 'unsafe').suppress).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Integration — strict/raw parity + suppressed-count over a real scan
// ---------------------------------------------------------------------------

interface ScanData {
  total: number;
  suppressedCount: number;
  strict: boolean;
  findings: Array<{ location: string; type: string }>;
  suppressed: Array<{ location: string; type: string; reason: string }>;
}

function getScan(): Command {
  const sub = securityCommand.subcommands?.find((c) => c.name === 'scan');
  if (!sub) throw new Error('scan subcommand not found');
  return sub;
}

function mkCtx(dir: string, flags: Record<string, string | boolean>): CommandContext {
  return {
    cwd: dir,
    args: [],
    flags: { _: [], target: dir, type: 'code', depth: 'standard', ...flags },
    interactive: false,
  };
}

describe('security scan — strict/raw parity and suppressed count', () => {
  let dir: string;

  beforeEach(() => {
    vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    dir = mkdtempSync(join(tmpdir(), 'hf-dc69-scan-'));
    // Line 1: a real credential on a normal line -> must flag in BOTH modes.
    // Line 2: the same shape passed to a detection API -> a false positive that
    //         is suppressed in normal mode and reappears under --strict.
    const content = [
      'const apiKey = ' + q(skLive) + ';',
      'evaluateSecrets(' + q(skTest) + ');',
    ].join('\n');
    writeFileSync(join(dir, 'sample.ts'), content + '\n');
  });

  afterEach(() => {
    vi.restoreAllMocks();
    rmSync(dir, { recursive: true, force: true });
  });

  it('normal mode flags the real secret and suppresses the detector-call FP', async () => {
    const res = await getScan().action!(mkCtx(dir, {}));
    const data = (res as { data: ScanData }).data;
    expect(data.strict).toBe(false);
    expect(data.total).toBe(1);
    expect(data.suppressedCount).toBe(1);
    // The kept finding is the real secret on line 1, not the detector call.
    expect(data.findings.every((f) => !f.location.endsWith(':2'))).toBe(true);
    expect(data.findings.some((f) => f.location.endsWith('sample.ts:1'))).toBe(true);
    expect(
      data.suppressed.some((s) => s.location.endsWith(':2') && s.reason === 'detector-definition'),
    ).toBe(true);
  });

  it('--strict reproduces the raw match set (no suppression)', async () => {
    const res = await getScan().action!(mkCtx(dir, { strict: true }));
    const data = (res as { data: ScanData }).data;
    expect(data.strict).toBe(true);
    expect(data.suppressedCount).toBe(0);
    expect(data.total).toBe(2); // both matches present
  });

  it('--no-suppress is an alias for --strict', async () => {
    const res = await getScan().action!(mkCtx(dir, { 'no-suppress': true }));
    const data = (res as { data: ScanData }).data;
    expect(data.strict).toBe(true);
    expect(data.total).toBe(2);
  });

  it('parity invariant: strict.total === normal.total + normal.suppressedCount', async () => {
    const normal = (await getScan().action!(mkCtx(dir, {}))) as { data: ScanData };
    const strict = (await getScan().action!(mkCtx(dir, { strict: true }))) as { data: ScanData };
    expect(strict.data.total).toBe(normal.data.total + normal.data.suppressedCount);
  });
});
