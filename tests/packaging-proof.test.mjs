// Packaging proof test.
//
// Guards against regressions in the npm `files` allowlists for BOTH the root
// `hive-flow` umbrella package and the `@hive-flow/cli` package.
//
// It runs `npm pack --dry-run --json` (with an ISOLATED npm cache to avoid
// EPERM on the shared ~/.npm cache), and for the root package it also creates a
// real tarball and scans the packed file CONTENTS. It asserts:
//   - no dev/state junk ships (.context-tracker, checkpoints, *.db*, sessions,
//     enforcement, .hive-flow data, worktrees, DELETE_*, TRASH/),
//   - no hardcoded developer absolute path (/Users/<dev>/.../hive-flow) inside
//     any packaged file or script,
//   - runtime init templates ship (.claude/{commands,helpers,skills} + agents/),
//   - CLI helper sources ship (dist/credential-store/helpers/*),
//   - bin entry scripts are present and carry the executable bit.
//
// NOTE: this test shells out to `npm pack` and is therefore slower than a unit
// test; the timeouts below are generous on purpose.

import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(__dirname, '..');
const cliDir = join(repoRoot, 'v3', '@hive-flow', 'cli');

// Isolated npm cache so we never touch (or get blocked by) the shared ~/.npm.
const ISOLATED_CACHE = mkdtempSync(join(tmpdir(), 'hf-pack-cache-'));

const PACK_TIMEOUT = 180_000;

function packDryRun(cwd) {
  const res = spawnSync(
    'npm',
    ['pack', '--dry-run', '--json'],
    {
      cwd,
      encoding: 'utf-8',
      timeout: PACK_TIMEOUT,
      env: { ...process.env, NPM_CONFIG_CACHE: ISOLATED_CACHE },
      maxBuffer: 64 * 1024 * 1024,
    },
  );
  assert.equal(res.status, 0, `npm pack --dry-run failed in ${cwd}:\n${res.stderr}`);
  // npm may emit notices on stdout before the JSON; isolate the JSON array.
  const start = res.stdout.indexOf('[');
  assert.ok(start >= 0, `no JSON array in npm pack output for ${cwd}`);
  const parsed = JSON.parse(res.stdout.slice(start));
  const entry = Array.isArray(parsed) ? parsed[0] : parsed;
  return {
    entry,
    files: (entry.files || []).map((f) => f.path),
  };
}

function packReal(cwd, destDir) {
  const res = spawnSync(
    'npm',
    ['pack', '--pack-destination', destDir],
    {
      cwd,
      encoding: 'utf-8',
      timeout: PACK_TIMEOUT,
      env: { ...process.env, NPM_CONFIG_CACHE: ISOLATED_CACHE },
      maxBuffer: 64 * 1024 * 1024,
    },
  );
  assert.equal(res.status, 0, `npm pack failed in ${cwd}:\n${res.stderr}`);
  const tgz = readdirSync(destDir).find((f) => f.endsWith('.tgz'));
  assert.ok(tgz, `no .tgz produced for ${cwd}`);
  return join(destDir, tgz);
}

function extract(tgzPath, destDir) {
  const res = spawnSync('tar', ['xzf', tgzPath, '-C', destDir], {
    encoding: 'utf-8',
    timeout: PACK_TIMEOUT,
  });
  assert.equal(res.status, 0, `tar extract failed for ${tgzPath}:\n${res.stderr}`);
  return join(destDir, 'package');
}

// Recursively list every file under a directory.
function walk(dir, acc = []) {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    const st = statSync(full);
    if (st.isDirectory()) walk(full, acc);
    else acc.push(full);
  }
  return acc;
}

// Junk path patterns that must NEVER appear in a packaged tarball.
const JUNK_PATTERNS = [
  { name: '.context-tracker', re: /\.context-tracker\.json$/ },
  { name: 'checkpoints/', re: /(^|\/)checkpoints\// },
  { name: 'sqlite/db files', re: /\.(db|db-shm|db-wal|db-journal|sqlite|sqlite3)$/ },
  { name: 'worktrees/', re: /(^|\/)worktrees\// },
  { name: '.hive-flow/ state', re: /(^|\/)\.hive-flow\// },
  { name: 'sessions/', re: /(^|\/)sessions?\// },
  { name: 'enforcement/', re: /(^|\/)enforcement\// },
  { name: 'DELETE_', re: /DELETE_/ },
  { name: 'TRASH/', re: /(^|\/)TRASH\// },
  { name: 'hmac key', re: /\.hmac-key$/ },
];

// Matches a hardcoded developer absolute path to a hive-flow checkout, e.g.
// /Users/<name>/.../hive-flow/...  — but NOT the benign Windows doc example
// `C:/Users/name/...` nor the neural.js redaction placeholder `/Users/[REDACTED]`.
const DEV_PATH_RE = /(?<![A-Za-z]:)\/Users\/[^/\s"']+\/[^"'\s]*hive-flow/;

function assertNoJunk(files, label) {
  for (const { name, re } of JUNK_PATTERNS) {
    const hits = files.filter((p) => re.test(p));
    assert.equal(
      hits.length,
      0,
      `[${label}] must not ship ${name}; found:\n  ${hits.slice(0, 10).join('\n  ')}`,
    );
  }
}

describe('packaging proof: @hive-flow/cli tarball', () => {
  let files = [];
  let pkgDir = '';

  before(() => {
    files = packDryRun(cliDir).files;
    const work = mkdtempSync(join(tmpdir(), 'hf-cli-pack-'));
    mkdirSync(join(work, 'ext'), { recursive: true });
    const tgz = packReal(cliDir, work);
    pkgDir = extract(tgz, join(work, 'ext'));
  });

  it('ships no dev/state junk', () => {
    assertNoJunk(files, 'cli');
  });

  it('ships runtime init templates (.claude + agents)', () => {
    const has = (re) => files.some((p) => re.test(p));
    assert.ok(has(/^\.claude\/commands\//), 'missing .claude/commands');
    assert.ok(has(/^\.claude\/helpers\//), 'missing .claude/helpers');
    assert.ok(has(/^\.claude\/skills\//), 'missing .claude/skills');
    // agents/ is REQUIRED by `hive-flow init` (findSourceDir('agents')).
    assert.ok(has(/^agents\/.*\.yaml$/), 'missing agents/*.yaml init templates');
  });

  it('ships native credential-helper sources', () => {
    const has = (re) => files.some((p) => re.test(p));
    assert.ok(
      has(/^dist\/credential-store\/helpers\//),
      'missing dist/credential-store/helpers sources',
    );
  });

  it('ships bin entry scripts with the executable bit', () => {
    const binDir = join(pkgDir, 'bin');
    for (const bin of ['cli.js', 'mcp-server.js', 'statusline.js']) {
      const full = join(binDir, bin);
      const mode = statSync(full).mode;
      assert.ok(mode & 0o111, `${bin} is not executable (mode ${mode.toString(8)})`);
    }
  });

  it('contains no hardcoded developer absolute path in any packaged file', () => {
    const offenders = [];
    for (const f of walk(pkgDir)) {
      let content;
      try {
        content = readFileSync(f, 'utf-8');
      } catch {
        continue; // binary / unreadable -> skip
      }
      if (DEV_PATH_RE.test(content)) offenders.push(f.slice(pkgDir.length + 1));
    }
    assert.deepEqual(offenders, [], `dev path leaked into:\n  ${offenders.join('\n  ')}`);
  });
});

describe('packaging proof: hive-flow (umbrella) tarball', () => {
  let files = [];
  let pkgDir = '';

  before(() => {
    files = packDryRun(repoRoot).files;
    const work = mkdtempSync(join(tmpdir(), 'hf-root-pack-'));
    mkdirSync(join(work, 'ext'), { recursive: true });
    const tgz = packReal(repoRoot, work);
    pkgDir = extract(tgz, join(work, 'ext'));
  });

  it('ships no dev/state junk', () => {
    assertNoJunk(files, 'root');
  });

  it('ships the nested canonical CLI payload (templates + agents + helpers)', () => {
    const has = (re) => files.some((p) => re.test(p));
    assert.ok(has(/^v3\/@hive-flow\/cli\/\.claude\/commands\//), 'missing nested cli .claude/commands');
    assert.ok(has(/^v3\/@hive-flow\/cli\/\.claude\/helpers\//), 'missing nested cli .claude/helpers');
    assert.ok(has(/^v3\/@hive-flow\/cli\/\.claude\/skills\//), 'missing nested cli .claude/skills');
    assert.ok(has(/^v3\/@hive-flow\/cli\/agents\/.*\.yaml$/), 'missing nested cli agents/*.yaml');
    assert.ok(
      has(/^v3\/@hive-flow\/cli\/dist\/credential-store\/helpers\//),
      'missing nested cli credential-helper sources',
    );
  });

  it('does NOT ship the developer top-level .claude/ tree', () => {
    // The umbrella must not carry the dev-local top-level .claude (worktrees,
    // memory.db, settings.local, etc.). Only the nested canonical CLI payload.
    const topLevelClaude = files.filter((p) => /^\.claude\//.test(p));
    assert.equal(
      topLevelClaude.length,
      0,
      `umbrella must not ship top-level .claude/; found:\n  ${topLevelClaude.slice(0, 10).join('\n  ')}`,
    );
  });

  it('ships bin entry scripts with the executable bit', () => {
    const mode = statSync(join(pkgDir, 'bin', 'cli.js')).mode;
    assert.ok(mode & 0o111, `root bin/cli.js is not executable (mode ${mode.toString(8)})`);
    const nestedMode = statSync(
      join(pkgDir, 'v3', '@hive-flow', 'cli', 'bin', 'cli.js'),
    ).mode;
    assert.ok(nestedMode & 0o111, 'nested cli/bin/cli.js is not executable');
  });

  it('contains no hardcoded developer absolute path in any packaged file', () => {
    const offenders = [];
    for (const f of walk(pkgDir)) {
      let content;
      try {
        content = readFileSync(f, 'utf-8');
      } catch {
        continue;
      }
      if (DEV_PATH_RE.test(content)) offenders.push(f.slice(pkgDir.length + 1));
    }
    assert.deepEqual(offenders, [], `dev path leaked into:\n  ${offenders.join('\n  ')}`);
  });
});
