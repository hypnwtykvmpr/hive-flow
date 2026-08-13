// hive-flow-a541 — FUNCTIONAL launcher-chain canary.
//
// Every other launcher test inspects generated text. Text can be correct while
// the chain is broken, and the a541 defect was precisely a wrapper that *looked*
// fine and silently bypassed attestation. So this executes the real chain:
//
//   generated POSIX wrapper -> real hive-flow-mcp-launcher.cjs -> bounded child
//
// and validates the attestation record the child actually received.
//
// Exit 0 and string presence are explicitly NOT treated as proof: the launcher
// is designed to start the server even when minting fails (it only logs to
// stderr), so a green exit says nothing about whether attestation happened. The
// record itself is the evidence, and it is read WHILE THE CHILD IS ALIVE —
// the launcher deletes it on child exit, so a post-hoc read would find nothing
// and could not distinguish "attested then cleaned up" from "never attested".
import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import {
  writeStableLauncher,
  verifyMcpLauncherChain,
  MCP_LAUNCHER_BUNDLE_FILES,
  MCP_LAUNCHER_POLICY_FILES,
} from '../launcher.js';

const REPO_ROOT = resolve(__dirname, '..', '..', '..', '..');
const SOURCE_HELPERS = join(REPO_ROOT, '.claude', 'helpers');
const SOURCE_POLICY = join(REPO_ROOT, 'cli', 'src', 'permission-guard');

// A non-generated Codex session id: `isGeneratedMcpSessionId` rejects
// `mcp-<digits>-<alnum>`, and `sanitizeScopeId` leaves [A-Za-z0-9_-] untouched,
// so this value must survive into the record verbatim.
const CANARY_SESSION_ID = 'codex-a541-canary-session';

interface CapturedRecord {
  version: number;
  pidMode: string;
  ownerClientKind: string;
  ownerSessionId: string;
  sessionEnvKey: string;
  launcherPid: number;
  entrypointPath: string;
  entrypoint: string;
  projectRoot: string;
  tokenSha256: string;
  createdAt: string;
  expiresAt: string;
  epoch: number;
}

interface Capture {
  argv: string[];
  attestationPath: string | null;
  attestationToken: string | null;
  serverEntrypointEnv: string | null;
  ppid: number;
  record: CapturedRecord | null;
  recordReadError: string | null;
}

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'hf-a541-canary-'));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

/**
 * Build a complete real bundle so the launcher's own `require`s resolve exactly
 * as they do in production. The policy pair is copied FLAT beside the helpers,
 * mirroring both the relocated install and the published `hive-flow` package.
 */
function seedRealBundle(): string {
  const helperDir = join(root, 'bundle');
  mkdirSync(helperDir, { recursive: true });
  for (const file of MCP_LAUNCHER_BUNDLE_FILES) {
    const source = join(SOURCE_HELPERS, file);
    expect(existsSync(source), `missing source helper ${source}`).toBe(true);
    writeFileSync(join(helperDir, file), readFileSync(source));
  }
  for (const file of MCP_LAUNCHER_POLICY_FILES) {
    const source = join(SOURCE_POLICY, file);
    expect(existsSync(source), `missing policy file ${source}`).toBe(true);
    writeFileSync(join(helperDir, file), readFileSync(source));
  }
  return helperDir;
}

/**
 * A bounded stand-in for the MCP server. It reads its own attestation record
 * while still running, then records everything it observed and exits.
 */
function writeFakeServer(path: string, capturePath: string): void {
  writeFileSync(path, [
    "const fs = require('node:fs');",
    "const recordPath = process.env.HIVE_FLOW_MCP_ATTESTATION_PATH || null;",
    'let record = null;',
    'let recordReadError = null;',
    'if (recordPath) {',
    '  try {',
    "    record = JSON.parse(fs.readFileSync(recordPath, 'utf8'));",
    '  } catch (error) {',
    '    recordReadError = error instanceof Error ? error.message : String(error);',
    '  }',
    '}',
    `fs.writeFileSync(${JSON.stringify(capturePath)}, JSON.stringify({`,
    '  argv: process.argv.slice(2),',
    '  attestationPath: recordPath,',
    '  attestationToken: process.env.HIVE_FLOW_MCP_ATTESTATION_TOKEN || null,',
    '  serverEntrypointEnv: process.env.HIVE_FLOW_MCP_SERVER_ENTRYPOINT || null,',
    '  ppid: process.ppid,',
    '  record,',
    '  recordReadError,',
    '}));',
  ].join('\n'));
}

/**
 * A deterministic operator environment built from an explicit allowlist rather
 * than `...process.env`. The suite runs under Claude Code, whose ambient
 * `CLAUDECODE`/`CLAUDE_PROJECT_DIR` would classify the operator as `claude` and
 * make the owner assertions depend on who happened to run the tests.
 */
function deterministicEnv(): NodeJS.ProcessEnv {
  return {
    PATH: process.env.PATH ?? '',
    HOME: process.env.HOME ?? '',
    // Pins the attestation directory into the temp tree instead of the repo.
    HIVE_FLOW_PROJECT_ROOT: root,
    CODEX_SESSION_ID: CANARY_SESSION_ID,
  };
}

function deterministicDevinEnv(): NodeJS.ProcessEnv {
  return {
    PATH: process.env.PATH ?? '',
    HOME: process.env.HOME ?? '',
    HIVE_FLOW_PROJECT_ROOT: root,
    CHISEL_SESSION_DB: join(root, 'devin', 'sessions.db'),
    TERM_SESSION_ID: 'devin-a541-canary-session',
  };
}

describe.skipIf(process.platform === 'win32')('a541 launcher chain canary (POSIX)', () => {
  it('runs the generated wrapper through the real attesting launcher and attests the child', async () => {
    const helperDir = seedRealBundle();
    const attesting = join(helperDir, MCP_LAUNCHER_BUNDLE_FILES[0]);

    const capturePath = join(root, 'child-env.json');
    const fakeServer = join(root, 'fake-mcp-server.js');
    writeFakeServer(fakeServer, capturePath);

    // Generated for the host platform, so the generator's regular-file checks
    // apply to both explicit entrypoints.
    const wrapper = join(root, 'hive-flow-mcp-server');
    await writeStableLauncher(wrapper, fakeServer, attesting);
    chmodSync(wrapper, 0o755);

    // Arbitrary MCP argv, including shell metacharacters, must survive intact
    // and unexpanded.
    const argv = ['--transport', 'stdio', 'weird arg; echo pwned', '$(id)', '`id`'];
    const result = spawnSync(wrapper, argv, {
      encoding: 'utf8',
      timeout: 30_000,
      cwd: root,
      env: deterministicEnv(),
    });

    expect(result.error, `wrapper failed to start: ${result.error?.message}`).toBeUndefined();
    expect(existsSync(capturePath), `child never ran; stderr: ${result.stderr}`).toBe(true);

    const captured = JSON.parse(readFileSync(capturePath, 'utf8')) as Capture;

    // 1. The chain reached the entrypoint, and argv passed through without any
    //    shell interpretation.
    expect(captured.argv).toEqual(argv);

    // 2. The wrapper exported the exact entrypoint it verified, and the launcher
    //    honored it instead of re-deriving a path from its layout resolver.
    expect(captured.serverEntrypointEnv).toBe(fakeServer);

    // 3. The child received BOTH attestation variables. This is the property the
    //    a541 bypass destroyed — the direct-exec wrapper produced a child with
    //    neither, which read as a permissions fault downstream.
    expect(captured.attestationPath, 'child received no HIVE_FLOW_MCP_ATTESTATION_PATH').toBeTruthy();
    expect(captured.attestationToken, 'child received no HIVE_FLOW_MCP_ATTESTATION_TOKEN').toBeTruthy();

    // 4. Validate the RECORD, not merely the variables' presence.
    expect(captured.recordReadError).toBeNull();
    const record = captured.record;
    expect(record, 'attestation record was not readable while the child was alive').not.toBeNull();
    if (!record) return;

    // The record binds the LAUNCHER's pid (pidMode 'spawned-child'), which is
    // exactly the child's parent. A record naming any other process would attest
    // nothing about this chain.
    expect(record.pidMode).toBe('spawned-child');
    expect(record.launcherPid).toBe(captured.ppid);

    // The attested path is the realpath of the entrypoint that actually ran.
    expect(record.entrypointPath).toBe(realpathSync.native(fakeServer));
    expect(record.entrypoint).toBe('bin/mcp-server.js');
    expect(record.projectRoot).toBe(realpathSync.native(root));

    // The record stores only a digest; the plaintext token lives solely in the
    // child's environment. Matching them proves this record belongs to THIS
    // child rather than to some earlier or concurrent minting.
    expect(record).not.toHaveProperty('token');
    expect(record.tokenSha256).toBe(
      createHash('sha256').update(captured.attestationToken as string).digest('hex'),
    );

    // Operator identity resolved from the deterministic env, not a generated id.
    expect(record.ownerClientKind).toBe('codex');
    expect(record.ownerSessionId).toBe(CANARY_SESSION_ID);
    expect(record.sessionEnvKey).toBe('CODEX_SESSION_ID');

    // Version, epoch, and a bounded validity window.
    expect(record.version).toBe(1);
    expect(Number.isInteger(record.epoch) && record.epoch >= 1).toBe(true);
    const createdAt = Date.parse(record.createdAt);
    const expiresAt = Date.parse(record.expiresAt);
    expect(Number.isFinite(createdAt)).toBe(true);
    expect(expiresAt).toBeGreaterThan(createdAt);
    expect(expiresAt - createdAt).toBeLessThanOrEqual(24 * 60 * 60 * 1000);

    // 5. Cleanup: the launcher removes the record when the child exits, so a
    //    stale record can never be replayed by a later unattested process.
    expect(
      existsSync(captured.attestationPath as string),
      'attestation record survived wrapper exit',
    ).toBe(false);
  });

  it('attests a Devin-launched MCP connection from Chisel and terminal-session evidence', async () => {
    const helperDir = seedRealBundle();
    const capturePath = join(root, 'devin-child-env.json');
    const fakeServer = join(root, 'fake-devin-mcp-server.js');
    writeFakeServer(fakeServer, capturePath);

    const wrapper = join(root, 'hive-flow-mcp-server');
    await writeStableLauncher(
      wrapper,
      fakeServer,
      join(helperDir, MCP_LAUNCHER_BUNDLE_FILES[0]),
    );
    chmodSync(wrapper, 0o755);

    const result = spawnSync(wrapper, [], {
      encoding: 'utf8',
      timeout: 30_000,
      cwd: root,
      env: deterministicDevinEnv(),
    });

    expect(result.error, `wrapper failed to start: ${result.error?.message}`).toBeUndefined();
    expect(existsSync(capturePath), `child never ran; stderr: ${result.stderr}`).toBe(true);

    const captured = JSON.parse(readFileSync(capturePath, 'utf8')) as Capture;
    expect(captured.recordReadError).toBeNull();
    expect(captured.record).toMatchObject({
      ownerClientKind: 'devin',
      ownerSessionId: 'devin-a541-canary-session',
      sessionEnvKey: 'TERM_SESSION_ID',
      pidMode: 'spawned-child',
      launcherPid: captured.ppid,
    });
    expect(captured.attestationPath).toBeTruthy();
    expect(captured.attestationToken).toBeTruthy();
    expect(existsSync(captured.attestationPath as string)).toBe(false);
  });

  // -------------------------------------------------------------------------
  // verifyMcpLauncherChain — what `setup --verify --features mcp` now runs.
  //
  // Adapter verification reports `Connected` for an unattested chain, so these
  // cases exist to prove the new check actually separates the two.
  // -------------------------------------------------------------------------

  it('chain verification accepts a correctly generated wrapper', async () => {
    const helperDir = seedRealBundle();
    const fakeServer = join(root, 'fake-mcp-server.js');
    writeFakeServer(fakeServer, join(root, 'unused-capture.json'));

    const wrapper = join(root, 'hive-flow-mcp-server');
    await writeStableLauncher(wrapper, fakeServer, join(helperDir, MCP_LAUNCHER_BUNDLE_FILES[0]));
    chmodSync(wrapper, 0o755);

    const verdict = await verifyMcpLauncherChain(wrapper);
    expect(verdict.ok, verdict.output).toBe(true);
    // The probe supplies its own identity, so a real minted record is the only
    // acceptable pass — "no operator session here" is not an excuse.
    expect(verdict.output).toMatch(/attests the MCP child/);
  });

  it('chain verification rejects a decoy attesting line above a real bypass', async () => {
    // The dangerous shape: a genuine attesting launcher is named in a branch
    // that never executes, so a line-matching check would extract it, run it
    // successfully, and certify a chain the wrapper never uses.
    const helperDir = seedRealBundle();
    const attesting = join(helperDir, MCP_LAUNCHER_BUNDLE_FILES[0]);
    const sentinel = join(root, 'decoy-bypass-was-executed');
    const fakeServer = join(root, 'fake-mcp-server.js');
    writeFileSync(fakeServer, `require('node:fs').writeFileSync(${JSON.stringify(sentinel)}, 'ran');\n`);

    const wrapper = join(root, 'hive-flow-mcp-server');
    // The decoy sits in a never-called function body, so it is a FULL-LINE
    // match that a first-match line search would happily extract and then
    // execute — certifying a launcher this wrapper never reaches.
    writeFileSync(wrapper, [
      '#!/usr/bin/env bash',
      "# AUTO-GENERATED by 'hive-flow setup'. Do not edit by hand.",
      '# Regenerate with: hive-flow setup reconcile',
      `export HIVE_FLOW_MCP_SERVER_ENTRYPOINT='${fakeServer}'`,
      'unused_decoy() {',
      `exec node '${attesting}' "$@"`,
      '}',
      `exec node '${fakeServer}' "$@"`,
      '',
    ].join('\n'));
    chmodSync(wrapper, 0o755);

    const verdict = await verifyMcpLauncherChain(wrapper);
    expect(verdict.ok).toBe(false);
    expect(verdict.output).toMatch(/does not route through an attesting launcher/i);
    expect(existsSync(sentinel), 'verification executed the bypass wrapper').toBe(false);
  });

  it('chain verification rejects a Windows decoy that invokes the server directly', async () => {
    // Same attack in batch form: it carries the expected HIVE_FLOW_MCP_LAUNCHER
    // line but never invokes it. Parsed with platform: 'win32' so the grammar is
    // exercised from a POSIX host, which is where these wrappers get generated.
    const wrapper = join(root, 'hive-flow-mcp-server.cmd');
    writeFileSync(wrapper, [
      '@echo off',
      "rem AUTO-GENERATED by 'hive-flow setup'. Do not edit by hand.",
      'rem Regenerate with: hive-flow setup reconcile',
      'setlocal DisableDelayedExpansion',
      'set "HIVE_FLOW_MCP_SERVER_ENTRYPOINT=C:\\srv\\mcp-server.js"',
      'set "HIVE_FLOW_MCP_LAUNCHER=C:\\helpers\\hive-flow-mcp-launcher.cjs"',
      'node "%HIVE_FLOW_MCP_SERVER_ENTRYPOINT%" %*',
      'exit /b %ERRORLEVEL%',
      '',
    ].join('\r\n'));

    const verdict = await verifyMcpLauncherChain(wrapper, { platform: 'win32' });
    expect(verdict.ok).toBe(false);
    expect(verdict.output).toMatch(/does not route through an attesting launcher/i);
  });

  it('chain verification rejects an extra appended line in an otherwise valid wrapper', async () => {
    const helperDir = seedRealBundle();
    const fakeServer = join(root, 'fake-mcp-server.js');
    writeFakeServer(fakeServer, join(root, 'unused-capture.json'));

    const wrapper = join(root, 'hive-flow-mcp-server');
    await writeStableLauncher(wrapper, fakeServer, join(helperDir, MCP_LAUNCHER_BUNDLE_FILES[0]));
    writeFileSync(wrapper, `${readFileSync(wrapper, 'utf8')}echo tampered\n`);
    chmodSync(wrapper, 0o755);

    const verdict = await verifyMcpLauncherChain(wrapper);
    expect(verdict.ok).toBe(false);
    expect(verdict.output).toMatch(/does not route through an attesting launcher/i);
  });

  it('chain verification rejects the direct-exec bypass without executing it', async () => {
    // The pre-a541 wrapper. If verification ever EXECUTED it, the real MCP
    // server would start as a side effect of a read-only verify — so the
    // sentinel below must never be written.
    const sentinel = join(root, 'bypass-was-executed');
    const fakeServer = join(root, 'fake-mcp-server.js');
    writeFileSync(fakeServer, `require('node:fs').writeFileSync(${JSON.stringify(sentinel)}, 'ran');\n`);

    const wrapper = join(root, 'hive-flow-mcp-server');
    writeFileSync(wrapper, `#!/usr/bin/env bash\nexec node '${fakeServer}' "$@"\n`);
    chmodSync(wrapper, 0o755);

    const verdict = await verifyMcpLauncherChain(wrapper);
    expect(verdict.ok).toBe(false);
    expect(verdict.output).toMatch(/does not route through an attesting launcher/i);
    expect(existsSync(sentinel), 'verification executed the bypass wrapper').toBe(false);
  });

  it('chain verification rejects a wrapper that exports the entrypoint but still execs it', async () => {
    // The subtle bypass: it carries the a541 export line, so a check that only
    // looked for that marker would pass it, yet it still never reaches the
    // attesting launcher.
    const sentinel = join(root, 'exported-bypass-was-executed');
    const fakeServer = join(root, 'fake-mcp-server.js');
    writeFileSync(fakeServer, `require('node:fs').writeFileSync(${JSON.stringify(sentinel)}, 'ran');\n`);

    const wrapper = join(root, 'hive-flow-mcp-server');
    writeFileSync(
      wrapper,
      `#!/usr/bin/env bash\nexport HIVE_FLOW_MCP_SERVER_ENTRYPOINT='${fakeServer}'\nexec node '${fakeServer}' "$@"\n`,
    );
    chmodSync(wrapper, 0o755);

    const verdict = await verifyMcpLauncherChain(wrapper);
    expect(verdict.ok).toBe(false);
    expect(verdict.output).toMatch(/does not route through an attesting launcher/i);
    expect(existsSync(sentinel), 'verification executed the bypass wrapper').toBe(false);
  });

  /**
   * Overwrite the launcher inside an otherwise-complete real bundle. Models a
   * tampered or stale helper: the bundle passes the structural check, so only
   * record validation can catch it.
   */
  function forgeLauncher(helperDir: string, body: string): string {
    const forged = join(helperDir, MCP_LAUNCHER_BUNDLE_FILES[0]);
    writeFileSync(forged, body);
    return forged;
  }

  /** Generate a canonical wrapper pointing at whatever launcher is in `helperDir`. */
  async function wrapperFor(helperDir: string, server: string): Promise<string> {
    const wrapper = join(root, 'hive-flow-mcp-server');
    await writeStableLauncher(wrapper, server, join(helperDir, MCP_LAUNCHER_BUNDLE_FILES[0]));
    chmodSync(wrapper, 0o755);
    return wrapper;
  }

  it('chain verification rejects a helper that exports bogus attestation values', async () => {
    // Env presence is not attestation. This helper exports two well-formed but
    // meaningless values and spawns the child normally.
    const helperDir = seedRealBundle();
    const fakeServer = join(root, 'fake-mcp-server.js');
    writeFakeServer(fakeServer, join(root, 'unused-capture.json'));
    forgeLauncher(helperDir, [
      "const { spawn } = require('node:child_process');",
      'const entrypoint = process.env.HIVE_FLOW_MCP_SERVER_ENTRYPOINT;',
      "const env = { ...process.env, HIVE_FLOW_MCP_ATTESTATION_PATH: '/nonexistent/record.json', HIVE_FLOW_MCP_ATTESTATION_TOKEN: 'bogus-token' };",
      "const child = spawn(process.execPath, [entrypoint], { env, stdio: 'inherit' });",
      "child.on('exit', (code) => process.exit(code ?? 1));",
    ].join('\n'));

    const verdict = await verifyMcpLauncherChain(await wrapperFor(helperDir, fakeServer));
    expect(verdict.ok).toBe(false);
    expect(verdict.output).toMatch(/record is invalid|not readable/i);
  });

  it('chain verification rejects a helper whose record does not match the child token', async () => {
    // Mints a real record, then hands the child a DIFFERENT token — so the
    // record exists and looks well-formed but binds nothing.
    const helperDir = seedRealBundle();
    const fakeServer = join(root, 'fake-mcp-server.js');
    writeFakeServer(fakeServer, join(root, 'unused-capture.json'));
    forgeLauncher(helperDir, [
      "const { spawn } = require('node:child_process');",
      "const { mintMCPAttestation } = require('./mcp-attestation.cjs');",
      'const entrypoint = process.env.HIVE_FLOW_MCP_SERVER_ENTRYPOINT;',
      "const a = mintMCPAttestation({ entrypoint: 'bin/mcp-server.js', pidMode: 'spawned-child', launcherPid: process.pid, entrypointPath: entrypoint, env: process.env, cwd: process.cwd(), helperDir: __dirname });",
      "const env = { ...process.env, ...a.envPatch, HIVE_FLOW_MCP_ATTESTATION_TOKEN: 'substituted-token' };",
      "const child = spawn(process.execPath, [entrypoint], { env, stdio: 'inherit' });",
      "child.on('exit', (code) => { a.cleanup(); process.exit(code ?? 1); });",
    ].join('\n'));

    const verdict = await verifyMcpLauncherChain(await wrapperFor(helperDir, fakeServer));
    expect(verdict.ok).toBe(false);
    expect(verdict.output).toMatch(/tokenSha256/);
  });

  it('chain verification rejects a helper that never cleans up its record', async () => {
    // Everything is valid EXCEPT cleanup. A surviving record is replayable by a
    // later unattested process, so it must not pass.
    const helperDir = seedRealBundle();
    const fakeServer = join(root, 'fake-mcp-server.js');
    writeFakeServer(fakeServer, join(root, 'unused-capture.json'));
    forgeLauncher(helperDir, [
      "const { spawn } = require('node:child_process');",
      "const { mintMCPAttestation } = require('./mcp-attestation.cjs');",
      'const entrypoint = process.env.HIVE_FLOW_MCP_SERVER_ENTRYPOINT;',
      "const a = mintMCPAttestation({ entrypoint: 'bin/mcp-server.js', pidMode: 'spawned-child', launcherPid: process.pid, entrypointPath: entrypoint, env: process.env, cwd: process.cwd(), helperDir: __dirname });",
      "const child = spawn(process.execPath, [entrypoint], { env: { ...process.env, ...a.envPatch }, stdio: 'inherit' });",
      "child.on('exit', (code) => process.exit(code ?? 1));",   // cleanup deliberately omitted
    ].join('\n'));

    const verdict = await verifyMcpLauncherChain(await wrapperFor(helperDir, fakeServer));
    expect(verdict.ok).toBe(false);
    expect(verdict.output).toMatch(/survived launcher exit/i);
  });

  it('chain verification rejects a wrapper whose MCP server was deleted after setup', async () => {
    // The probe substitutes its own entrypoint, so without an explicit check the
    // installed server path would never be validated — verify would certify a
    // wrapper that cannot actually start anything.
    const helperDir = seedRealBundle();
    const fakeServer = join(root, 'fake-mcp-server.js');
    writeFakeServer(fakeServer, join(root, 'unused-capture.json'));
    const wrapper = await wrapperFor(helperDir, fakeServer);
    rmSync(fakeServer, { force: true });

    const verdict = await verifyMcpLauncherChain(wrapper);
    expect(verdict.ok).toBe(false);
    expect(verdict.output).toMatch(/missing or unreadable/i);
  });

  it('chain verification rejects a wrapper that is not executable', async () => {
    const helperDir = seedRealBundle();
    const fakeServer = join(root, 'fake-mcp-server.js');
    writeFakeServer(fakeServer, join(root, 'unused-capture.json'));
    const wrapper = await wrapperFor(helperDir, fakeServer);
    chmodSync(wrapper, 0o644);   // readable, so text checks pass; clients still cannot run it
    try {
      const verdict = await verifyMcpLauncherChain(wrapper);
      expect(verdict.ok).toBe(false);
      expect(verdict.output).toMatch(/not executable/i);
    } finally {
      chmodSync(wrapper, 0o755);
    }
  });

  it('chain verification rejects a wrapper whose bundle is incomplete', async () => {
    const helperDir = seedRealBundle();
    const fakeServer = join(root, 'fake-mcp-server.js');
    writeFakeServer(fakeServer, join(root, 'unused-capture.json'));

    const wrapper = join(root, 'hive-flow-mcp-server');
    await writeStableLauncher(wrapper, fakeServer, join(helperDir, MCP_LAUNCHER_BUNDLE_FILES[0]));
    // Break the bundle AFTER generation, modelling a partially-relocated install.
    rmSync(join(helperDir, 'client-kind.cjs'), { force: true });

    const verdict = await verifyMcpLauncherChain(wrapper);
    expect(verdict.ok).toBe(false);
    expect(verdict.output).toMatch(/bundle is incomplete/i);
  });

  it('chain verification reports a missing wrapper rather than throwing', async () => {
    const verdict = await verifyMcpLauncherChain(join(root, 'never-installed'));
    expect(verdict.ok).toBe(false);
    expect(verdict.output).toMatch(/not installed/i);
  });

  it('a wrapper that execs the server directly leaves the child unattested', () => {
    // The negative control that gives the assertions above their meaning: this
    // is exactly the pre-a541 generated wrapper, and it must NOT attest.
    const capturePath = join(root, 'direct-env.json');
    const fakeServer = join(root, 'fake-mcp-server.js');
    writeFakeServer(fakeServer, capturePath);

    const bypass = join(root, 'bypass-wrapper');
    writeFileSync(bypass, `#!/usr/bin/env bash\nexec node '${fakeServer}' "$@"\n`);
    chmodSync(bypass, 0o755);

    spawnSync(bypass, [], {
      encoding: 'utf8',
      timeout: 30_000,
      cwd: root,
      env: deterministicEnv(),
    });

    const captured = JSON.parse(readFileSync(capturePath, 'utf8')) as Capture;
    expect(captured.attestationPath).toBeNull();
    expect(captured.attestationToken).toBeNull();
    expect(captured.record).toBeNull();
  });
});
