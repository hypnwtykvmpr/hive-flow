// hive-flow-f16a — activity-hook adapter regressions (acceptance rows A18-A20).
//
// The binding review constraint is ENTRY-granular ownership: this adapter may
// only ever add/update/remove hook entries carrying our launcher path. Hooks a
// user had before installation, and hooks they add afterwards, must survive
// apply, reconcile, and uninstall untouched.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { claudeCodeActivityHooksAdapter, HOOK_WIRING } from '../claude-code-activity-hooks.js';
import {
  commandForClaudeSettings,
  resolveActivityHookLauncherPath,
  resolveActivityHookRuntimeEntrypoint,
  writeStableActivityHookLauncher,
} from '../../launcher.js';

/** Repo root, so the canary can reach the real built runtime. */
const REPO_ROOT = resolve(__dirname, '..', '..', '..', '..', '..');

let home: string;
let projectRoot: string;
let settingsPath: string;

const ctx = () => ({
  projectRoot,
  homeDir: home,
  scope: 'user' as const,
  launcherPath: join(home, '.hive-flow', 'bin', 'hive-flow-mcp-server'),
  statuslineLauncherPath: join(home, '.hive-flow', 'bin', 'claude-code-statusline'),
  userSettingsPath: settingsPath,
  statePath: join(home, '.hive-flow', 'integrations.json'),
  dryRun: false,
  createConfig: true,
  forceAdopt: false,
});

const readSettings = (): Record<string, any> => JSON.parse(readFileSync(settingsPath, 'utf8'));
const launcher = (): string => resolveActivityHookLauncherPath('user', home, projectRoot);
/**
 * Count entries that are OURS by the same exact-canonical rule the adapter
 * uses. Deliberately NOT a substring test: a substring helper would make the
 * decoy regressions below vacuous.
 */
const canonicalFor = (event: string): string => {
  const wiring = HOOK_WIRING.find(([name]) => name === event);
  if (!wiring) throw new Error(`unwired event ${event}`);
  return `${commandForClaudeSettings(launcher())} ${wiring[1]}`;
};
const ourEntries = (settings: Record<string, any>, event: string): unknown[] =>
  (settings.hooks?.[event] ?? []).flatMap((g: any) =>
    (g.hooks ?? []).filter(
      (h: any) => h?.type === 'command' && typeof h?.command === 'string' && h.command.trim() === canonicalFor(event),
    ),
  );

beforeEach(() => {
  home = realpathSync(mkdtempSync(join(tmpdir(), 'hf-f16a-hooks-home-')));
  projectRoot = realpathSync(mkdtempSync(join(tmpdir(), 'hf-f16a-hooks-proj-')));
  mkdirSync(join(home, '.claude'), { recursive: true });
  settingsPath = join(home, '.claude', 'settings.json');
});

afterEach(() => {
  for (const dir of [home, projectRoot]) {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      /* best effort */
    }
  }
});

describe('install (A18)', () => {
  it('installs one entry per wired event', async () => {
    writeFileSync(settingsPath, JSON.stringify({ model: 'opus' }, null, 2));
    const result = await claudeCodeActivityHooksAdapter.apply(ctx());
    expect(result.outcome).toBe('applied');

    const settings = readSettings();
    for (const [event] of HOOK_WIRING) {
      expect(ourEntries(settings, event)).toHaveLength(1);
    }
    // Unrelated top-level settings are untouched.
    expect(settings.model).toBe('opus');
  });

  it('is idempotent: repeated apply never duplicates entries', async () => {
    writeFileSync(settingsPath, JSON.stringify({}, null, 2));
    await claudeCodeActivityHooksAdapter.apply(ctx());
    const second = await claudeCodeActivityHooksAdapter.apply(ctx());
    // Nothing left to change on a reconcile of an already-installed family.
    expect(second.outcome).toBe('already-registered');

    const settings = readSettings();
    for (const [event] of HOOK_WIRING) {
      expect(ourEntries(settings, event)).toHaveLength(1);
    }
  });

  it('keeps settings.json valid JSON throughout (A20)', async () => {
    writeFileSync(settingsPath, JSON.stringify({ permissions: { allow: ['Bash'] } }, null, 2));
    await claudeCodeActivityHooksAdapter.apply(ctx());
    expect(() => readSettings()).not.toThrow();
    expect(readSettings().permissions.allow).toEqual(['Bash']);
  });
});

describe('coexistence with third-party hooks (A19)', () => {
  const thirdParty = {
    matcher: '*',
    hooks: [{ type: 'command', command: '/opt/other-tool/hook.sh audit', timeout: 9 }],
  };

  it('preserves third-party hooks that existed BEFORE installation', async () => {
    writeFileSync(
      settingsPath,
      JSON.stringify({ hooks: { PreToolUse: [thirdParty], SessionStart: [thirdParty] } }, null, 2),
    );

    await claudeCodeActivityHooksAdapter.apply(ctx());

    const settings = readSettings();
    // Their group survives verbatim alongside ours.
    expect(settings.hooks.PreToolUse).toContainEqual(thirdParty);
    expect(settings.hooks.SessionStart).toContainEqual(thirdParty);
    expect(ourEntries(settings, 'PreToolUse')).toHaveLength(1);
  });

  it('preserves third-party hooks ADDED AFTER installation across reconcile and uninstall', async () => {
    writeFileSync(settingsPath, JSON.stringify({}, null, 2));
    await claudeCodeActivityHooksAdapter.apply(ctx());

    // The user adds their own hook afterwards, in an event we manage.
    const afterInstall = readSettings();
    afterInstall.hooks.PostToolUse.push(thirdParty);
    writeFileSync(settingsPath, JSON.stringify(afterInstall, null, 2));

    // Reconcile must not disturb it.
    await claudeCodeActivityHooksAdapter.apply(ctx());
    expect(readSettings().hooks.PostToolUse).toContainEqual(thirdParty);

    // Neither may uninstall.
    const removed = await claudeCodeActivityHooksAdapter.uninstall(ctx());
    expect(removed.outcome).toBe('applied');
    const final = readSettings();
    expect(final.hooks.PostToolUse).toContainEqual(thirdParty);
    // ...while every entry of ours is gone.
    for (const [event] of HOOK_WIRING) {
      expect(ourEntries(final, event)).toHaveLength(0);
    }
  });

  it('preserves an unrelated entry sharing a group with ours', async () => {
    writeFileSync(settingsPath, JSON.stringify({}, null, 2));
    await claudeCodeActivityHooksAdapter.apply(ctx());

    // Splice a foreign entry INTO our own group — removal must be per-entry,
    // not per-group, or this would be collateral damage.
    const settings = readSettings();
    settings.hooks.Stop[0].hooks.push({ type: 'command', command: '/opt/other/stop.sh' });
    writeFileSync(settingsPath, JSON.stringify(settings, null, 2));

    await claudeCodeActivityHooksAdapter.uninstall(ctx());

    const final = readSettings();
    const remaining = (final.hooks.Stop ?? []).flatMap((g: any) => g.hooks ?? []);
    expect(remaining).toContainEqual({ type: 'command', command: '/opt/other/stop.sh' });
  });
});

describe('foreign decoys that merely MENTION our launcher path (A19)', () => {
  // Ownership must be the exact canonical command for the event. A substring
  // test would silently adopt — and later delete — these third-party entries.
  const decoys = () => [
    { type: 'command', command: `echo '${launcher()}'` },
    { type: 'command', command: `/opt/wrapper/run.sh ${launcher()} prompt` },
    { type: 'command', command: `${launcher()}-other prompt` },
    // Right executable, but an argument we never install.
    { type: 'command', command: `${launcher()} not-an-event` },
  ];

  it('survive apply, reconcile, uninstall, and are not counted by verify', async () => {
    writeFileSync(
      settingsPath,
      JSON.stringify({ hooks: { UserPromptSubmit: [{ hooks: decoys() }] } }, null, 2),
    );

    // verify must NOT count decoys as our installation.
    expect((await claudeCodeActivityHooksAdapter.verify!(ctx())).ok).toBe(false);

    await claudeCodeActivityHooksAdapter.apply(ctx());
    let entries = (readSettings().hooks.UserPromptSubmit ?? []).flatMap((g: any) => g.hooks ?? []);
    for (const decoy of decoys()) expect(entries).toContainEqual(decoy);

    // Reconcile leaves them alone.
    await claudeCodeActivityHooksAdapter.apply(ctx());
    entries = (readSettings().hooks.UserPromptSubmit ?? []).flatMap((g: any) => g.hooks ?? []);
    for (const decoy of decoys()) expect(entries).toContainEqual(decoy);

    // Uninstall removes ONLY the exact canonical entry.
    await claudeCodeActivityHooksAdapter.uninstall(ctx());
    entries = (readSettings().hooks.UserPromptSubmit ?? []).flatMap((g: any) => g.hooks ?? []);
    for (const decoy of decoys()) expect(entries).toContainEqual(decoy);
    expect(ourEntries(readSettings(), 'UserPromptSubmit')).toHaveLength(0);
  });
});

describe('uninstall (A20)', () => {
  it('removes only our entries and drops events we solely populated', async () => {
    writeFileSync(settingsPath, JSON.stringify({ model: 'opus' }, null, 2));
    await claudeCodeActivityHooksAdapter.apply(ctx());
    await claudeCodeActivityHooksAdapter.uninstall(ctx());

    const settings = readSettings();
    for (const [event] of HOOK_WIRING) {
      // Either the key is gone or it retains only unrelated entries.
      expect(ourEntries(settings, event)).toHaveLength(0);
    }
    expect(settings.model).toBe('opus');
  });

  it('reports nothing to do when no managed hooks are present', async () => {
    writeFileSync(settingsPath, JSON.stringify({ hooks: {} }, null, 2));
    const result = await claudeCodeActivityHooksAdapter.uninstall(ctx());
    expect(result.outcome).toBe('already-registered');
  });

  it('refuses to touch malformed settings rather than repairing them', async () => {
    writeFileSync(settingsPath, '{ this is not valid json');
    const applied = await claudeCodeActivityHooksAdapter.apply(ctx());
    expect(applied.outcome).toBe('invalid-config');
    const removed = await claudeCodeActivityHooksAdapter.uninstall(ctx());
    expect(removed.outcome).toBe('invalid-config');
  });
});

describe('verify checks the full configured shape and that hooks actually work (B5)', () => {
  /** Install a REAL launcher shim pointing at the built runtime. */
  const installLauncher = async (): Promise<void> => {
    await writeStableActivityHookLauncher(launcher(), resolveActivityHookRuntimeEntrypoint(REPO_ROOT));
  };

  it('passes only with correct config AND a functional launcher', async () => {
    writeFileSync(settingsPath, JSON.stringify({}, null, 2));
    expect((await claudeCodeActivityHooksAdapter.verify!(ctx())).ok).toBe(false);

    await claudeCodeActivityHooksAdapter.apply(ctx());
    // Config is right but the launcher does not exist yet.
    const noLauncher = await claudeCodeActivityHooksAdapter.verify!(ctx());
    expect(noLauncher.ok).toBe(false);
    expect(noLauncher.output).toMatch(/launcher is missing/i);

    await installLauncher();
    const good = await claudeCodeActivityHooksAdapter.verify!(ctx());
    expect(good.ok, good.output).toBe(true);
    expect(good.output).toMatch(/functional/i);
  }, 30_000);

  it('FAILS on a wrong matcher even though the command is canonical', async () => {
    writeFileSync(settingsPath, JSON.stringify({}, null, 2));
    await claudeCodeActivityHooksAdapter.apply(ctx());
    await installLauncher();

    // Park the canonical PreToolUse command under a restrictive matcher: Bash
    // activity would silently never be tracked.
    const settings = readSettings();
    settings.hooks.PreToolUse[0].matcher = 'Read';
    writeFileSync(settingsPath, JSON.stringify(settings, null, 2));

    const result = await claudeCodeActivityHooksAdapter.verify!(ctx());
    expect(result.ok).toBe(false);
    expect(result.output).toMatch(/PreToolUse: wrong matcher/);
  }, 30_000);

  it('FAILS on a wrong managed timeout', async () => {
    writeFileSync(settingsPath, JSON.stringify({}, null, 2));
    await claudeCodeActivityHooksAdapter.apply(ctx());
    await installLauncher();

    const settings = readSettings();
    settings.hooks.Stop[0].hooks[0].timeout = 999;
    writeFileSync(settingsPath, JSON.stringify(settings, null, 2));

    const result = await claudeCodeActivityHooksAdapter.verify!(ctx());
    expect(result.ok).toBe(false);
    expect(result.output).toMatch(/Stop: wrong timeout/);
  }, 30_000);

  it('FAILS when the launcher exists but its runtime is broken', async () => {
    writeFileSync(settingsPath, JSON.stringify({}, null, 2));
    await claudeCodeActivityHooksAdapter.apply(ctx());

    // A shim that exists and is executable but reaches no working runtime.
    // The shim is intentionally fail-open, so exit status alone proves nothing —
    // only the absence of a written projection catches this.
    mkdirSync(join(home, '.hive-flow', 'bin'), { recursive: true });
    writeFileSync(launcher(), '#!/usr/bin/env bash\nexit 0\n', { mode: 0o755 });

    const result = await claudeCodeActivityHooksAdapter.verify!(ctx());
    expect(result.ok).toBe(false);
    expect(result.output).toMatch(/not functional|wrote no generation/i);
  }, 30_000);

  it('canary writes NOTHING into real ~/.claude state', async () => {
    writeFileSync(settingsPath, JSON.stringify({}, null, 2));
    await claudeCodeActivityHooksAdapter.apply(ctx());
    await installLauncher();

    const realStateDir = join(homedir(), '.claude', 'statusline-state');
    const before = existsSync(realStateDir) ? readdirSync(realStateDir) : [];
    await claudeCodeActivityHooksAdapter.verify!(ctx());
    const after = existsSync(realStateDir) ? readdirSync(realStateDir) : [];
    // No canary session leaked into the operator's real state directory.
    expect(after.filter((n) => n.startsWith('canary'))).toHaveLength(0);
    expect(after.length).toBe(before.length);
  }, 30_000);
});
