// hive-flow-f16a — setup-level verify regressions (acceptance row A27).
//
// `setup --verify --features statusline` previously reported ok while the
// activity hook family was missing entirely, because runVerify never called the
// hooks adapter. These prove the wiring: one missing event must fail verify,
// and the full exact set must pass it.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { runSetup } from '../setup.js';
import { claudeCodeActivityHooksAdapter, HOOK_WIRING } from '../../integrations/adapters/claude-code-activity-hooks.js';
import {
  commandForClaudeSettings,
  resolveActivityHookLauncherPath,
  resolveActivityHookRuntimeEntrypoint,
  writeStableActivityHookLauncher,
} from '../../integrations/launcher.js';

const REPO_ROOT = resolve(__dirname, '..', '..', '..', '..');

let home: string;
let projectRoot: string;
let settingsPath: string;

const adapterCtx = () => ({
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

const verifySetup = () =>
  runSetup({
    action: 'verify',
    agents: ['claude-code'],
    scope: 'user',
    cwd: projectRoot,
    homeDir: home,
    dryRun: true,
    createConfig: false,
    forceAdopt: false,
    features: 'statusline',
  });

/** The verify rows contributed by the activity-hooks adapter. */
const hookRows = (results: any[]): any[] =>
  results.filter((r) => typeof r?.output === 'string' && /activity hooks/i.test(r.output));

beforeEach(() => {
  home = realpathSync(mkdtempSync(join(tmpdir(), 'hf-f16a-setupverify-home-')));
  projectRoot = realpathSync(mkdtempSync(join(tmpdir(), 'hf-f16a-setupverify-proj-')));
  mkdirSync(join(home, '.claude'), { recursive: true });
  settingsPath = join(home, '.claude', 'settings.json');
  writeFileSync(settingsPath, JSON.stringify({}, null, 2));
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

describe('setup --verify covers the activity hooks (A27)', () => {
  it('FAILS when the hook family is absent entirely', async () => {
    const { results } = (await verifySetup()) as { results: any[] };
    const rows = hookRows(results);
    expect(rows.length).toBeGreaterThan(0); // the adapter is actually wired in
    expect(rows.every((r) => r.ok === true)).toBe(false);
  });

  it('FAILS when exactly one wired event is missing', async () => {
    await claudeCodeActivityHooksAdapter.apply(adapterCtx());

    // Surgically drop one event's entry.
    const settings = JSON.parse(readFileSync(settingsPath, 'utf8'));
    delete settings.hooks.SubagentStop;
    writeFileSync(settingsPath, JSON.stringify(settings, null, 2));

    const { results } = (await verifySetup()) as { results: any[] };
    const rows = hookRows(results);
    expect(rows.some((r) => r.ok === false && /SubagentStop/.test(r.output))).toBe(true);
  });

  it('PASSES only when every wired event carries the exact canonical entry', async () => {
    await claudeCodeActivityHooksAdapter.apply(adapterCtx());
    // verify now also runs an executable canary (B5), so a real launcher shim
    // reaching the built runtime must exist for the pass case.
    await writeStableActivityHookLauncher(
      resolveActivityHookLauncherPath('user', home, projectRoot),
      resolveActivityHookRuntimeEntrypoint(REPO_ROOT),
    );

    const { results } = (await verifySetup()) as { results: any[] };
    const rows = hookRows(results);
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.every((r) => r.ok === true)).toBe(true);

    // And the installed commands really are the canonical ones.
    const settings = JSON.parse(readFileSync(settingsPath, 'utf8'));
    const launcher = resolveActivityHookLauncherPath('user', home, projectRoot);
    for (const [event, arg] of HOOK_WIRING) {
      const commands = (settings.hooks[event] ?? []).flatMap((g: any) =>
        (g.hooks ?? []).map((h: any) => h.command),
      );
      expect(commands).toContain(`${commandForClaudeSettings(launcher)} ${arg}`);
    }
  });

  it('FAILS when an event carries only a look-alike foreign command', async () => {
    await claudeCodeActivityHooksAdapter.apply(adapterCtx());
    const settings = JSON.parse(readFileSync(settingsPath, 'utf8'));
    const launcher = resolveActivityHookLauncherPath('user', home, projectRoot);
    // Replace our Stop entry with a decoy that merely mentions the path.
    settings.hooks.Stop = [{ hooks: [{ type: 'command', command: `echo '${launcher}' stop` }] }];
    writeFileSync(settingsPath, JSON.stringify(settings, null, 2));

    const { results } = (await verifySetup()) as { results: any[] };
    expect(hookRows(results).some((r) => r.ok === false && /Stop/.test(r.output))).toBe(true);
  });
});
