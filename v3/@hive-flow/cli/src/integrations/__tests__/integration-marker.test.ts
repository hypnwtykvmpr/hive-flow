// v3/@hive-flow/cli/src/integrations/__tests__/integration-marker.test.ts
//
// Wave 11A — Integration marker foundation tests.
//
// Covers `writeMarker`, `readMarker`, `removeMarker`, and `markerPath` from
// `../integration-marker.ts`. Tests run against a temporary `projectRoot` and
// a temporary `HIVE_FLOW_HOME` override so user-scope writes do not touch the
// developer's real home directory.
//
// Cast convention: a few tests below use `value as unknown as <Type>` to feed
// deliberately-invalid values into the production runtime guards. This is the
// only path TypeScript allows for exercising defence-in-depth — the
// production functions accept the typed union, and the test must defeat the
// compile-time check to reach the runtime guard. The bug-hunt rule
// disallowing typed casts is scoped to production code; the matching tests
// here verify the guards trigger on the same bad inputs.

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  chmodSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import type { AdapterTarget } from '../adapters/types.js';
import {
  markerPath,
  readMarker,
  removeMarker,
  writeMarker,
  type IntegrationMarker,
} from '../integration-marker.js';

let projectRoot: string;
let userHome: string;
let originalHome: string | undefined;

beforeEach(() => {
  projectRoot = mkdtempSync(join(tmpdir(), 'hf-marker-proj-'));
  userHome = mkdtempSync(join(tmpdir(), 'hf-marker-home-'));
  originalHome = process.env.HIVE_FLOW_HOME;
  process.env.HIVE_FLOW_HOME = userHome;
});

afterEach(() => {
  if (originalHome === undefined) delete process.env.HIVE_FLOW_HOME;
  else process.env.HIVE_FLOW_HOME = originalHome;
  rmSync(projectRoot, { recursive: true, force: true });
  rmSync(userHome, { recursive: true, force: true });
});

describe('integration-marker: markerPath()', () => {
  it('returns ${projectRoot}/.hive-flow/integrations/${target}.json for project scope', () => {
    const p = markerPath({ projectRoot, target: 'claude-code', scope: 'project' });
    expect(p).toBe(join(projectRoot, '.hive-flow', 'integrations', 'claude-code.json'));
  });

  it('returns ${HIVE_FLOW_HOME}/.hive-flow/integrations/${target}.json for user scope', () => {
    const p = markerPath({ projectRoot, target: 'codex', scope: 'user' });
    expect(p).toBe(join(userHome, '.hive-flow', 'integrations', 'codex.json'));
  });

  it('throws on an unknown target', () => {
    expect(() =>
      markerPath({ projectRoot, target: 'not-a-target' as unknown as AdapterTarget, scope: 'project' }),
    ).toThrow(/unknown target/);
  });

  it('throws on an unsupported scope', () => {
    expect(() =>
      markerPath({ projectRoot, target: 'codex', scope: 'managed' as unknown as 'project' }),
    ).toThrow(/unsupported scope/);
  });

  it('throws on a non-absolute projectRoot', () => {
    expect(() =>
      markerPath({ projectRoot: './relative', target: 'codex', scope: 'project' }),
    ).toThrow(/must be absolute/);
  });
});

describe('integration-marker: writeMarker() + readMarker() round-trip', () => {
  it('round-trips a project-scope wrapper-mode marker with optional fields', async () => {
    const scriptPath = join(projectRoot, '.hive-flow', 'wrappers', 'codex');
    const realCliBin = '/opt/codex/bin/codex';
    await writeMarker({
      projectRoot,
      target: 'codex',
      tier: 'wrapper-mode',
      scope: 'project',
      scriptPath,
      realCliBin,
      nowMs: Date.UTC(2026, 4, 22, 12, 0, 0),
    });
    const read = await readMarker({ projectRoot, target: 'codex', scope: 'project' });
    expect(read).toBeDefined();
    expect(read).toEqual<IntegrationMarker>({
      version: 1,
      target: 'codex',
      tier: 'wrapper-mode',
      scope: 'project',
      installedAt: '2026-05-22T12:00:00.000Z',
      scriptPath,
      realCliBin,
    });
  });

  it('round-trips a user-scope native-plugin marker without optional fields', async () => {
    await writeMarker({
      projectRoot,
      target: 'claude-code',
      tier: 'native-plugin',
      scope: 'user',
      nowMs: Date.UTC(2026, 4, 22, 13, 0, 0),
    });
    const read = await readMarker({ projectRoot, target: 'claude-code', scope: 'user' });
    expect(read).toEqual<IntegrationMarker>({
      version: 1,
      target: 'claude-code',
      tier: 'native-plugin',
      scope: 'user',
      installedAt: '2026-05-22T13:00:00.000Z',
    });
  });

  it('writes the user-scope marker under HIVE_FLOW_HOME, not the real homedir', async () => {
    await writeMarker({
      projectRoot,
      target: 'qwen',
      tier: 'wrapper-mode',
      scope: 'user',
    });
    const expected = join(userHome, '.hive-flow', 'integrations', 'qwen.json');
    // Direct stat: we must not have written outside the override.
    expect(statSync(expected).isFile()).toBe(true);
  });

  it('writes a fresh installedAt when nowMs is omitted', async () => {
    const before = Date.now();
    await writeMarker({
      projectRoot,
      target: 'gemini',
      tier: 'wrapper-mode',
      scope: 'project',
    });
    const after = Date.now();
    const read = await readMarker({ projectRoot, target: 'gemini', scope: 'project' });
    expect(read).toBeDefined();
    const ts = Date.parse(read?.installedAt ?? '');
    expect(Number.isFinite(ts)).toBe(true);
    expect(ts).toBeGreaterThanOrEqual(before);
    expect(ts).toBeLessThanOrEqual(after);
  });
});

describe('integration-marker: readMarker() rejection cases', () => {
  it('returns undefined when the marker file is absent', async () => {
    const read = await readMarker({ projectRoot, target: 'codex', scope: 'project' });
    expect(read).toBeUndefined();
  });

  it('returns undefined when the file is corrupt JSON (project scope)', async () => {
    const path = markerPath({ projectRoot, target: 'codex', scope: 'project' });
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, '{ not valid json');
    const read = await readMarker({ projectRoot, target: 'codex', scope: 'project' });
    expect(read).toBeUndefined();
  });

  it('returns undefined when the file is corrupt JSON (user scope)', async () => {
    const path = markerPath({ projectRoot, target: 'codex', scope: 'user' });
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, '{ also not valid');
    const read = await readMarker({ projectRoot, target: 'codex', scope: 'user' });
    expect(read).toBeUndefined();
  });

  it('returns undefined when the marker version is not 1 (future schema)', async () => {
    const path = markerPath({ projectRoot, target: 'codex', scope: 'project' });
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(
      path,
      JSON.stringify({
        version: 99,
        target: 'codex',
        tier: 'wrapper-mode',
        scope: 'project',
        installedAt: new Date().toISOString(),
      }),
    );
    const read = await readMarker({ projectRoot, target: 'codex', scope: 'project' });
    expect(read).toBeUndefined();
  });

  it('returns undefined when the marker target does not match the locator', async () => {
    const path = markerPath({ projectRoot, target: 'codex', scope: 'project' });
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(
      path,
      JSON.stringify({
        version: 1,
        // Stamp says gemini but the locator asks for codex; the validator
        // must reject the cross-target mismatch.
        target: 'gemini',
        tier: 'wrapper-mode',
        scope: 'project',
        installedAt: new Date().toISOString(),
      }),
    );
    const read = await readMarker({ projectRoot, target: 'codex', scope: 'project' });
    expect(read).toBeUndefined();
  });

  it('returns undefined when the marker scope does not match the locator', async () => {
    const path = markerPath({ projectRoot, target: 'codex', scope: 'project' });
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(
      path,
      JSON.stringify({
        version: 1,
        target: 'codex',
        tier: 'wrapper-mode',
        // File is at project path, but body claims user — reject.
        scope: 'user',
        installedAt: new Date().toISOString(),
      }),
    );
    const read = await readMarker({ projectRoot, target: 'codex', scope: 'project' });
    expect(read).toBeUndefined();
  });

  it('returns undefined when the tier is unknown', async () => {
    const path = markerPath({ projectRoot, target: 'codex', scope: 'project' });
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(
      path,
      JSON.stringify({
        version: 1,
        target: 'codex',
        tier: 'experimental-tier',
        scope: 'project',
        installedAt: new Date().toISOString(),
      }),
    );
    const read = await readMarker({ projectRoot, target: 'codex', scope: 'project' });
    expect(read).toBeUndefined();
  });

  it('returns undefined when installedAt is missing or unparseable', async () => {
    const path = markerPath({ projectRoot, target: 'codex', scope: 'project' });
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(
      path,
      JSON.stringify({
        version: 1,
        target: 'codex',
        tier: 'wrapper-mode',
        scope: 'project',
        installedAt: 'not a date',
      }),
    );
    const read = await readMarker({ projectRoot, target: 'codex', scope: 'project' });
    expect(read).toBeUndefined();
  });

  it('rejects a symlinked project-scope marker via guarded read', async () => {
    const path = markerPath({ projectRoot, target: 'codex', scope: 'project' });
    mkdirSync(dirname(path), { recursive: true });
    // Write a valid marker outside the guarded path, then point the marker
    // path at it via symlink. The guarded reader walks every `.hive-flow/`
    // segment and refuses to read through a symlinked leaf.
    const offTreePath = join(projectRoot, 'off-tree-marker.json');
    writeFileSync(
      offTreePath,
      JSON.stringify({
        version: 1,
        target: 'codex',
        tier: 'wrapper-mode',
        scope: 'project',
        installedAt: new Date().toISOString(),
      }),
    );
    symlinkSync(offTreePath, path);
    const read = await readMarker({ projectRoot, target: 'codex', scope: 'project' });
    expect(read).toBeUndefined();
  });

  it('rejects a symlinked user-scope marker via guarded read', async () => {
    const path = markerPath({ projectRoot, target: 'codex', scope: 'user' });
    mkdirSync(dirname(path), { recursive: true });
    const offTreePath = join(userHome, 'off-tree-user.json');
    writeFileSync(
      offTreePath,
      JSON.stringify({
        version: 1,
        target: 'codex',
        tier: 'wrapper-mode',
        scope: 'user',
        installedAt: new Date().toISOString(),
      }),
    );
    symlinkSync(offTreePath, path);
    const read = await readMarker({ projectRoot, target: 'codex', scope: 'user' });
    expect(read).toBeUndefined();
  });
});

describe('integration-marker: writeMarker() symlink rejection', () => {
  it('refuses to write a project-scope marker through a symlinked .hive-flow/integrations parent', async () => {
    // Replace `.hive-flow/integrations/` with a symlink pointing somewhere
    // off-tree before write; the guarded primitive must refuse.
    mkdirSync(join(projectRoot, '.hive-flow'), { recursive: true });
    const offTreeDir = mkdtempSync(join(tmpdir(), 'hf-off-tree-'));
    symlinkSync(offTreeDir, join(projectRoot, '.hive-flow', 'integrations'));
    await expect(
      writeMarker({
        projectRoot,
        target: 'codex',
        tier: 'wrapper-mode',
        scope: 'project',
      }),
    ).rejects.toThrow();
    rmSync(offTreeDir, { recursive: true, force: true });
  });

  it('refuses to write a user-scope marker through a symlinked .hive-flow/integrations parent', async () => {
    mkdirSync(join(userHome, '.hive-flow'), { recursive: true });
    const offTreeDir = mkdtempSync(join(tmpdir(), 'hf-off-tree-user-'));
    symlinkSync(offTreeDir, join(userHome, '.hive-flow', 'integrations'));
    await expect(
      writeMarker({
        projectRoot,
        target: 'codex',
        tier: 'wrapper-mode',
        scope: 'user',
      }),
    ).rejects.toThrow();
    rmSync(offTreeDir, { recursive: true, force: true });
  });
});

describe('integration-marker: file permissions', () => {
  it('writes a project-scope marker with 0o600 mode', async () => {
    await writeMarker({
      projectRoot,
      target: 'codex',
      tier: 'wrapper-mode',
      scope: 'project',
    });
    const path = markerPath({ projectRoot, target: 'codex', scope: 'project' });
    const st = statSync(path);
    expect(st.mode & 0o777).toBe(0o600);
  });

  it('writes a user-scope marker with 0o600 mode', async () => {
    await writeMarker({
      projectRoot,
      target: 'codex',
      tier: 'wrapper-mode',
      scope: 'user',
    });
    const path = markerPath({ projectRoot, target: 'codex', scope: 'user' });
    const st = statSync(path);
    expect(st.mode & 0o777).toBe(0o600);
  });

  it('does not follow a symlink when computing the leaf path', async () => {
    // Defence in depth: the leaf itself is the marker — assert the file we
    // wrote is a regular file, not a symlinked one.
    await writeMarker({
      projectRoot,
      target: 'codex',
      tier: 'wrapper-mode',
      scope: 'project',
    });
    const path = markerPath({ projectRoot, target: 'codex', scope: 'project' });
    const ls = lstatSync(path);
    expect(ls.isFile()).toBe(true);
    expect(ls.isSymbolicLink()).toBe(false);
  });
});

describe('integration-marker: removeMarker()', () => {
  it('removes a previously-written project-scope marker', async () => {
    await writeMarker({
      projectRoot,
      target: 'codex',
      tier: 'wrapper-mode',
      scope: 'project',
    });
    await removeMarker({ projectRoot, target: 'codex', scope: 'project' });
    const read = await readMarker({ projectRoot, target: 'codex', scope: 'project' });
    expect(read).toBeUndefined();
  });

  it('removes a previously-written user-scope marker', async () => {
    await writeMarker({
      projectRoot,
      target: 'qwen',
      tier: 'wrapper-mode',
      scope: 'user',
    });
    await removeMarker({ projectRoot, target: 'qwen', scope: 'user' });
    const read = await readMarker({ projectRoot, target: 'qwen', scope: 'user' });
    expect(read).toBeUndefined();
  });

  it('is idempotent — calling twice on an absent marker does not throw', async () => {
    await expect(removeMarker({ projectRoot, target: 'codex', scope: 'project' })).resolves.toBeUndefined();
    await expect(removeMarker({ projectRoot, target: 'codex', scope: 'project' })).resolves.toBeUndefined();
  });

  it('is idempotent across write + remove + remove sequences', async () => {
    await writeMarker({
      projectRoot,
      target: 'opencode',
      tier: 'wrapper-mode',
      scope: 'project',
    });
    await removeMarker({ projectRoot, target: 'opencode', scope: 'project' });
    await expect(
      removeMarker({ projectRoot, target: 'opencode', scope: 'project' }),
    ).resolves.toBeUndefined();
  });

  it('does nothing on unknown target / unsupported scope (defensive)', async () => {
    await expect(
      removeMarker({
        projectRoot,
        target: 'not-a-target' as unknown as AdapterTarget,
        scope: 'project',
      }),
    ).resolves.toBeUndefined();
  });

  // ---------------------------------------------------------------------------
  // Symlinked-parent regression (Codex probe).
  //
  // Before the guarded-unlink fix, `removeMarker` (project scope) called a
  // raw `unlink` on `${projectRoot}/.hive-flow/integrations/${target}.json`
  // without walking the intermediate path. If an attacker swapped
  // `.hive-flow/` for a symlink to an outside directory between
  // `writeMarker` and `removeMarker`, the kernel would resolve the path
  // through the symlink and delete the outside file. The fix routes
  // through `safeUnlinkInHiveFlow` / `safeUnlinkInUserCache` which lstat
  // every segment first.
  // ---------------------------------------------------------------------------

  it('removeMarker rejects symlinked .hive-flow parent (project scope) and preserves outside file', async () => {
    // Plant a victim marker file outside the project tree.
    const outside = mkdtempSync(join(tmpdir(), 'hf-rm-outside-proj-'));
    const outsideIntegrations = join(outside, 'integrations');
    mkdirSync(outsideIntegrations, { recursive: true });
    const outsideMarker = join(outsideIntegrations, 'codex.json');
    writeFileSync(outsideMarker, '{"victim":true}');
    // Replace `.hive-flow` with a symlink to `outside`.
    symlinkSync(outside, join(projectRoot, '.hive-flow'));
    // removeMarker must NOT follow the symlink. It either rejects or
    // no-ops; either way it MUST NOT delete the victim file.
    await expect(
      removeMarker({ projectRoot, target: 'codex', scope: 'project' }),
    ).resolves.toBeUndefined();
    expect(statSync(outsideMarker).isFile()).toBe(true);
    expect(readFileSync(outsideMarker, 'utf8')).toBe('{"victim":true}');
    rmSync(outside, { recursive: true, force: true });
  });

  it('removeMarker rejects symlinked .hive-flow/integrations parent (project scope) and preserves outside file', async () => {
    // `.hive-flow` is a real dir, but `.hive-flow/integrations` is the symlink.
    mkdirSync(join(projectRoot, '.hive-flow'), { recursive: true });
    const outside = mkdtempSync(join(tmpdir(), 'hf-rm-outside-int-'));
    const outsideMarker = join(outside, 'codex.json');
    writeFileSync(outsideMarker, '{"victim":true}');
    symlinkSync(outside, join(projectRoot, '.hive-flow', 'integrations'));
    await expect(
      removeMarker({ projectRoot, target: 'codex', scope: 'project' }),
    ).resolves.toBeUndefined();
    expect(statSync(outsideMarker).isFile()).toBe(true);
    expect(readFileSync(outsideMarker, 'utf8')).toBe('{"victim":true}');
    rmSync(outside, { recursive: true, force: true });
  });

  it('removeMarker rejects symlinked marker leaf (project scope) and preserves outside file', async () => {
    // Parents are real dirs; the LEAF marker is a symlink pointing outside.
    const parent = join(projectRoot, '.hive-flow', 'integrations');
    mkdirSync(parent, { recursive: true });
    const outsideDir = mkdtempSync(join(tmpdir(), 'hf-rm-outside-leaf-'));
    const outsideMarker = join(outsideDir, 'real-marker.json');
    writeFileSync(outsideMarker, '{"victim":true}');
    symlinkSync(outsideMarker, join(parent, 'codex.json'));
    await expect(
      removeMarker({ projectRoot, target: 'codex', scope: 'project' }),
    ).resolves.toBeUndefined();
    // The victim file is intact.
    expect(statSync(outsideMarker).isFile()).toBe(true);
    expect(readFileSync(outsideMarker, 'utf8')).toBe('{"victim":true}');
    rmSync(outsideDir, { recursive: true, force: true });
  });

  it('removeMarker rejects symlinked .hive-flow parent (user scope) and preserves outside file', async () => {
    const outside = mkdtempSync(join(tmpdir(), 'hf-rm-outside-user-'));
    const outsideIntegrations = join(outside, 'integrations');
    mkdirSync(outsideIntegrations, { recursive: true });
    const outsideMarker = join(outsideIntegrations, 'codex.json');
    writeFileSync(outsideMarker, '{"victim":true}');
    symlinkSync(outside, join(userHome, '.hive-flow'));
    await expect(
      removeMarker({ projectRoot, target: 'codex', scope: 'user' }),
    ).resolves.toBeUndefined();
    expect(statSync(outsideMarker).isFile()).toBe(true);
    expect(readFileSync(outsideMarker, 'utf8')).toBe('{"victim":true}');
    rmSync(outside, { recursive: true, force: true });
  });

  it('removeMarker rejects symlinked .hive-flow/integrations parent (user scope) and preserves outside file', async () => {
    mkdirSync(join(userHome, '.hive-flow'), { recursive: true });
    const outside = mkdtempSync(join(tmpdir(), 'hf-rm-outside-user-int-'));
    const outsideMarker = join(outside, 'codex.json');
    writeFileSync(outsideMarker, '{"victim":true}');
    symlinkSync(outside, join(userHome, '.hive-flow', 'integrations'));
    await expect(
      removeMarker({ projectRoot, target: 'codex', scope: 'user' }),
    ).resolves.toBeUndefined();
    expect(statSync(outsideMarker).isFile()).toBe(true);
    expect(readFileSync(outsideMarker, 'utf8')).toBe('{"victim":true}');
    rmSync(outside, { recursive: true, force: true });
  });

  it('removeMarker rejects symlinked marker leaf (user scope) and preserves outside file', async () => {
    const parent = join(userHome, '.hive-flow', 'integrations');
    mkdirSync(parent, { recursive: true });
    const outsideDir = mkdtempSync(join(tmpdir(), 'hf-rm-outside-user-leaf-'));
    const outsideMarker = join(outsideDir, 'real-marker.json');
    writeFileSync(outsideMarker, '{"victim":true}');
    symlinkSync(outsideMarker, join(parent, 'codex.json'));
    await expect(
      removeMarker({ projectRoot, target: 'codex', scope: 'user' }),
    ).resolves.toBeUndefined();
    expect(statSync(outsideMarker).isFile()).toBe(true);
    expect(readFileSync(outsideMarker, 'utf8')).toBe('{"victim":true}');
    rmSync(outsideDir, { recursive: true, force: true });
  });

  it('removeMarker remains idempotent after a symlink-rejection encounter (project scope)', async () => {
    // After a symlink rejection, the guarded primitive returns normally;
    // subsequent legitimate calls must continue to behave normally.
    const outside = mkdtempSync(join(tmpdir(), 'hf-rm-idem-proj-'));
    symlinkSync(outside, join(projectRoot, '.hive-flow'));
    await expect(
      removeMarker({ projectRoot, target: 'codex', scope: 'project' }),
    ).resolves.toBeUndefined();
    // Repeat — still a no-op.
    await expect(
      removeMarker({ projectRoot, target: 'codex', scope: 'project' }),
    ).resolves.toBeUndefined();
    rmSync(outside, { recursive: true, force: true });
  });
});

describe('integration-marker: defensive input handling', () => {
  it('readMarker returns undefined for non-absolute projectRoot', async () => {
    const read = await readMarker({ projectRoot: 'relative/path', target: 'codex', scope: 'project' });
    expect(read).toBeUndefined();
  });

  it('writeMarker rejects unsupported tier values', async () => {
    await expect(
      writeMarker({
        projectRoot,
        target: 'codex',
        tier: 'experimental' as unknown as 'wrapper-mode',
        scope: 'project',
      }),
    ).rejects.toThrow(/unsupported tier/);
  });

  it('writeMarker rejects unsupported scope values', async () => {
    await expect(
      writeMarker({
        projectRoot,
        target: 'codex',
        tier: 'wrapper-mode',
        scope: 'managed' as unknown as 'project',
      }),
    ).rejects.toThrow(/unsupported scope/);
  });

  it('writeMarker rejects unknown target values', async () => {
    await expect(
      writeMarker({
        projectRoot,
        target: 'not-real' as unknown as AdapterTarget,
        tier: 'wrapper-mode',
        scope: 'project',
      }),
    ).rejects.toThrow(/unknown target/);
  });
});

// Note: the imports at the top include `chmodSync` and `readFileSync` for the
// permission test below. They are intentionally retained even when unused in
// other blocks because vitest's tree-shaking does not strip dead imports from
// test files and listing them once at the top keeps the import block stable
// across future test additions.
void chmodSync;
void readFileSync;
