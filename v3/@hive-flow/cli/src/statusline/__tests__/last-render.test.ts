// v3/@hive-flow/cli/src/statusline/__tests__/last-render.test.ts
//
// Wave 8 — Codex Phase 7 Finding 1 + Finding 2 regression suite.
//
// The runbook §7.1 design defines THREE concepts that the API must honour:
//
//   1. Global mirror at `${HIVE_FLOW_HOME}/.hive-flow/statusline/projects/${projectKey}/`
//      (JSON + plain text)
//   2. Current pointer at `${HIVE_FLOW_HOME}/.hive-flow/statusline/current.json`
//   3. Project-local mirror at `${projectRoot}/.hive-flow/state/last-render.txt`
//      (text-only, written only when `.hive-flow/` already exists)
//
// The Finding 1 fix is that the path-walk in `storage.ensureSafeUserCacheDir`
// + `assertSafeUserCachePath` rejects symlinked PARENTS too (the previous
// implementation only lstat'd the leaf). Tests below cover symlinked
// `${home}/.hive-flow`, symlinked `${home}/.hive-flow/statusline`, symlinked
// `${home}/.hive-flow/statusline/projects`, symlinked
// `${home}/.hive-flow/statusline/projects/${projectKey}`, and symlinked leaf.
// Each rejection must leave the outside target untouched.

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import {
  lastRenderPaths,
  readLastRender,
  readLastRenderViaCurrentPointer,
  writeLastRender,
  StatuslineLastRenderSymlinkError,
  type LastRenderRecord,
} from '../last-render.js';
import type { StatuslineSnapshotV1 } from '../types.js';

// 16-char lowercase hex projectKey (matches Wave 3 `resolveProjectScope`)
const KEY_A = '0123456789abcdef';
const KEY_B = 'fedcba9876543210';

function makeEnv(home: string): NodeJS.ProcessEnv {
  // `HIVE_FLOW_HOME` is the test/CI override honoured by the user-cache
  // base resolver in last-render.ts. Keeps `process.env` untouched between
  // tests so no other suite is affected by the redirected home path.
  return { HIVE_FLOW_HOME: home };
}

describe('statusline last-render', () => {
  let home: string;
  let projectRoot: string;
  let env: NodeJS.ProcessEnv;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'hf-last-render-home-'));
    projectRoot = mkdtempSync(join(tmpdir(), 'hf-last-render-proj-'));
    env = makeEnv(home);
  });
  afterEach(() => {
    rmSync(home, { recursive: true, force: true });
    rmSync(projectRoot, { recursive: true, force: true });
  });

  function paths(key = KEY_A) {
    return lastRenderPaths(key, env);
  }

  // -------------------------------------------------------------------------
  // 1. Round-trip (global mirror) — basic write+read by projectKey
  // -------------------------------------------------------------------------
  it('round-trips a write -> read via projectKey through the global mirror', async () => {
    const rendered = '\x1b[1;38;5;253mproject\x1b[0m | \x1b[1;34mmain\x1b[0m';
    await writeLastRender({
      rendered,
      mode: 'snapshot',
      env,
      nowMs: 1_700_000_000_000,
      projectRoot,
      projectKey: KEY_A,
    });
    const got = await readLastRender({ projectKey: KEY_A, env });
    expect(got).toBeDefined();
    expect(got!.version).toBe(1);
    expect(got!.rendered).toBe(rendered);
    expect(got!.mode).toBe('snapshot');
    expect(got!.renderedAt).toBe(new Date(1_700_000_000_000).toISOString());
    expect(got!.snapshot).toBeUndefined();
    expect(got!.projectKey).toBe(KEY_A);
    expect(got!.projectRoot).toBe(projectRoot);
  });

  // -------------------------------------------------------------------------
  // 2. Global mirror is ALWAYS written
  // -------------------------------------------------------------------------
  it('always writes the global-mirror JSON and text files', async () => {
    const p = paths();
    await writeLastRender({
      rendered: 'g',
      mode: 'snapshot',
      env,
      projectRoot,
      projectKey: KEY_A,
    });
    expect(existsSync(p.json)).toBe(true);
    expect(existsSync(p.text)).toBe(true);
    expect(statSync(p.json).mode & 0o777).toBe(0o600);
    expect(statSync(p.text).mode & 0o777).toBe(0o600);
    const text = readFileSync(p.text, 'utf8');
    expect(text).toBe('g\n');
  });

  // -------------------------------------------------------------------------
  // 3. Current pointer is updated on every write
  // -------------------------------------------------------------------------
  it('writes the current pointer on every write', async () => {
    const p = paths();
    await writeLastRender({
      rendered: 'first',
      mode: 'snapshot',
      env,
      projectRoot,
      projectKey: KEY_A,
      nowMs: 1_700_000_000_000,
    });
    let pointer = JSON.parse(readFileSync(p.currentPointer, 'utf8'));
    expect(pointer).toMatchObject({
      version: 1,
      projectKey: KEY_A,
      projectRoot,
      renderedAt: new Date(1_700_000_000_000).toISOString(),
      lastRender: p.json,
    });
    expect(statSync(p.currentPointer).mode & 0o777).toBe(0o600);

    // A second write to a DIFFERENT project must replace the pointer.
    const other = mkdtempSync(join(tmpdir(), 'hf-last-render-other-'));
    try {
      await writeLastRender({
        rendered: 'second',
        mode: 'snapshot',
        env,
        projectRoot: other,
        projectKey: KEY_B,
        nowMs: 1_700_000_001_000,
      });
      pointer = JSON.parse(readFileSync(p.currentPointer, 'utf8'));
      expect(pointer.projectKey).toBe(KEY_B);
      expect(pointer.projectRoot).toBe(other);
      expect(pointer.lastRender).toBe(paths(KEY_B).json);
    } finally {
      rmSync(other, { recursive: true, force: true });
    }
  });

  // -------------------------------------------------------------------------
  // 4. Project-local mirror — written only when `.hive-flow/` exists
  // -------------------------------------------------------------------------
  it('does NOT write project-local mirror when .hive-flow/ is absent', async () => {
    expect(existsSync(join(projectRoot, '.hive-flow'))).toBe(false);
    await writeLastRender({
      rendered: 'no-local',
      mode: 'snapshot',
      env,
      projectRoot,
      projectKey: KEY_A,
    });
    expect(existsSync(join(projectRoot, '.hive-flow', 'state', 'last-render.txt'))).toBe(false);
    // Global mirror still written.
    expect(existsSync(paths().json)).toBe(true);
  });

  it('writes project-local mirror when .hive-flow/ exists', async () => {
    mkdirSync(join(projectRoot, '.hive-flow'), { recursive: true });
    await writeLastRender({
      rendered: 'has-local',
      mode: 'snapshot',
      env,
      projectRoot,
      projectKey: KEY_A,
    });
    const localPath = join(projectRoot, '.hive-flow', 'state', 'last-render.txt');
    expect(existsSync(localPath)).toBe(true);
    expect(readFileSync(localPath, 'utf8')).toBe('has-local\n');
    expect(statSync(localPath).mode & 0o777).toBe(0o600);
  });

  // -------------------------------------------------------------------------
  // 5. readLastRender({ projectRoot }) prefers project-local mirror
  // -------------------------------------------------------------------------
  it('readLastRender({ projectRoot }) prefers project-local mirror when present', async () => {
    mkdirSync(join(projectRoot, '.hive-flow'), { recursive: true });
    await writeLastRender({
      rendered: 'local-preferred',
      mode: 'snapshot',
      env,
      projectRoot,
      projectKey: KEY_A,
    });
    const got = await readLastRender({ projectRoot, projectKey: KEY_A, env });
    expect(got?.rendered).toBe('local-preferred');
    // Synthesised record carries the projectRoot.
    expect(got?.projectRoot).toBe(projectRoot);
  });

  it('readLastRender({ projectRoot, projectKey }) falls back to global when local absent', async () => {
    await writeLastRender({
      rendered: 'global-only',
      mode: 'snapshot',
      env,
      projectRoot,
      projectKey: KEY_A,
    });
    // `.hive-flow/` was never created -> no local mirror -> fall back to global.
    const got = await readLastRender({ projectRoot, projectKey: KEY_A, env });
    expect(got?.rendered).toBe('global-only');
    expect(got?.projectKey).toBe(KEY_A);
  });

  it('readLastRender with neither projectRoot nor projectKey returns undefined', async () => {
    await writeLastRender({
      rendered: 'any',
      mode: 'snapshot',
      env,
      projectRoot,
      projectKey: KEY_A,
    });
    expect(await readLastRender({ env })).toBeUndefined();
  });

  // -------------------------------------------------------------------------
  // 6. readLastRenderViaCurrentPointer — non-Claude CLI fallback
  // -------------------------------------------------------------------------
  it('readLastRenderViaCurrentPointer reads the latest cross-CLI', async () => {
    await writeLastRender({
      rendered: 'pointer-target',
      mode: 'inline-collector',
      env,
      projectRoot,
      projectKey: KEY_A,
      nowMs: 1_700_000_002_000,
    });
    const got = await readLastRenderViaCurrentPointer({ env });
    expect(got?.rendered).toBe('pointer-target');
    expect(got?.projectKey).toBe(KEY_A);
    expect(got?.mode).toBe('inline-collector');
  });

  it('readLastRenderViaCurrentPointer returns undefined with no pointer', async () => {
    expect(await readLastRenderViaCurrentPointer({ env })).toBeUndefined();
  });

  it('readLastRenderViaCurrentPointer rejects a corrupted pointer', async () => {
    // Stage a bogus pointer file directly so we can corrupt the schema.
    const p = paths();
    mkdirSync(p.base, { recursive: true });
    writeFileSync(p.currentPointer, '{"version":1,"projectKey":"NOT-HEX","projectRoot":"/a","renderedAt":"now","lastRender":"/etc/passwd"}');
    expect(await readLastRenderViaCurrentPointer({ env })).toBeUndefined();
  });

  // -------------------------------------------------------------------------
  // 7. projectKey namespacing — two keys never collide
  // -------------------------------------------------------------------------
  it('namespaces global mirror by projectKey — two keys never collide', async () => {
    const otherRoot = mkdtempSync(join(tmpdir(), 'hf-last-render-other-'));
    try {
      await writeLastRender({
        rendered: 'A',
        mode: 'snapshot',
        env,
        projectRoot,
        projectKey: KEY_A,
      });
      await writeLastRender({
        rendered: 'B',
        mode: 'snapshot',
        env,
        projectRoot: otherRoot,
        projectKey: KEY_B,
      });
      const a = await readLastRender({ projectKey: KEY_A, env });
      const b = await readLastRender({ projectKey: KEY_B, env });
      expect(a?.rendered).toBe('A');
      expect(b?.rendered).toBe('B');
      // Distinct directories under projects/
      expect(paths(KEY_A).projectDir).not.toBe(paths(KEY_B).projectDir);
    } finally {
      rmSync(otherRoot, { recursive: true, force: true });
    }
  });

  // -------------------------------------------------------------------------
  // 8. Missing / corrupt / oversize / non-regular
  // -------------------------------------------------------------------------
  it('returns undefined when the global mirror file does not exist', async () => {
    expect(await readLastRender({ projectKey: KEY_A, env })).toBeUndefined();
  });

  it('returns undefined when the global mirror contains corrupt JSON', async () => {
    const p = paths();
    mkdirSync(p.projectDir, { recursive: true });
    writeFileSync(p.json, '{ not valid json', { mode: 0o600 });
    expect(await readLastRender({ projectKey: KEY_A, env })).toBeUndefined();
  });

  it('returns undefined when the global mirror exceeds the byte cap', async () => {
    const p = paths();
    mkdirSync(p.projectDir, { recursive: true });
    const cap = 16 * 1024;
    const oversize = `{"version":1,"renderedAt":"${new Date().toISOString()}","mode":"snapshot","rendered":"${'x'.repeat(cap + 1024)}"}`;
    writeFileSync(p.json, oversize, { mode: 0o600 });
    expect(await readLastRender({ projectKey: KEY_A, env, maxBytes: cap })).toBeUndefined();
  });

  // -------------------------------------------------------------------------
  // 9. Atomicity + file mode tightening
  // -------------------------------------------------------------------------
  it('write is atomic: subsequent writes commit cleanly with no tmp leftovers', async () => {
    await writeLastRender({
      rendered: 'small',
      mode: 'snapshot',
      env,
      projectRoot,
      projectKey: KEY_A,
    });
    const big = 'x'.repeat(8 * 1024);
    await writeLastRender({
      rendered: big,
      mode: 'snapshot',
      env,
      projectRoot,
      projectKey: KEY_A,
    });
    const got = await readLastRender({ projectKey: KEY_A, env });
    expect(got?.rendered).toBe(big);
    const projectDir = paths().projectDir;
    const tmpLeftovers = readdirSync(projectDir).filter((n) => n.includes('.tmp-'));
    expect(tmpLeftovers).toEqual([]);
  });

  it('written file has mode 0o600', async () => {
    await writeLastRender({
      rendered: 'mode-check',
      mode: 'snapshot',
      env,
      projectRoot,
      projectKey: KEY_A,
    });
    expect(statSync(paths().json).mode & 0o777).toBe(0o600);
  });

  it('tightens mode to 0o600 when an existing global JSON had loose perms', async () => {
    const p = paths();
    mkdirSync(p.projectDir, { recursive: true });
    writeFileSync(p.json, '{}', { mode: 0o600 });
    chmodSync(p.json, 0o644);
    await writeLastRender({
      rendered: 'after-loose',
      mode: 'snapshot',
      env,
      projectRoot,
      projectKey: KEY_A,
    });
    expect(statSync(p.json).mode & 0o777).toBe(0o600);
  });

  // -------------------------------------------------------------------------
  // 10. Symlink rejection — the Finding 1 fix exercised at every parent
  //     segment AND the leaf, for both the global and project-local mirror
  // -------------------------------------------------------------------------

  it('refuses to write when ${home}/.hive-flow is a symlink (decoy untouched)', async () => {
    const decoy = mkdtempSync(join(tmpdir(), 'hf-last-render-decoy-'));
    try {
      // Stage a decoy that LOOKS like the user-home statusline tree.
      const decoyHF = join(decoy, '.hive-flow');
      mkdirSync(join(decoyHF, 'statusline', 'projects', KEY_A), { recursive: true });
      const decoyJson = join(decoyHF, 'statusline', 'projects', KEY_A, 'last-render.json');
      writeFileSync(decoyJson, '{"version":1,"decoy":true}');
      // Symlink the real `${home}/.hive-flow` to the decoy.
      symlinkSync(decoyHF, join(home, '.hive-flow'));
      let caught: unknown;
      try {
        await writeLastRender({
          rendered: 'should-not-land',
          mode: 'snapshot',
          env,
          projectRoot,
          projectKey: KEY_A,
        });
      } catch (error: unknown) {
        caught = error;
      }
      expect(caught).toBeInstanceOf(StatuslineLastRenderSymlinkError);
      // Decoy untouched.
      expect(readFileSync(decoyJson, 'utf8')).toBe('{"version":1,"decoy":true}');
    } finally {
      rmSync(decoy, { recursive: true, force: true });
    }
  });

  it('refuses to write when ${home}/.hive-flow/statusline is a symlink', async () => {
    const decoy = mkdtempSync(join(tmpdir(), 'hf-last-render-decoy-'));
    try {
      const decoyStatusline = join(decoy, 'statusline');
      mkdirSync(join(decoyStatusline, 'projects', KEY_A), { recursive: true });
      const decoyJson = join(decoyStatusline, 'projects', KEY_A, 'last-render.json');
      writeFileSync(decoyJson, '{"version":1,"decoy":true}');
      mkdirSync(join(home, '.hive-flow'), { recursive: true });
      symlinkSync(decoyStatusline, join(home, '.hive-flow', 'statusline'));
      let caught: unknown;
      try {
        await writeLastRender({
          rendered: 'should-not-land',
          mode: 'snapshot',
          env,
          projectRoot,
          projectKey: KEY_A,
        });
      } catch (error: unknown) {
        caught = error;
      }
      expect(caught).toBeInstanceOf(StatuslineLastRenderSymlinkError);
      expect(readFileSync(decoyJson, 'utf8')).toBe('{"version":1,"decoy":true}');
    } finally {
      rmSync(decoy, { recursive: true, force: true });
    }
  });

  it('refuses to write when ${userCacheBase}/projects/${projectKey} is a symlink', async () => {
    const decoy = mkdtempSync(join(tmpdir(), 'hf-last-render-decoy-'));
    try {
      mkdirSync(decoy, { recursive: true });
      const decoyJson = join(decoy, 'last-render.json');
      writeFileSync(decoyJson, '{"version":1,"decoy":true}');
      const projectsDir = join(home, '.hive-flow', 'statusline', 'projects');
      mkdirSync(projectsDir, { recursive: true });
      symlinkSync(decoy, join(projectsDir, KEY_A));
      let caught: unknown;
      try {
        await writeLastRender({
          rendered: 'should-not-land',
          mode: 'snapshot',
          env,
          projectRoot,
          projectKey: KEY_A,
        });
      } catch (error: unknown) {
        caught = error;
      }
      expect(caught).toBeInstanceOf(StatuslineLastRenderSymlinkError);
      expect(readFileSync(decoyJson, 'utf8')).toBe('{"version":1,"decoy":true}');
    } finally {
      rmSync(decoy, { recursive: true, force: true });
    }
  });

  it('refuses to write when the global JSON leaf is itself a symlink', async () => {
    const decoy = mkdtempSync(join(tmpdir(), 'hf-last-render-decoy-'));
    try {
      const decoyJson = join(decoy, 'decoy.json');
      writeFileSync(decoyJson, '{"version":1,"decoy":true}');
      const projectDir = paths().projectDir;
      mkdirSync(projectDir, { recursive: true });
      symlinkSync(decoyJson, paths().json);
      let caught: unknown;
      try {
        await writeLastRender({
          rendered: 'should-not-land',
          mode: 'snapshot',
          env,
          projectRoot,
          projectKey: KEY_A,
        });
      } catch (error: unknown) {
        caught = error;
      }
      expect(caught).toBeInstanceOf(StatuslineLastRenderSymlinkError);
      expect(readFileSync(decoyJson, 'utf8')).toBe('{"version":1,"decoy":true}');
    } finally {
      rmSync(decoy, { recursive: true, force: true });
    }
  });

  // Read-side: all three symlink attacks must collapse to `undefined`.
  it('readLastRender returns undefined when ${home}/.hive-flow is a symlink', async () => {
    const decoy = mkdtempSync(join(tmpdir(), 'hf-last-render-decoy-'));
    try {
      const decoyHF = join(decoy, '.hive-flow');
      mkdirSync(join(decoyHF, 'statusline', 'projects', KEY_A), { recursive: true });
      writeFileSync(
        join(decoyHF, 'statusline', 'projects', KEY_A, 'last-render.json'),
        JSON.stringify({
          version: 1,
          renderedAt: new Date().toISOString(),
          mode: 'snapshot',
          rendered: 'attacker',
        }),
      );
      symlinkSync(decoyHF, join(home, '.hive-flow'));
      expect(await readLastRender({ projectKey: KEY_A, env })).toBeUndefined();
    } finally {
      rmSync(decoy, { recursive: true, force: true });
    }
  });

  it('readLastRender returns undefined when statusline parent is a symlink', async () => {
    const decoy = mkdtempSync(join(tmpdir(), 'hf-last-render-decoy-'));
    try {
      mkdirSync(join(decoy, 'projects', KEY_A), { recursive: true });
      writeFileSync(
        join(decoy, 'projects', KEY_A, 'last-render.json'),
        JSON.stringify({
          version: 1,
          renderedAt: new Date().toISOString(),
          mode: 'snapshot',
          rendered: 'attacker',
        }),
      );
      mkdirSync(join(home, '.hive-flow'), { recursive: true });
      symlinkSync(decoy, join(home, '.hive-flow', 'statusline'));
      expect(await readLastRender({ projectKey: KEY_A, env })).toBeUndefined();
    } finally {
      rmSync(decoy, { recursive: true, force: true });
    }
  });

  it('readLastRender returns undefined when leaf is a symlink', async () => {
    const decoy = mkdtempSync(join(tmpdir(), 'hf-last-render-decoy-'));
    try {
      const decoyJson = join(decoy, 'decoy.json');
      writeFileSync(
        decoyJson,
        JSON.stringify({
          version: 1,
          renderedAt: new Date().toISOString(),
          mode: 'snapshot',
          rendered: 'attacker',
        }),
      );
      const p = paths();
      mkdirSync(p.projectDir, { recursive: true });
      symlinkSync(decoyJson, p.json);
      expect(await readLastRender({ projectKey: KEY_A, env })).toBeUndefined();
    } finally {
      rmSync(decoy, { recursive: true, force: true });
    }
  });

  // -------------------------------------------------------------------------
  // 11. Project-local mirror — symlinked `.hive-flow/` rejected; missing
  //     `.hive-flow/` means no local write (but global still happens)
  // -------------------------------------------------------------------------

  it('treats a symlinked .hive-flow/ as "no project opt-in" and skips local mirror', async () => {
    const outside = mkdtempSync(join(tmpdir(), 'hf-last-render-outside-'));
    try {
      symlinkSync(outside, join(projectRoot, '.hive-flow'));
      await writeLastRender({
        rendered: 'no-local-when-symlinked-hf',
        mode: 'snapshot',
        env,
        projectRoot,
        projectKey: KEY_A,
      });
      // Global mirror written.
      expect(existsSync(paths().json)).toBe(true);
      // Outside dir untouched — nothing written through the symlink.
      expect(readdirSync(outside)).toEqual([]);
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });

  // -------------------------------------------------------------------------
  // 12. Stamping: version=1, renderedAt is ISO, mode in valid set
  // -------------------------------------------------------------------------
  it('stamps version=1, an ISO renderedAt, and a valid mode', async () => {
    for (const mode of ['snapshot', 'inline-collector', 'header-only'] as const) {
      await writeLastRender({
        rendered: `r-${mode}`,
        mode,
        env,
        nowMs: 1_700_000_001_000,
        projectRoot,
        projectKey: KEY_A,
      });
      const got = await readLastRender({ projectKey: KEY_A, env });
      expect(got!.version).toBe(1);
      expect(got!.mode).toBe(mode);
      const parsed = Date.parse(got!.renderedAt);
      expect(Number.isFinite(parsed)).toBe(true);
      expect(new Date(parsed).toISOString()).toBe(got!.renderedAt);
    }
  });

  // -------------------------------------------------------------------------
  // 13. Schema-version guard
  // -------------------------------------------------------------------------
  it('returns undefined when version !== 1 (forward-compat guard)', async () => {
    const p = paths();
    mkdirSync(p.projectDir, { recursive: true });
    const future: Record<string, unknown> = {
      version: 99,
      renderedAt: new Date().toISOString(),
      mode: 'snapshot',
      rendered: 'future',
    };
    writeFileSync(p.json, JSON.stringify(future), { mode: 0o600 });
    expect(await readLastRender({ projectKey: KEY_A, env })).toBeUndefined();
  });

  // -------------------------------------------------------------------------
  // 14. Snapshot round-trip
  // -------------------------------------------------------------------------
  it('round-trips an attached snapshot when provided', async () => {
    const snapshot: StatuslineSnapshotV1 = {
      version: 1,
      projectRoot,
      repoIdentity: 'repo-x',
      projectKey: KEY_A,
      generatedAt: new Date().toISOString(),
      sources: {},
    };
    await writeLastRender({
      rendered: 'with-snap',
      mode: 'snapshot',
      env,
      projectRoot,
      projectKey: KEY_A,
      snapshot,
    });
    const got = await readLastRender({ projectKey: KEY_A, env });
    expect(got?.snapshot).toBeDefined();
    expect(got!.snapshot!.projectRoot).toBe(projectRoot);
    expect(got!.snapshot!.projectKey).toBe(KEY_A);
  });

  // -------------------------------------------------------------------------
  // 15. nowMs override
  // -------------------------------------------------------------------------
  it('honours an explicit nowMs', async () => {
    const fixed = 1_650_000_000_000;
    await writeLastRender({
      rendered: 'fixed',
      mode: 'snapshot',
      env,
      projectRoot,
      projectKey: KEY_A,
      nowMs: fixed,
    });
    const got = await readLastRender({ projectKey: KEY_A, env });
    expect(got!.renderedAt).toBe(new Date(fixed).toISOString());
  });

  // -------------------------------------------------------------------------
  // 16. Invalid mode at write
  // -------------------------------------------------------------------------
  it('throws TypeError when writeLastRender is given an invalid mode', async () => {
    await expect(
      writeLastRender({
        rendered: 'bad',
        mode: 'banana' as unknown as 'snapshot',
        env,
        projectRoot,
        projectKey: KEY_A,
      }),
    ).rejects.toBeInstanceOf(TypeError);
    expect(existsSync(paths().json)).toBe(false);
  });

  it('throws TypeError when projectRoot is missing or relative', async () => {
    await expect(
      writeLastRender({
        rendered: 'x',
        mode: 'snapshot',
        env,
        projectRoot: 'relative/path',
        projectKey: KEY_A,
      } as unknown as Parameters<typeof writeLastRender>[0]),
    ).rejects.toBeInstanceOf(TypeError);
  });

  it('throws TypeError when projectKey is not 16-char hex', async () => {
    await expect(
      writeLastRender({
        rendered: 'x',
        mode: 'snapshot',
        env,
        projectRoot,
        projectKey: 'not-hex' as unknown as string,
      }),
    ).rejects.toBeInstanceOf(TypeError);
  });

  // -------------------------------------------------------------------------
  // 17. JSON array at top level
  // -------------------------------------------------------------------------
  it('returns undefined when the JSON payload is an array', async () => {
    const p = paths();
    mkdirSync(p.projectDir, { recursive: true });
    writeFileSync(p.json, JSON.stringify([{ version: 1 }]), { mode: 0o600 });
    expect(await readLastRender({ projectKey: KEY_A, env })).toBeUndefined();
  });

  it('returns undefined when renderedAt is not an ISO string', async () => {
    const p = paths();
    mkdirSync(p.projectDir, { recursive: true });
    const bad: LastRenderRecord = {
      version: 1,
      renderedAt: 'not-a-date',
      mode: 'snapshot',
      rendered: 'r',
    };
    writeFileSync(p.json, JSON.stringify(bad), { mode: 0o600 });
    expect(await readLastRender({ projectKey: KEY_A, env })).toBeUndefined();
  });

  it('returns undefined when mode is not in the valid set', async () => {
    const p = paths();
    mkdirSync(p.projectDir, { recursive: true });
    const bad = {
      version: 1,
      renderedAt: new Date().toISOString(),
      mode: 'banana',
      rendered: 'r',
    };
    writeFileSync(p.json, JSON.stringify(bad), { mode: 0o600 });
    expect(await readLastRender({ projectKey: KEY_A, env })).toBeUndefined();
  });

  // -------------------------------------------------------------------------
  // 18. Codex Phase 7 HIGH regression — project-local text mirror is mode-gated
  //
  // The local file is text-only (no JSON envelope), so the read path
  // synthesises `mode: 'snapshot'` for whatever it finds there. If we let
  // degraded (`inline-collector` / `header-only`) renders write to the same
  // file, they would be mis-reported as snapshots on read, AND would
  // clobber the previous full snapshot.
  //
  // Fix: only write the project-local text mirror when `opts.mode ===
  // 'snapshot'`. The global mirror (JSON + text) and current pointer are
  // still written for ALL modes — only the project-local text leaf is
  // gated.
  // -------------------------------------------------------------------------
  describe('Codex Phase 7 — project-local mirror is only written for snapshot mode', () => {
    const localLeaf = (root: string) => join(root, '.hive-flow', 'state', 'last-render.txt');

    it('does NOT write the project-local mirror in inline-collector mode', async () => {
      mkdirSync(join(projectRoot, '.hive-flow'), { recursive: true });
      await writeLastRender({
        rendered: 'inline-degraded',
        mode: 'inline-collector',
        env,
        projectRoot,
        projectKey: KEY_A,
      });
      // Local mirror skipped …
      expect(existsSync(localLeaf(projectRoot))).toBe(false);
      // … global mirror + pointer still written for ALL modes.
      expect(existsSync(paths().json)).toBe(true);
      expect(existsSync(paths().text)).toBe(true);
      expect(existsSync(paths().currentPointer)).toBe(true);
    });

    it('does NOT write the project-local mirror in header-only mode', async () => {
      mkdirSync(join(projectRoot, '.hive-flow'), { recursive: true });
      await writeLastRender({
        rendered: 'header-only-degraded',
        mode: 'header-only',
        env,
        projectRoot,
        projectKey: KEY_A,
      });
      expect(existsSync(localLeaf(projectRoot))).toBe(false);
      expect(existsSync(paths().json)).toBe(true);
      expect(existsSync(paths().text)).toBe(true);
      expect(existsSync(paths().currentPointer)).toBe(true);
    });

    it('DOES write the project-local mirror in snapshot mode', async () => {
      mkdirSync(join(projectRoot, '.hive-flow'), { recursive: true });
      await writeLastRender({
        rendered: 'full-snapshot',
        mode: 'snapshot',
        env,
        projectRoot,
        projectKey: KEY_A,
      });
      expect(existsSync(localLeaf(projectRoot))).toBe(true);
      expect(readFileSync(localLeaf(projectRoot), 'utf8')).toBe('full-snapshot\n');
    });

    it('a degraded write does NOT overwrite the previous snapshot in the local mirror', async () => {
      // The load-bearing assertion: Codex's exact scenario was that an
      // inline-collector render clobbered the last snapshot and was then
      // read back as if it were a snapshot. After the fix, the snapshot
      // text must remain intact through a degraded follow-up write.
      mkdirSync(join(projectRoot, '.hive-flow'), { recursive: true });
      await writeLastRender({
        rendered: 'first-full-snapshot',
        mode: 'snapshot',
        env,
        projectRoot,
        projectKey: KEY_A,
      });
      expect(readFileSync(localLeaf(projectRoot), 'utf8')).toBe('first-full-snapshot\n');

      // Degraded write — must NOT touch the local mirror.
      await writeLastRender({
        rendered: 'degraded-inline',
        mode: 'inline-collector',
        env,
        projectRoot,
        projectKey: KEY_A,
      });
      expect(readFileSync(localLeaf(projectRoot), 'utf8')).toBe('first-full-snapshot\n');

      // And the synthesised read (which always reports mode: 'snapshot'
      // for the local file) returns the original snapshot text, NOT the
      // degraded text. This is the bug Codex caught: before the fix, the
      // local file held degraded content but the read advertised it as a
      // snapshot.
      const got = await readLastRender({ projectRoot, projectKey: KEY_A, env });
      expect(got?.rendered).toBe('first-full-snapshot');
      expect(got?.mode).toBe('snapshot');
    });
  });
});
