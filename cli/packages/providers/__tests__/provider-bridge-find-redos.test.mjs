/**
 * HF-21 (find_file ReDoS) regression.
 *
 * ROOT CAUSE: the glob→regex builder escaped only `.` then translated
 * `*`/`**`/`?`, leaving ALL OTHER regex metacharacters (`+ ( ) [ ] { } ^ $ | \`)
 * UNESCAPED. A glob pattern like `(a+)+$` therefore injected a
 * catastrophic-backtracking regex into `matchesPattern` / `shouldIgnore`. A
 * timeout does NOT help — matching is synchronous and in-process.
 *
 * FIX: `globToSafeRegExp` FIRST escapes EVERY regex metacharacter, THEN
 * translates ONLY the intended glob wildcards (`**`→`.*`, `*`→`[^/]*`,
 * `?`→`[^/]`). After full escaping, user input cannot inject quantifiers/groups,
 * so the ReDoS surface is eliminated. Belt-and-suspenders: patterns >256 chars
 * are rejected and adjacent `*` runs collapsed.
 *
 * These exercise the exported pure builder directly (no child process) so the
 * timing assertions are tight and deterministic.
 */
import { describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const bridgePath = resolve(here, '../scripts/provider-agent-bridge.mjs');
const bridge = await import(pathToFileURL(bridgePath).href);
const { globToSafeRegExp } = bridge;

function matches(filename, glob) {
  const re = globToSafeRegExp(glob);
  return re ? re.test(filename) : false;
}

describe('HF-21 find_file glob→regex ReDoS hardening', () => {
  it('catastrophic-backtracking glob `(a+)+$` does NOT hang and matches literally', () => {
    const evil = '(a+)+$';
    const adversarial = 'a'.repeat(40) + 'c'; // would hang a backtracking regex
    const start = Date.now();
    const result = matches(adversarial, evil);
    expect(Date.now() - start).toBeLessThan(50);
    // Fully escaped: the glob is treated as the literal text "(a+)+$" which the
    // adversarial input does not equal.
    expect(result).toBe(false);
    // And a filename that IS the literal pattern matches.
    expect(matches('(a+)+$', evil)).toBe(true);
  });

  it('alternation-bomb glob `a*a*a*...*b` completes quickly returning false', () => {
    const evil = 'a*'.repeat(20) + 'b';
    const adversarial = 'a'.repeat(60); // no trailing b
    const start = Date.now();
    const result = matches(adversarial, evil);
    expect(Date.now() - start).toBeLessThan(50);
    expect(result).toBe(false);
  });

  it('rejects patterns longer than 256 chars (no-match, no work)', () => {
    const tooLong = '*'.repeat(257);
    expect(globToSafeRegExp(tooLong)).toBeNull();
    expect(matches('anything', tooLong)).toBe(false);
  });

  it('rejects patterns with more than GLOB_MAX_WILDCARDS (3) wildcards', () => {
    expect(globToSafeRegExp('a*'.repeat(4) + 'b')).toBeNull(); // 4 stars > 3
    expect(globToSafeRegExp('a*'.repeat(3) + 'b')).not.toBeNull(); // 3 stars ok
  });

  it('AT the cap (3 wildcards), the built regex stays fast on a long failing input', () => {
    // The bug-hunter's missing test: pin the cap value's safety. The cost scales
    // with wildcards × candidate length, so 3 wildcards against a 255-char input
    // must still complete fast (data: N=3 @ 255 ≈ 24ms).
    const re = globToSafeRegExp('a*'.repeat(3) + 'b'); // exactly 3 stars
    expect(re).not.toBeNull();
    const longFail = 'a'.repeat(255); // no trailing b → forces full backtrack
    const start = Date.now();
    const r = re.test(longFail);
    expect(Date.now() - start).toBeLessThan(100);
    expect(r).toBe(false);
  });

  it('negative controls: ordinary globs still match correctly', () => {
    expect(matches('index.ts', '*.ts')).toBe(true);
    expect(matches('index.js', '*.ts')).toBe(false);
    expect(matches('src/deep/index.ts', '**/*.ts')).toBe(true);
    expect(matches('a.ts', '?.ts')).toBe(true);
    expect(matches('ab.ts', '?.ts')).toBe(false);
    // `*` is single-segment, `**` crosses segments.
    expect(matches('src/x.ts', '*.ts')).toBe(false);
    expect(matches('foo.test.ts', '*.test.ts')).toBe(true);
  });

  it('collapses adjacent `*` runs without changing single-segment semantics', () => {
    // `***` (or more) should behave like `**` (globstar), not blow up.
    expect(matches('a/b/c.ts', '***.ts')).toBe(true);
  });

  it('regex metacharacters in a glob are treated as literals', () => {
    expect(matches('a+b.txt', 'a+b.txt')).toBe(true);
    expect(matches('aab.txt', 'a+b.txt')).toBe(false); // `+` is literal, not a quantifier
    expect(matches('file(1).txt', 'file(1).txt')).toBe(true);
    expect(matches('[id].vue', '[id].vue')).toBe(true);
  });
});

describe('HF-21 shouldIgnore (gitignore wildcard) shares the safe builder', () => {
  // CRITICAL: shouldIgnore's wildcard branch used a SECOND, distinct glob→regex
  // builder (`.replace(/\*/g,'.*')`, unescaped) — a separate ReDoS path. A
  // prompt-injected agent can write_file a `.gitignore` (in-jail) then call
  // find_file, so a malicious gitignore rule must NOT hang. shouldIgnore now
  // routes every `*`-containing rule through globToSafeRegExp; exercising the
  // builder with a `*`-bearing malicious rule proves that path is safe (the
  // wildcard branch fires only when the rule contains `*`).
  it('a `*`-bearing catastrophic gitignore rule does NOT hang the builder', () => {
    const evilRule = '*(a+)+$'; // has `*` → enters shouldIgnore's wildcard branch
    const adversarial = 'a'.repeat(60) + 'c';
    const start = Date.now();
    const re = globToSafeRegExp(evilRule);
    const r = re ? re.test(adversarial) : false;
    expect(Date.now() - start).toBeLessThan(50);
    expect(r).toBe(false); // metacharacters are literal; no quantifier injection
  });

  it('the 256-char length cap also applies to gitignore-rule input', () => {
    const tooLongRule = '*' + 'a'.repeat(260); // >256, contains `*`
    expect(globToSafeRegExp(tooLongRule)).toBeNull();
  });
});

describe('HF-21 find_file ReDoS — end to end through find_file', () => {
  // A pathological pattern through the real find_file tool must not hang the
  // bridge. We import and call the tool in-process against this repo's own
  // __tests__ dir (small, real). Success = it returns promptly.
  it('find_file with a ReDoS-shaped pattern returns promptly', async () => {
    const start = Date.now();
    const result = await bridge.executeBridgeFilesystemTool('find_file', {
      pattern: '(a+)+$',
      path: resolve(here),
    });
    expect(Date.now() - start).toBeLessThan(5_000);
    expect(typeof result).toBe('string'); // JSON array of paths (likely empty)
  });

  // Full e2e: a real `.gitignore` containing a `*`-bearing catastrophic rule in
  // a fixture dir under this repo (so find_file's PROJECT_ROOT jail accepts it),
  // plus a long-'a' filename. shouldIgnore parses+matches the rule per entry; if
  // it still used the unescaped builder this would hang. Must complete <5s.
  it('find_file does not hang on a malicious .gitignore rule', async () => {
    const fixture = mkdtempSync(join(here, 'redos-gitignore-'));
    try {
      mkdirSync(fixture, { recursive: true });
      writeFileSync(join(fixture, '.gitignore'), '*(a+)+$\n', 'utf8');
      writeFileSync(join(fixture, 'a'.repeat(80) + 'c.txt'), 'x', 'utf8');
      const start = Date.now();
      const result = await bridge.executeBridgeFilesystemTool('find_file', {
        pattern: '*.txt',
        path: fixture,
      });
      expect(Date.now() - start).toBeLessThan(5_000);
      expect(typeof result).toBe('string');
    } finally {
      rmSync(fixture, { recursive: true, force: true });
    }
  });

  // Length-bound path: a deep tree makes `relativePath` exceed 256 chars, and a
  // 3-wildcard `.gitignore` rule (at the cap) would still backtrack on that long
  // candidate WITHOUT the length bound. shouldIgnore skips the regex when the
  // candidate is too long → must complete fast. (255-byte per-component filename
  // limit means we build depth, not one giant name.)
  it('find_file with a long relativePath + 3-wildcard gitignore rule stays fast', async () => {
    const fixture = mkdtempSync(join(here, 'redos-len-'));
    try {
      // ~30 dirs × 10 chars ≈ 300-char relativePath, past GLOB_MAX_CANDIDATE_LENGTH.
      let deep = fixture;
      for (let i = 0; i < 30; i += 1) deep = join(deep, 'aaaaaaaaaa');
      mkdirSync(deep, { recursive: true });
      writeFileSync(join(fixture, '.gitignore'), 'a*a*a*b\n', 'utf8'); // 3 wildcards (at cap)
      writeFileSync(join(deep, 'leaf.txt'), 'x', 'utf8');
      const start = Date.now();
      const result = await bridge.executeBridgeFilesystemTool('find_file', {
        pattern: '*.txt',
        path: fixture,
      });
      expect(Date.now() - start).toBeLessThan(5_000);
      expect(typeof result).toBe('string');
    } finally {
      rmSync(fixture, { recursive: true, force: true });
    }
  });
});
