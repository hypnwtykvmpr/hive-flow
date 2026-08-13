// cli/src/integrations/launcher.ts
import { accessSync, constants, existsSync, realpathSync, statSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { mkdir, chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { atomicWrite } from './atomic-merge.js';
import { execFileNoThrow } from '../utils/execFileNoThrow.js';
import { basename, dirname, join, resolve } from 'node:path';
import { isAbsolute as posixIsAbsolute } from 'node:path/posix';
import { isAbsolute as winIsAbsolute } from 'node:path/win32';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { DEFAULT_MAX_AGENTS, DEFAULT_QUEUE_DEPTH } from '../shared/core/config/defaults.js';

/**
 * POSIX single-quote escaping for embedding a path into a bash single-quoted
 * literal. Refuses control characters as a defense-in-depth measure so that
 * NUL/CR/LF in attacker-supplied paths cannot break out of the literal or
 * inject newlines into the generated shim.
 *
 * Output is always wrapped in single quotes, and any embedded single quote
 * is encoded with the standard close/escape/reopen pattern (`'\''`).
 *
 * Shared by writeStableLauncher (MCP shim) and writeStableStatuslineLauncher
 * (statusline shim) so both launchers escape paths identically.
 */
function shellQuote(value: string): string {
  // DEL (U+007F) is rejected alongside the C0 range so the writer cannot
  // install a path that the attesting launcher refuses at runtime. A writer
  // that accepts more than the runtime does produces a wrapper which passes
  // setup and then fails at connect time.
  if (/[\x00-\x1f\x7f]/.test(value)) {
    throw new Error(`Path contains control characters: ${JSON.stringify(value)}`);
  }
  return "'" + value.replace(/'/g, "'\\''") + "'";
}

function windowsCommandQuote(value: string): string {
  if (/[\x00-\x1f"]/.test(value)) {
    throw new Error(`Path cannot be embedded in a Windows command: ${JSON.stringify(value)}`);
  }
  return `"${value}"`;
}

function windowsBatchSetValue(value: string, label: string): string {
  // DEL is rejected here too, so the Windows writer cannot install a path the
  // attesting launcher rejects at runtime.
  if (/[\x00-\x1f\x7f"]/.test(value)) {
    throw new Error(`${label} cannot be embedded in a Windows launcher: ${JSON.stringify(value)}`);
  }
  return value.replace(/%/g, '%%');
}

interface LauncherWriteOptions {
  platform?: NodeJS.Platform;
}

/**
 * Helpers that must sit ADJACENT to the launcher, because each is reached by a
 * relative `require('./x.cjs')` at load:
 *
 *   hive-flow-mcp-launcher -> layout-paths, mcp-attestation
 *   mcp-attestation        -> client-kind, layout-paths
 */
export const MCP_LAUNCHER_BUNDLE_FILES = [
  'hive-flow-mcp-launcher.cjs',
  'layout-paths.cjs',
  'mcp-attestation.cjs',
  'client-kind.cjs',
] as const;

/**
 * Protected-path policy loaded by `layout-paths.cjs` for project-root/session
 * sanitization.
 *
 * These are NOT adjacent in every layout, which is why they are tracked
 * separately rather than folded into the list above: the relocated install is
 * flat and carries them beside the helpers, while in a source checkout they live
 * under `cli/src/permission-guard/`. A single-directory check would therefore
 * wrongly reject a perfectly good source bundle.
 */
export const MCP_LAUNCHER_POLICY_FILES = [
  'protected-paths.cjs',
  'protected-paths.policy.json',
] as const;

/**
 * A bundle member must be a REGULAR file that is actually READABLE.
 *
 * `existsSync` alone would accept a directory named `mcp-attestation.cjs`, and
 * `isFile()` alone would accept a mode-000 file. Both cases select a bundle that
 * then fails at spawn time, when `require()` throws inside the launcher — far
 * harder to diagnose than a refusal at setup time. The `R_OK` check is what
 * makes the name honest: readability is asserted, not assumed.
 */
function isRegularFile(file: string): boolean {
  try {
    if (!statSync(file).isFile()) return false;
    accessSync(file, constants.R_OK);
    return true;
  } catch {
    return false;
  }
}

/**
 * A bundle is complete when every adjacent helper is a regular readable file AND
 * the protected-path policy is resolvable. Only TWO layouts ship, and each needs
 * a different policy location — requiring adjacency in both would reject a valid
 * source checkout:
 *
 *   1. FLAT (`.../helpers/protected-paths.cjs`) — the relocated install AND the
 *      published npm package. The published package is `hive-flow` (rooted at
 *      `cli/`); its `files` list ships `.claude/helpers/**`, which carries the
 *      policy pair flat beside the launcher.
 *   2. SOURCE CHECKOUT (`<repo>/cli/src/permission-guard/`) — the repo-root
 *      `.claude/helpers/` deliberately does NOT carry a flat policy copy, so the
 *      policy is reached relative to the package root.
 *
 * There is deliberately no `dist/src/permission-guard` branch: `cli/package.json`
 * `files` omits `src`, and the build's `extraFileCopies` never copies the policy
 * pair into `dist`, so that directory cannot exist in any shipped artifact. A
 * branch for it would be unreachable code that falsely implies coverage.
 */
function isCompleteLauncherBundle(dir: string): boolean {
  if (!MCP_LAUNCHER_BUNDLE_FILES.every((file) => isRegularFile(resolve(dir, file)))) return false;
  const flat = MCP_LAUNCHER_POLICY_FILES.every((file) => isRegularFile(resolve(dir, file)));
  if (flat) return true;
  // `<repo>/.claude/helpers` -> `<repo>/cli/src/permission-guard`
  const pkgRoot = resolve(dir, '..', '..');
  return MCP_LAUNCHER_POLICY_FILES.every(
    (file) => isRegularFile(resolve(pkgRoot, 'cli', 'src', 'permission-guard', file)),
  );
}

/**
 * Resolve the attesting MCP launcher, preferring the relocated user bundle.
 *
 * Returns null when no COMPLETE bundle exists. A partial bundle is never
 * selected: silently choosing a launcher whose `layout-paths.cjs` or
 * `mcp-attestation.cjs` is missing would regenerate a wrapper that appears
 * correct and then fails at connect time, which is harder to diagnose than a
 * refusal at setup time.
 *
 * `projectRoot` is the SETUP TARGET, not necessarily Hive Flow's package root,
 * so it cannot be the only source anchor: a globally installed CLI running setup
 * against an unrelated project would otherwise find nothing. The module-relative
 * and package-resolution candidates mirror `resolveMcpServerEntry()` so a clean
 * package installation can locate its own shipped `.claude/helpers` bundle
 * without the target project containing Hive Flow source.
 */
export function resolveMcpLauncherPath(
  homeDir: string,
  projectRoot: string,
): string | null {
  const candidates: string[] = [
    // 1. Relocated user bundle, written by both the main init path and the
    //    standalone enforcement installer.
    resolve(homeDir, '.hive-flow', 'enforcement', 'bin'),
    // 2. The setup target itself, for a source checkout.
    resolve(projectRoot, '.claude', 'helpers'),
  ];

  // 3. Module-relative: walk upward from this file looking for a shipped
  //    bundle. Handles dist/src/integrations/, dist/integrations/, and
  //    npm-linked global installs.
  const selfUrl = import.meta.url;
  if (selfUrl.startsWith('file://')) {
    let dir = resolve(fileURLToPath(selfUrl), '..');
    for (let i = 0; i < 6; i++) {
      candidates.push(resolve(dir, '.claude', 'helpers'));
      const parent = resolve(dir, '..');
      if (parent === dir) break;
      dir = parent;
    }
  }

  // 4. Package resolution, for a nested or global install.
  try {
    const req = createRequire(import.meta.url);
    for (const packageName of ['hive-flow', '@hive-flow/cli']) {
      try {
        const packageJsonPath = req.resolve(`${packageName}/package.json`);
        candidates.push(resolve(packageJsonPath, '..', '.claude', 'helpers'));
      } catch {
        // Try the next package identity.
      }
    }
  } catch {
    // createRequire unavailable: the earlier candidates still apply.
  }

  for (const dir of candidates) {
    if (isCompleteLauncherBundle(dir)) return resolve(dir, MCP_LAUNCHER_BUNDLE_FILES[0]);
  }
  return null;
}

/**
 * Render the canonical wrapper text.
 *
 * SINGLE SOURCE OF TRUTH: both the writer and `verifyMcpLauncherChain` use this,
 * so verification can assert byte equality against a regenerated wrapper instead
 * of pattern-matching individual lines. Line-matching is not sound here — a
 * tampered wrapper can carry a decoy `exec node '<valid-launcher>'` inside a
 * dead branch and still exec the server on the next line.
 */
function renderMcpWrapper(
  mcpServerEntrypoint: string,
  attestingLauncherPath: string,
  platform: NodeJS.Platform,
): string {
  if (platform === 'win32') {
    // Both paths travel in environment variables and are invoked through them,
    // so a path containing `&`, `|`, `(`, `)`, `^`, `!`, or `%NAME%` cannot be
    // reparsed by cmd as command syntax. `DisableDelayedExpansion` additionally
    // stops `!` from expanding inside the quoted set.
    const entrypoint = windowsBatchSetValue(mcpServerEntrypoint, 'MCP server path');
    const launcher = windowsBatchSetValue(attestingLauncherPath, 'Attesting launcher path');
    return `@echo off\r
rem AUTO-GENERATED by 'hive-flow setup'. Do not edit by hand.\r
rem Regenerate with: hive-flow setup reconcile\r
setlocal DisableDelayedExpansion\r
set "HIVE_FLOW_MCP_SERVER_ENTRYPOINT=${entrypoint}"\r
set "HIVE_FLOW_MCP_LAUNCHER=${launcher}"\r
node "%HIVE_FLOW_MCP_LAUNCHER%" %*\r
exit /b %ERRORLEVEL%\r
`;
  }
  // Single-quoted bash: only single-quote needs escaping (close, escape, reopen).
  // The exact server entrypoint is exported so the launcher can prefer it over
  // its layout resolver, which keeps the resolved path identical to the one
  // setup verified rather than re-derived in a different process context.
  const quotedServer = shellQuote(mcpServerEntrypoint);
  const quotedLauncher = shellQuote(attestingLauncherPath);
  return `#!/usr/bin/env bash
# AUTO-GENERATED by 'hive-flow setup'. Do not edit by hand.
# Regenerate with: hive-flow setup reconcile
export HIVE_FLOW_MCP_SERVER_ENTRYPOINT=${quotedServer}
exec node ${quotedLauncher} "$@"
`;
}

/**
 * Write the wrapper that Claude Code (and every other MCP client) invokes.
 *
 * CONTRACT: the generated shim EXPORTS the verified MCP server path and EXECS
 * the ATTESTING LAUNCHER. It must never exec the MCP server itself. The launcher
 * alone mints operator attestation and only then spawns the server, so a shim
 * that runs the server directly produces an unattested connection whose
 * owner-sensitive tools fail closed — the a541 defect.
 *
 * Retained design notes:
 *  - Node-built single-quote escaping (not printf %q) so paths containing spaces
 *    OR quotes are safe.
 *  - A bash shim rather than an ES-module `import` shim under
 *    `#!/usr/bin/env node`: the latter throws `Cannot use import statement
 *    outside a module` without `"type": "module"` in the nearest package.json.
 *    The bash shim avoids that class of failure without package.json gymnastics.
 *  - Paths carrying control characters (C0 or DEL) are refused, matching the
 *    attesting launcher's own runtime guard so the writer can never install a
 *    path the launcher will later reject.
 */
export async function writeStableLauncher(
  path: string,
  mcpServerEntrypoint: string,
  attestingLauncherPath: string,
  options: LauncherWriteOptions = {},
): Promise<void> {
  if (/[\x00-\x1f\x7f]/.test(mcpServerEntrypoint)) {
    throw new Error(`MCP server path contains control characters: ${JSON.stringify(mcpServerEntrypoint)}`);
  }
  if (/[\x00-\x1f\x7f]/.test(attestingLauncherPath)) {
    throw new Error(`Attesting launcher path contains control characters: ${JSON.stringify(attestingLauncherPath)}`);
  }
  // The wrapper must never exec the MCP server directly. Doing so bypasses the
  // attesting launcher, so the server receives no operator attestation and
  // correctly refuses owner-sensitive tools — which presents as a permissions
  // fault rather than as the install defect it actually is.
  const platform = options.platform ?? process.platform;
  // Absoluteness must be judged by the TARGET platform's rules, not the host's.
  // A win32 wrapper is routinely generated from a POSIX host (CI and these
  // tests do exactly that), and `C:\...` is not absolute under POSIX rules — so
  // using the host's `isAbsolute` would reject valid Windows paths.
  const absoluteFor = platform === 'win32' ? winIsAbsolute : posixIsAbsolute;
  if (!absoluteFor(attestingLauncherPath)) {
    throw new Error(`Attesting launcher path must be absolute: ${JSON.stringify(attestingLauncherPath)}`);
  }
  if (!absoluteFor(mcpServerEntrypoint)) {
    throw new Error(`MCP server path must be absolute: ${JSON.stringify(mcpServerEntrypoint)}`);
  }
  // SHAPE VALIDATION RUNS BEFORE FILESYSTEM VALIDATION.
  //
  // Rendering is pure and performs every encoder check (quote rejection, percent
  // doubling, control characters). Doing it first makes error precedence
  // HOST-INDEPENDENT. Previously a malformed path reported the encoder error on
  // a POSIX host generating a win32 wrapper, but the filesystem error on a host
  // whose platform matched the target — so the same call reported different
  // failures on macOS and on windows-latest, and a suite green locally was red
  // in CI. It is also better behavior on its own terms: refuse malformed input
  // before touching the filesystem.
  const shim = renderMcpWrapper(mcpServerEntrypoint, attestingLauncherPath, platform);

  // Both explicit entrypoints must be real regular files, so setup cannot
  // generate a wrapper pointing at a directory or a path that does not exist —
  // failures that would otherwise surface only at connect time.
  //
  // Only verifiable when generating for the HOST platform. A win32 wrapper is
  // legitimately generated from a POSIX host, where `C:\...` cannot be stat'd;
  // asserting existence there would reject correct cross-platform output. This
  // is a genuine coverage limit of cross-generation, not an oversight — and it
  // is why tests targeting win32 must supply fixtures that are valid on the
  // TARGET platform, or they pass on POSIX and fail on a Windows runner.
  if (platform === process.platform) {
    if (!isRegularFile(attestingLauncherPath)) {
      throw new Error(`Attesting launcher is not a readable file: ${JSON.stringify(attestingLauncherPath)}`);
    }
    if (!isRegularFile(mcpServerEntrypoint)) {
      throw new Error(`MCP server entrypoint is not a readable file: ${JSON.stringify(mcpServerEntrypoint)}`);
    }
  }
  await mkdir(dirname(path), { recursive: true });
  // Content stays idempotent: identical text is never rewritten.
  let current: string | null = null;
  try { current = await readFile(path, 'utf8'); } catch {}
  if (current !== shim) await atomicWrite(path, shim);
  // Mode is repaired UNCONDITIONALLY on POSIX, even when the text already
  // matches. `verifyMcpLauncherChain` rejects a wrapper without X_OK and tells
  // the operator to run `setup reconcile`; returning early on matching content
  // would skip this chmod, so that instruction could never be satisfied and the
  // wrapper would stay permanently unusable.
  if (platform !== 'win32') await chmod(path, 0o755);
}

/**
 * Recover the attesting launcher path embedded in an installed wrapper.
 *
 * Returns null when the wrapper does not route through a launcher at all —
 * which is exactly the pre-a541 bypass (`exec node '<server>'`).
 */
function unquotePosix(token: string): string | null {
  if (!token.startsWith("'") || !token.endsWith("'")) return null;
  // Reverse shellQuote's close/escape/reopen encoding of a literal quote.
  return token.slice(1, -1).split("'\\''").join("'");
}

/** Deterministic synthetic operator identity used only by the chain probe. */
const CHAIN_PROBE_CLIENT_KIND = 'codex';
const CHAIN_PROBE_SESSION_ID = 'hive-flow-chain-probe';

/**
 * Recover `(server, launcher)` from a wrapper, accepting ONLY the exact
 * canonical generated text.
 *
 * Line-level pattern matching is unsound: a tampered wrapper can carry a decoy
 * line naming a genuine attesting launcher inside a branch that never runs, and
 * then exec the MCP server directly on the next line. Because verification
 * executes the launcher it extracts — not the wrapper — such a decoy would
 * "prove" a chain the wrapper never actually uses.
 *
 * The closed grammar is therefore: decode the two path tokens from their
 * canonical positions, then require that re-encoding them reproduces the file
 * BYTE FOR BYTE. Extra, missing, reordered, or edited lines all fail, and the
 * path round-trip is inherent — a token that does not re-encode identically
 * cannot regenerate matching text.
 */
function parseGeneratedWrapper(
  wrapper: string,
  platform: NodeJS.Platform,
): { server: string; launcher: string } | null {
  let server: string | null = null;
  let launcher: string | null = null;

  if (platform === 'win32') {
    const lines = wrapper.split('\r\n');
    if (lines.length !== 9 || lines[8] !== '') return null;
    const entry = /^set "HIVE_FLOW_MCP_SERVER_ENTRYPOINT=(.*)"$/.exec(lines[4]);
    const launch = /^set "HIVE_FLOW_MCP_LAUNCHER=(.*)"$/.exec(lines[5]);
    if (!entry || !launch) return null;
    // `windowsBatchSetValue` doubles `%` so a literal `%NAME%` survives; undo it.
    server = entry[1].replace(/%%/g, '%');
    launcher = launch[1].replace(/%%/g, '%');
  } else {
    const lines = wrapper.split('\n');
    if (lines.length !== 6 || lines[5] !== '') return null;
    const prefix = 'export HIVE_FLOW_MCP_SERVER_ENTRYPOINT=';
    if (!lines[3].startsWith(prefix)) return null;
    const execMatch = /^exec node (.+) "\$@"$/.exec(lines[4]);
    if (!execMatch) return null;
    server = unquotePosix(lines[3].slice(prefix.length));
    launcher = unquotePosix(execMatch[1]);
  }
  if (!server || !launcher) return null;

  let expected: string;
  try {
    expected = renderMcpWrapper(server, launcher, platform);
  } catch {
    return null;   // paths the canonical encoder would refuse outright
  }
  return expected === wrapper ? { server, launcher } : null;
}

/**
 * Environment for the chain probe.
 *
 * Built from an ALLOWLIST rather than `...process.env`: the ambient environment
 * carries the operator's own Claude/Codex markers, which would decide the record
 * owner and make the verdict depend on who happened to run verify. Supplying a
 * synthetic identity also means minting must succeed, so "no operator session"
 * is never an excuse for a weaker pass.
 */
function chainProbeEnv(probeRoot: string, probePath: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    HIVE_FLOW_MCP_SERVER_ENTRYPOINT: probePath,
    HIVE_FLOW_PROJECT_ROOT: probeRoot,
    HIVE_FLOW_CLIENT_KIND: CHAIN_PROBE_CLIENT_KIND,
    CODEX_SESSION_ID: CHAIN_PROBE_SESSION_ID,
  };
  // Only what a child process needs in order to run at all.
  for (const key of ['PATH', 'Path', 'HOME', 'SystemRoot', 'ComSpec', 'TEMP', 'TMP', 'USERPROFILE']) {
    const value = process.env[key];
    if (value !== undefined) env[key] = value;
  }
  return env;
}

/** Validate a minted record against the child that actually received it. */
function chainRecordProblems(
  record: Record<string, unknown> | null,
  token: string | null,
  childPpid: number,
  probePath: string,
  probeRoot: string,
): string[] {
  if (!record) return ['attestation record was not readable while the child was alive'];
  if (!token) return ['child received no attestation token'];
  const problems: string[] = [];
  const expectHash = createHash('sha256').update(token).digest('hex');

  if (record.tokenSha256 !== expectHash) problems.push('tokenSha256 does not match the child token');
  if ('token' in record) problems.push('record contains plaintext token material');
  if (record.pidMode !== 'spawned-child') problems.push(`unexpected pidMode ${String(record.pidMode)}`);
  if (record.launcherPid !== childPpid) problems.push('launcherPid does not bind the spawning launcher');
  if (record.entrypointPath !== realpathSync.native(probePath)) problems.push('entrypointPath is not the probe entrypoint');
  if (record.entrypoint !== 'bin/mcp-server.js') problems.push(`unexpected entrypoint ${String(record.entrypoint)}`);
  if (record.version !== 1) problems.push(`unexpected attestation version ${String(record.version)}`);
  if (record.ownerClientKind !== CHAIN_PROBE_CLIENT_KIND) problems.push(`unexpected ownerClientKind ${String(record.ownerClientKind)}`);
  if (record.ownerSessionId !== CHAIN_PROBE_SESSION_ID) problems.push(`unexpected ownerSessionId ${String(record.ownerSessionId)}`);
  // The real attestation reader checks these too, so certifying a record it
  // would reject would make a green verify meaningless.
  if (record.sessionEnvKey !== 'CODEX_SESSION_ID') problems.push(`unexpected sessionEnvKey ${String(record.sessionEnvKey)}`);
  if (record.projectRoot !== realpathSync.native(probeRoot)) problems.push('projectRoot does not match the probe root');
  if (!Number.isInteger(record.epoch) || (record.epoch as number) < 1) problems.push(`invalid epoch ${String(record.epoch)}`);

  const createdAt = Date.parse(String(record.createdAt));
  const expiresAt = Date.parse(String(record.expiresAt));
  if (!Number.isFinite(createdAt) || !Number.isFinite(expiresAt)) problems.push('created/expires timestamps are not valid');
  else if (expiresAt <= createdAt) problems.push('attestation expires before it was created');
  else if (expiresAt - createdAt > 24 * 60 * 60 * 1000) problems.push('attestation lifetime exceeds the 24h maximum');

  return problems;
}

/**
 * Functionally verify that the installed MCP wrapper attests.
 *
 * Config verification alone cannot prove this. `claude mcp get hive-flow`
 * reports `Connected` whether or not attestation was minted, because the
 * launcher deliberately still starts the server when minting fails (it only
 * warns on stderr). So a broken chain reads as healthy — the precise gap that
 * let the a541 bypass sit undetected behind a green `--verify`.
 *
 * Two bounded stages, in this order for a reason:
 *
 *   1. STRUCTURAL — is the wrapper EXACTLY the generated attesting shim? This
 *      runs FIRST so a bypass wrapper is caught without ever being executed;
 *      running one would start the real MCP server as a side effect of a
 *      read-only verify. The check must be a closed grammar rather than a line
 *      search — see {@link parseGeneratedWrapper}.
 *   2. FUNCTIONAL — execute that launcher against a bounded probe entrypoint
 *      and validate the attestation RECORD the probe actually received. Env
 *      presence alone is not proof: a stale or forged helper can export two
 *      bogus values. The probe runs under a throwaway project root, so the
 *      epoch counter and attestation records of the real project are never
 *      mutated by a verify.
 *
 * The probe supplies its own deterministic synthetic identity, so a missing
 * ambient operator session is never a reason to accept a weaker result.
 */
export async function verifyMcpLauncherChain(
  launcherPath: string,
  options: { platform?: NodeJS.Platform; timeoutMs?: number } = {},
): Promise<{ ok: boolean; output: string }> {
  const platform = options.platform ?? process.platform;
  let wrapper: string;
  try {
    wrapper = await readFile(launcherPath, 'utf8');
  } catch {
    return { ok: false, output: `MCP launcher is not installed at ${launcherPath}.` };
  }

  const parsed = parseGeneratedWrapper(wrapper, platform);
  if (!parsed) {
    return {
      ok: false,
      output:
        `Installed wrapper does not route through an attesting launcher (${launcherPath}). `
        + 'It is not the exact generated shim, so the MCP server may start UNATTESTED and '
        + 'owner-sensitive tools fail closed. Regenerate with: hive-flow setup reconcile',
    };
  }
  // A canonical-looking wrapper can still name a relative path, or one whose
  // target was deleted after setup. The probe replaces the SERVER path, so
  // without this the installed server would never be validated at all.
  const absoluteFor = platform === 'win32' ? winIsAbsolute : posixIsAbsolute;
  for (const [label, value] of [['MCP server', parsed.server], ['Attesting launcher', parsed.launcher]] as const) {
    if (!absoluteFor(value)) {
      return { ok: false, output: `${label} path in the installed wrapper is not absolute: ${value}` };
    }
  }
  // Clients execute the wrapper; a readable-but-not-executable shim verifies
  // clean while every real connection fails.
  if (platform !== 'win32' && platform === process.platform) {
    try {
      accessSync(launcherPath, constants.X_OK);
    } catch {
      return { ok: false, output: `Installed wrapper is not executable: ${launcherPath}` };
    }
  }
  if (platform === process.platform && !isRegularFile(parsed.server)) {
    return { ok: false, output: `MCP server entrypoint in the installed wrapper is missing or unreadable: ${parsed.server}` };
  }

  const attesting = parsed.launcher;
  if (!isRegularFile(attesting)) {
    return { ok: false, output: `Attesting launcher is missing or unreadable: ${attesting}` };
  }
  if (!isCompleteLauncherBundle(dirname(attesting))) {
    return {
      ok: false,
      output:
        `Attesting launcher bundle is incomplete at ${dirname(attesting)}; `
        + `required: ${MCP_LAUNCHER_BUNDLE_FILES.join(', ')} plus the protected-path policy.`,
    };
  }
  // Cross-platform generation is legitimate, but a win32 launcher cannot be
  // executed from POSIX. Report the structural result honestly rather than
  // claiming a functional proof that never ran.
  if (platform !== process.platform) {
    return {
      ok: true,
      output: `Launcher chain is structurally intact (${attesting}); not executed for ${platform}.`,
    };
  }

  const probeRoot = await mkdtemp(join(tmpdir(), 'hive-flow-chain-'));
  try {
    const probePath = join(probeRoot, 'probe.js');
    const capturePath = join(probeRoot, 'capture.json');
    // The probe reads its own record WHILE ALIVE: the launcher deletes the
    // record when the child exits, so a post-hoc read could not tell "attested
    // then cleaned up" from "never attested at all".
    await writeFile(probePath, [
      "const fs = require('node:fs');",
      "const recordPath = process.env.HIVE_FLOW_MCP_ATTESTATION_PATH || null;",
      'let record = null;',
      "if (recordPath) { try { record = JSON.parse(fs.readFileSync(recordPath, 'utf8')); } catch {} }",
      `fs.writeFileSync(${JSON.stringify(capturePath)}, JSON.stringify({`,
      '  path: recordPath,',
      '  token: process.env.HIVE_FLOW_MCP_ATTESTATION_TOKEN || null,',
      '  ppid: process.ppid,',
      '  record,',
      '}));',
    ].join('\n'));

    const result = await execFileNoThrow(process.execPath, [attesting], {
      timeout: options.timeoutMs ?? 20_000,
      cwd: probeRoot,
      env: chainProbeEnv(probeRoot, probePath),
    });

    let captured: {
      path: string | null;
      token: string | null;
      ppid: number;
      record: Record<string, unknown> | null;
    } | null = null;
    try { captured = JSON.parse(await readFile(capturePath, 'utf8')); } catch { /* probe never ran */ }
    if (!captured) {
      return {
        ok: false,
        output: `Launcher did not reach the MCP entrypoint. ${result.stderr.trim().slice(0, 400)}`,
      };
    }
    if (result.code !== 0) {
      return { ok: false, output: `Launcher exited ${String(result.code)}. ${result.stderr.trim().slice(0, 400)}` };
    }
    if (!captured.path) {
      return { ok: false, output: `Launcher reached the entrypoint but delivered no attestation (${attesting}).` };
    }

    // Env presence is not attestation: a stale or forged helper can export two
    // bogus values. The record must actually bind this child.
    const problems = chainRecordProblems(captured.record, captured.token, captured.ppid, probePath, probeRoot);
    if (problems.length > 0) {
      return { ok: false, output: `Attestation record is invalid (${attesting}): ${problems.join('; ')}` };
    }
    if (existsSync(captured.path)) {
      return { ok: false, output: `Attestation record survived launcher exit (${captured.path}).` };
    }
    return { ok: true, output: `Launcher chain attests the MCP child (${attesting}).` };
  } finally {
    await rm(probeRoot, { recursive: true, force: true });
  }
}

export function resolveLauncherPath(
  scope: 'user' | 'project',
  homeDir: string,
  projectRoot: string,
  platform: NodeJS.Platform = process.platform,
): string {
  const filename = platform === 'win32' ? 'hive-flow-mcp-server.cmd' : 'hive-flow-mcp-server';
  if (scope === 'user') return resolve(homeDir, '.hive-flow', 'bin', filename);
  return resolve(projectRoot, '.hive-flow', 'bin', filename);
}

export function hiveFlowMcpEnv(): Record<string, string> {
  return {
    HIVE_FLOW_MODE: 'v3',
    HIVE_FLOW_HOOKS_ENABLED: 'true',
    HIVE_FLOW_TOPOLOGY: 'hierarchical-mesh',
    HIVE_FLOW_MAX_AGENTS: String(DEFAULT_MAX_AGENTS),           // max working (actively executing) agents
    HIVE_FLOW_AGENT_QUEUE_DEPTH: String(DEFAULT_QUEUE_DEPTH),    // max queued; hard cap = MAX + QUEUE_DEPTH
    HIVE_FLOW_AGENT_QUEUE_REJECT_ABOVE: 'true',                  // when working+queued reaches cap, reject busy:queue-full
    HIVE_FLOW_MEMORY_BACKEND: 'hybrid',
  };
}

/**
 * Resolve the runtime path to `bin/statusline.js` inside the installed package
 * or promoted `cli/` workspace.
 *
 * Two-strategy resolution:
 *   1. Monorepo/source layout: `<projectRoot>/cli/bin/statusline.js`.
 *      Used during local development and inside the hive-flow worktree.
 *   2. Installed package layout: walk up from this file's directory (compiled
 *      output lives in `dist/integrations/`, source in `src/integrations/`) up
 *      to 8 levels looking for a sibling `bin/statusline.js`. Handles both the
 *      shipped npm package and any nested `node_modules/@hive-flow/cli` install.
 *
 * Throws if neither path resolves so the caller surfaces a clear setup error
 * rather than silently writing a launcher that points at a missing file.
 */
export function resolveStatuslineRuntimeEntrypoint(projectRoot: string): string {
  // Strategy 1: promoted monorepo/source checkout.
  const monorepoPath = resolve(projectRoot, 'cli', 'bin', 'statusline.js');
  if (existsSync(monorepoPath)) return monorepoPath;

  // Strategy 2: walk up from this module's directory looking for bin/statusline.js.
  // import.meta.url points at the compiled file in dist/integrations/launcher.js
  // (or src/integrations/launcher.ts during ts-node/tsx runs), so the package
  // root is typically 2 levels up; allow up to 8 to be resilient against
  // bundler-introduced nesting.
  let current = dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 8; i++) {
    const candidate = resolve(current, 'bin', 'statusline.js');
    if (existsSync(candidate)) return candidate;
    const parent = dirname(current);
    if (parent === current) break; // hit filesystem root
    current = parent;
  }

  throw new Error('Cannot resolve @hive-flow/cli/bin/statusline.js for statusline launcher.');
}

/**
 * Resolve the on-disk path for the statusline launcher shim. Mirrors
 * `resolveLauncherPath` but for the statusline binary — kept as a separate
 * function because the filename is hardcoded inside `resolveLauncherPath`
 * (it returns `hive-flow-mcp-server`), and we never want a future refactor
 * of the MCP path to silently move the statusline launcher.
 */
export function resolveStatuslineLauncherPath(
  scope: 'user' | 'project',
  homeDir: string,
  projectRoot: string,
  platform: NodeJS.Platform = process.platform,
): string {
  const filename = platform === 'win32' ? 'claude-code-statusline.cmd' : 'claude-code-statusline';
  if (scope === 'user') return resolve(homeDir, '.hive-flow', 'bin', filename);
  return resolve(projectRoot, '.hive-flow', 'bin', filename);
}

// REGRESSION FENCE: this launcher MUST exec bin/statusline.js. If it execs
// bin/cli.js, the heavy CLI parser, hive-flow statusline, or npx, statusline
// latency regresses substantially and Claude Code repaints will feel sluggish.
export async function writeStableStatuslineLauncher(
  path: string,
  statuslineEntrypoint: string,
  options: { previousCommand?: string; platform?: NodeJS.Platform } = {},
): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const platform = options.platform ?? process.platform;
  if (platform === 'win32') {
    await writeWindowsStatuslineLauncher(path, statuslineEntrypoint, options.previousCommand ?? '');
    return;
  }
  const quoted = shellQuote(statuslineEntrypoint);
  const previousCommand = options.previousCommand ?? '';
  const quotedPreviousCommand = shellQuote(previousCommand);
  const shim = `#!/usr/bin/env bash
# AUTO-GENERATED by 'hive-flow setup'. Do not edit by hand.
# Regenerate with: hive-flow setup --auto --features statusline
set -u
HIVE_FLOW_STATUSLINE_STDIN="$(cat || true)"
HIVE_FLOW_STATUSLINE_OUTPUT="$(printf '%s' "$HIVE_FLOW_STATUSLINE_STDIN" | node ${quoted} "$@" 2>/dev/null || true)"
HIVE_FLOW_PREVIOUS_STATUSLINE_COMMAND=${quotedPreviousCommand}
HIVE_FLOW_PREVIOUS_STATUSLINE_OUTPUT=""
# DO-NOT-REVERT: previous statusLine is captured for uninstall restore only.
# Chaining it by default leaks the user's old shell prompt under the Hive Flow
# board in every non-repo global install. Set this env var only for diagnostics.
if [ "\${HIVE_FLOW_STATUSLINE_CHAIN_PREVIOUS:-0}" = "1" ] && [ -n "$HIVE_FLOW_PREVIOUS_STATUSLINE_COMMAND" ]; then
  HIVE_FLOW_PREVIOUS_STATUSLINE_OUTPUT="$(printf '%s' "$HIVE_FLOW_STATUSLINE_STDIN" | HIVE_FLOW_STATUSLINE_CHAINED=1 bash -lc "$HIVE_FLOW_PREVIOUS_STATUSLINE_COMMAND" 2>/dev/null || true)"
fi
if [ -n "$HIVE_FLOW_STATUSLINE_OUTPUT" ]; then
  printf '%s\\n' "$HIVE_FLOW_STATUSLINE_OUTPUT"
fi
if [ -n "$HIVE_FLOW_PREVIOUS_STATUSLINE_OUTPUT" ]; then
  printf '%s\\n' "$HIVE_FLOW_PREVIOUS_STATUSLINE_OUTPUT"
fi
`;
  // Only rewrite if changed (idempotent)
  let current: string | null = null;
  try { current = await readFile(path, 'utf8'); } catch {}
  if (current === shim) return;
  await atomicWrite(path, shim);
  await chmod(path, 0o755); // belt-and-suspenders
}

async function writeWindowsStatuslineLauncher(
  path: string,
  statuslineEntrypoint: string,
  previousCommand: string,
): Promise<void> {
  if (/[\x00-\x1f"]/.test(statuslineEntrypoint)) {
    throw new Error(`Statusline path cannot be embedded in a Windows launcher: ${JSON.stringify(statuslineEntrypoint)}`);
  }
  if (/[\x00-\x08\x0b\x0c\x0e-\x1f]/.test(previousCommand)) {
    throw new Error(`Previous statusLine command contains unsupported control characters: ${JSON.stringify(previousCommand)}`);
  }
  const companionPath = `${path}.cjs`;
  const companionName = basename(companionPath);
  const shim = `@echo off\r
rem AUTO-GENERATED by 'hive-flow setup'. Do not edit by hand.\r
rem Regenerate with: hive-flow setup --auto --features statusline\r
setlocal\r
node "%~dp0${companionName}" %*\r
exit /b 0\r
`;
  const companion = `// AUTO-GENERATED by 'hive-flow setup'. Do not edit by hand.
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');

const STATUSLINE_ENTRYPOINT = ${JSON.stringify(statuslineEntrypoint)};
const PREVIOUS_STATUSLINE_COMMAND = ${JSON.stringify(previousCommand)};

function readStdin() {
  try {
    return fs.readFileSync(0, 'utf8');
  } catch {
    return '';
  }
}

function emit(value) {
  if (!value) return;
  process.stdout.write(value);
  if (!value.endsWith('\\n')) process.stdout.write('\\n');
}

const stdin = readStdin();
const args = [STATUSLINE_ENTRYPOINT, ...process.argv.slice(2)];
const rendered = spawnSync(process.execPath, args, {
  input: stdin,
  encoding: 'utf8',
  windowsHide: true,
});
if (!rendered.error && rendered.stdout) emit(rendered.stdout);

// DO-NOT-REVERT: previous statusLine is retained for uninstall restore only.
// Chaining it by default leaks host prompt output under the Hive Flow board.
if (PREVIOUS_STATUSLINE_COMMAND && process.env.HIVE_FLOW_STATUSLINE_CHAIN_PREVIOUS === '1') {
  const chained = spawnSync(PREVIOUS_STATUSLINE_COMMAND, {
    input: stdin,
    encoding: 'utf8',
    shell: true,
    windowsHide: true,
    env: { ...process.env, HIVE_FLOW_STATUSLINE_CHAINED: '1' },
  });
  if (!chained.error && chained.stdout) emit(chained.stdout);
}
`;
  let currentShim: string | null = null;
  let currentCompanion: string | null = null;
  try { currentShim = await readFile(path, 'utf8'); } catch {}
  try { currentCompanion = await readFile(companionPath, 'utf8'); } catch {}
  if (currentShim !== shim) await atomicWrite(path, shim);
  if (currentCompanion !== companion) await atomicWrite(companionPath, companion);
}

/**
 * Format a launcher path for embedding into Claude Code's `settings.json`
 * `statusLine.command` (or similar string-valued command fields). Returns a
 * shell-safe single-quoted literal so paths containing spaces, apostrophes,
 * or shell metacharacters survive intact when Claude Code spawns the shim.
 */
export function commandForClaudeSettings(
  launcherPath: string,
  platform: NodeJS.Platform = process.platform,
): string {
  return platform === 'win32' ? windowsCommandQuote(launcherPath) : shellQuote(launcherPath);
}

// ---------------------------------------------------------------------------
// Claude activity-tracker hook launcher (hive-flow-f16a)
// ---------------------------------------------------------------------------

/**
 * Resolve the runtime path to `bin/claude-activity-hook.js`. Mirrors
 * {@link resolveStatuslineRuntimeEntrypoint}'s two-strategy resolution so the
 * hook shim works in both the monorepo checkout and the installed package.
 */
export function resolveActivityHookRuntimeEntrypoint(projectRoot: string): string {
  const monorepoPath = resolve(projectRoot, 'cli', 'bin', 'claude-activity-hook.js');
  if (existsSync(monorepoPath)) return monorepoPath;

  let current = dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 8; i++) {
    const candidate = resolve(current, 'bin', 'claude-activity-hook.js');
    if (existsSync(candidate)) return candidate;
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }

  throw new Error('Cannot resolve @hive-flow/cli/bin/claude-activity-hook.js for the activity hook launcher.');
}

/** On-disk path for the activity-hook shim (kept separate from the statusline shim). */
export function resolveActivityHookLauncherPath(
  scope: 'user' | 'project',
  homeDir: string,
  projectRoot: string,
  platform: NodeJS.Platform = process.platform,
): string {
  const filename = platform === 'win32' ? 'claude-activity-hook.cmd' : 'claude-activity-hook';
  if (scope === 'user') return resolve(homeDir, '.hive-flow', 'bin', filename);
  return resolve(projectRoot, '.hive-flow', 'bin', filename);
}

/**
 * Write the activity-hook shim.
 *
 * FAIL-OPEN FENCE: this shim must ALWAYS exit 0 and must never write to stdout.
 * It runs on every Claude Code hook event; a non-zero exit or stray output can
 * block or corrupt a turn. Tracker failures are absorbed silently — a lost
 * activity record only means the statusline omits activity.
 *
 * REGRESSION FENCE: exec `bin/claude-activity-hook.js`, never `bin/cli.js`.
 * Routing hook events through the heavy CLI parser would add startup cost to
 * every tool call.
 */
export async function writeStableActivityHookLauncher(
  path: string,
  hookEntrypoint: string,
  options: { platform?: NodeJS.Platform } = {},
): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const platform = options.platform ?? process.platform;
  if (platform === 'win32') {
    // Reject control characters and quotes, AND double `%` so a legal path
    // containing `%NAME%` is emitted literally instead of being environment-
    // expanded when the batch file runs. Same contract as the other generated
    // Windows launchers.
    const safeEntrypoint = windowsBatchSetValue(hookEntrypoint, 'Hook path');
    const cmd = [
      '@echo off',
      'REM AUTO-GENERATED by \'hive-flow setup\'. Do not edit by hand.',
      'REM Regenerate with: hive-flow setup --auto --features statusline',
      // MUST precede any use of the entrypoint. Without it, a legal path
      // containing `!` is rewritten when the invoking command processor has
      // delayed expansion enabled (cmd /v:on, or the registry default).
      // `%` doubling above handles percent expansion; this handles bang.
      'setlocal DisableDelayedExpansion',
      `node "${safeEntrypoint}" %* >NUL 2>NUL`,
      'exit /b 0',
      '',
    ].join('\r\n');
    let currentCmd: string | null = null;
    try { currentCmd = await readFile(path, 'utf8'); } catch { /* absent */ }
    if (currentCmd === cmd) return;
    await atomicWrite(path, cmd);
    return;
  }

  const quoted = shellQuote(hookEntrypoint);
  const shim = `#!/usr/bin/env bash
# AUTO-GENERATED by 'hive-flow setup'. Do not edit by hand.
# Regenerate with: hive-flow setup --auto --features statusline
# FAIL-OPEN: always exit 0, never emit stdout. A tracker hook must never block
# or corrupt a Claude Code turn.
set -u
node ${quoted} "$@" >/dev/null 2>&1 || true
exit 0
`;
  let current: string | null = null;
  try { current = await readFile(path, 'utf8'); } catch { /* absent */ }
  if (current === shim) return;
  await atomicWrite(path, shim);
  await chmod(path, 0o755);
}
