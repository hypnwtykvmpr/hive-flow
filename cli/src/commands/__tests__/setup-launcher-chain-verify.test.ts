// hive-flow-a541 — setup-level verify regression for the attesting launcher chain.
//
// `setup --verify --features mcp` previously reported healthy for a wrapper that
// execs the MCP server directly, because adapter verification only proves the
// CONFIG points at the wrapper: the server connects either way and only the
// attestation differs. These prove the wiring — without them the chain row could
// be deleted from runVerify and every launcher-level test would stay green.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { runSetup } from '../setup.js';
import {
  resolveLauncherPath,
  writeStableLauncher,
  MCP_LAUNCHER_BUNDLE_FILES,
  MCP_LAUNCHER_POLICY_FILES,
} from '../../integrations/launcher.js';

const REPO_ROOT = resolve(__dirname, '..', '..', '..', '..');
const SOURCE_HELPERS = join(REPO_ROOT, '.claude', 'helpers');
const SOURCE_POLICY = join(REPO_ROOT, 'cli', 'src', 'permission-guard');

let home: string;
let projectRoot: string;

const verifyMcp = () =>
  runSetup({
    action: 'verify',
    // The chain row is global and runs outside the per-agent loop, so an empty
    // agent list keeps this suite hermetic — otherwise every case would shell
    // out to the machine's real `claude mcp get`.
    agents: [],
    scope: 'user',
    cwd: projectRoot,
    homeDir: home,
    dryRun: true,
    createConfig: false,
    forceAdopt: false,
    features: 'mcp',
  });

/** The verify row contributed by the launcher-chain check. */
const chainRows = (results: any[]): any[] => results.filter((r) => r?.agent === 'launcher-chain');

/** A complete real bundle, so the launcher's own `require`s resolve as in production. */
function seedRealBundle(): string {
  const helperDir = join(home, 'bundle');
  mkdirSync(helperDir, { recursive: true });
  for (const file of MCP_LAUNCHER_BUNDLE_FILES) {
    writeFileSync(join(helperDir, file), readFileSync(join(SOURCE_HELPERS, file)));
  }
  for (const file of MCP_LAUNCHER_POLICY_FILES) {
    writeFileSync(join(helperDir, file), readFileSync(join(SOURCE_POLICY, file)));
  }
  return helperDir;
}

function fakeServerPath(): string {
  const server = join(projectRoot, 'fake-mcp-server.js');
  writeFileSync(server, '// bounded stand-in for the MCP server\n');
  return server;
}

beforeEach(() => {
  home = realpathSync(mkdtempSync(join(tmpdir(), 'hf-a541-setupverify-home-')));
  projectRoot = realpathSync(mkdtempSync(join(tmpdir(), 'hf-a541-setupverify-proj-')));
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

describe.skipIf(process.platform === 'win32')('setup --verify covers the attesting launcher chain (a541)', () => {
  it('emits a chain row that FAILS when no wrapper is installed', async () => {
    const { results } = (await verifyMcp()) as { results: any[] };
    const rows = chainRows(results);
    expect(rows.length).toBe(1);                       // the check is actually wired in
    expect(rows[0].ok).toBe(false);
    expect(rows[0].output).toMatch(/not installed/i);
  });

  it('FAILS for a wrapper that execs the MCP server directly', async () => {
    // The pre-a541 bypass. This is the case that config-only verification
    // reports as healthy, which is the entire point of the row.
    const launcherPath = resolveLauncherPath('user', home, projectRoot);
    mkdirSync(join(home, '.hive-flow', 'bin'), { recursive: true });
    writeFileSync(launcherPath, `#!/usr/bin/env bash\nexec node '${fakeServerPath()}' "$@"\n`);
    chmodSync(launcherPath, 0o755);

    const { results } = (await verifyMcp()) as { results: any[] };
    const rows = chainRows(results);
    expect(rows.length).toBe(1);
    expect(rows[0].ok).toBe(false);
    expect(rows[0].output).toMatch(/does not route through an attesting launcher/i);
  });

  it('PASSES for a correctly generated wrapper backed by a complete bundle', async () => {
    const attesting = join(seedRealBundle(), MCP_LAUNCHER_BUNDLE_FILES[0]);
    const launcherPath = resolveLauncherPath('user', home, projectRoot);
    await writeStableLauncher(launcherPath, fakeServerPath(), attesting);
    chmodSync(launcherPath, 0o755);
    expect(existsSync(launcherPath)).toBe(true);

    const { results } = (await verifyMcp()) as { results: any[] };
    const rows = chainRows(results);
    expect(rows.length).toBe(1);
    expect(rows[0].ok, rows[0].output).toBe(true);
    // The probe supplies its own deterministic identity, so only a real minted
    // and validated record counts as a pass.
    expect(rows[0].output).toMatch(/attests the MCP child/);
  });

  // -------------------------------------------------------------------------
  // Ordering / fail-closed suppression.
  //
  // The chain check's whole safety argument is that a bypass wrapper is never
  // EXECUTED. That is defeated at the call site if adapter verification — which
  // shells out to `claude mcp get hive-flow` and connects the wrapper — runs
  // first. These cases need a real agent CLI on PATH, so they are the one place
  // the hermetic `agents: []` default is deliberately relaxed.
  // -------------------------------------------------------------------------

  /** Put a fake `claude` on PATH that records whether it was invoked. */
  function fakeClaudeCli(): { sentinel: string; restore: () => void } {
    const binDir = join(home, 'fakebin');
    mkdirSync(binDir, { recursive: true });
    const sentinel = join(home, 'adapter-cli-ran');
    const bin = join(binDir, 'claude');
    writeFileSync(bin, `#!/usr/bin/env bash\ntouch '${sentinel}'\necho Connected\n`);
    chmodSync(bin, 0o755);
    const previous = process.env.PATH;
    process.env.PATH = `${binDir}:${previous ?? ''}`;
    return { sentinel, restore: () => { process.env.PATH = previous; } };
  }

  const verifyMcpWithClaude = () =>
    runSetup({
      action: 'verify',
      agents: ['claude-code'],
      scope: 'user',
      cwd: projectRoot,
      homeDir: home,
      dryRun: true,
      createConfig: false,
      forceAdopt: false,
      features: 'mcp',
    });

  it('does NOT invoke the MCP adapter CLI when the installed wrapper is a bypass', async () => {
    const launcherPath = resolveLauncherPath('user', home, projectRoot);
    mkdirSync(join(home, '.hive-flow', 'bin'), { recursive: true });
    writeFileSync(launcherPath, `#!/usr/bin/env bash\nexec node '${fakeServerPath()}' "$@"\n`);
    chmodSync(launcherPath, 0o755);
    const { sentinel, restore } = fakeClaudeCli();
    try {
      const { results } = (await verifyMcpWithClaude()) as { results: any[] };
      expect(chainRows(results)[0].ok).toBe(false);
      expect(existsSync(sentinel), 'adapter CLI ran despite an invalid chain').toBe(false);
      // The adapter row is still reported, as an explicit skip rather than a pass.
      const adapterRow = results.find((r) => r.agent === 'claude-code' && r.feature === 'mcp');
      expect(adapterRow.ok).toBe(false);
      expect(adapterRow.output).toMatch(/skipped/i);
    } finally {
      restore();
    }
  });

  it('DOES invoke the MCP adapter CLI when the chain is valid', async () => {
    // The counterpart that proves suppression is conditional. Without it, a
    // verifier that simply never probed would pass the case above.
    const attesting = join(seedRealBundle(), MCP_LAUNCHER_BUNDLE_FILES[0]);
    const launcherPath = resolveLauncherPath('user', home, projectRoot);
    await writeStableLauncher(launcherPath, fakeServerPath(), attesting);
    chmodSync(launcherPath, 0o755);
    const { sentinel, restore } = fakeClaudeCli();
    try {
      const { results } = (await verifyMcpWithClaude()) as { results: any[] };
      expect(chainRows(results)[0].ok, chainRows(results)[0].output).toBe(true);
      expect(existsSync(sentinel), 'adapter CLI was not invoked for a valid chain').toBe(true);
    } finally {
      restore();
    }
  });

  it('FAILS for a decoy attesting line above a real bypass', async () => {
    // A line-matching verifier would extract the genuine launcher named in the
    // dead branch, execute it successfully, and certify a chain that the
    // wrapper never actually uses.
    const attesting = join(seedRealBundle(), MCP_LAUNCHER_BUNDLE_FILES[0]);
    const server = fakeServerPath();
    const launcherPath = resolveLauncherPath('user', home, projectRoot);
    mkdirSync(join(home, '.hive-flow', 'bin'), { recursive: true });
    writeFileSync(launcherPath, [
      '#!/usr/bin/env bash',
      "# AUTO-GENERATED by 'hive-flow setup'. Do not edit by hand.",
      '# Regenerate with: hive-flow setup reconcile',
      `export HIVE_FLOW_MCP_SERVER_ENTRYPOINT='${server}'`,
      `if false; then exec node '${attesting}' "$@"; fi`,
      `exec node '${server}' "$@"`,
      '',
    ].join('\n'));
    chmodSync(launcherPath, 0o755);

    const { results } = (await verifyMcp()) as { results: any[] };
    const rows = chainRows(results);
    expect(rows.length).toBe(1);
    expect(rows[0].ok).toBe(false);
    expect(rows[0].output).toMatch(/does not route through an attesting launcher/i);
  });

  it('FAILS when the wrapper is correct but its bundle was partially relocated', async () => {
    const helperDir = seedRealBundle();
    const launcherPath = resolveLauncherPath('user', home, projectRoot);
    await writeStableLauncher(launcherPath, fakeServerPath(), join(helperDir, MCP_LAUNCHER_BUNDLE_FILES[0]));
    chmodSync(launcherPath, 0o755);
    // `mcp-attestation.cjs` requires this at load, so the launcher would die at
    // spawn time — while the wrapper text still looks perfectly correct.
    rmSync(join(helperDir, 'client-kind.cjs'), { force: true });

    const { results } = (await verifyMcp()) as { results: any[] };
    const rows = chainRows(results);
    expect(rows.length).toBe(1);
    expect(rows[0].ok).toBe(false);
    expect(rows[0].output).toMatch(/bundle is incomplete/i);
  });
});
