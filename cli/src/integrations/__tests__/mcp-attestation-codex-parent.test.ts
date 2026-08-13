import { createRequire } from 'node:module';
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

const require = createRequire(import.meta.url);
const REPO_ROOT = resolve(__dirname, '..', '..', '..', '..');
const ATTESTATION = require(join(REPO_ROOT, '.claude', 'helpers', 'mcp-attestation.cjs')) as {
  mintRuntimeMCPAttestation(entrypointPath: string): {
    success: boolean;
    code?: string;
    record?: Record<string, unknown>;
    cleanup?: () => void;
  };
  parseCodesignDetails(raw: string): object;
  parseLsofRecords(raw: string): object[];
  unsafeResolveCodexParentIdentityForTests(options: object): {
    success: boolean;
    code?: string;
    identity?: {
      ownerClientKind: string;
      ownerSessionId: string;
      sessionEnvKey: string;
      ownerSessionProvenance: string;
    };
  };
  unsafeReadRolloutHeadForTests(file: string): string;
  unsafeTrustedDescriptorFileForTests(
    descriptor: object,
    currentUid: number,
    requireExecutable: boolean,
    allowRootOwner: boolean,
  ): object | null;
};

const {
  mintRuntimeMCPAttestation,
  parseCodesignDetails,
  parseLsofRecords,
  unsafeReadRolloutHeadForTests,
  unsafeResolveCodexParentIdentityForTests,
  unsafeTrustedDescriptorFileForTests,
} = ATTESTATION;

const roots: string[] = [];
const SESSION_ID = '019e1afb-e661-7642-8c38-10d862781906';
const GUARDIAN_ID = '019ff9d0-c21b-7062-ac58-645e897ef360';

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function makeRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'hf-5955-parent-'));
  roots.push(root);
  return root;
}

function writeRollout(
  sessionsRoot: string,
  projectRoot: string,
  id = SESSION_ID,
  overrides: Record<string, unknown> = {},
): string {
  const dir = join(sessionsRoot, '2026', '08', '13');
  mkdirSync(dir, { recursive: true });
  const file = join(dir, `rollout-2026-08-13T01-30-35-${id}.jsonl`);
  writeFileSync(file, `${JSON.stringify({
    timestamp: '2026-08-13T06:30:35.851Z',
    type: 'session_meta',
    payload: {
      id,
      timestamp: '2026-08-13T06:30:35.851Z',
      cwd: projectRoot,
      originator: 'codex-tui',
      thread_source: 'user',
      source: 'cli',
      model_provider: 'openai',
      ...overrides,
    },
  })}\n`);
  return file;
}

function lsofRecord(file: string, fd = '42'): object {
  const stat = statSync(file, { bigint: true });
  return {
    fd,
    access: 'u',
    type: 'REG',
    device: `0x${stat.dev.toString(16)}`,
    inode: String(stat.ino),
    name: realpathSync.native(file),
  };
}

function validOptions(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  const root = makeRoot();
  const projectRoot = join(root, 'project');
  const sessionsRoot = join(root, 'home', '.codex', 'sessions');
  mkdirSync(projectRoot, { recursive: true });
  const rollout = writeRollout(sessionsRoot, projectRoot);
  const codexExecutable = join(root, 'bin', 'codex');
  mkdirSync(dirname(codexExecutable), { recursive: true });
  writeFileSync(codexExecutable, 'signed-codex-fixture\n', { mode: 0o755 });
  const codexReal = realpathSync.native(codexExecutable);
  const processIdentity = { pid: 4242, uid: process.getuid?.() ?? 501, startedAt: 'Thu Aug 13 01:28:52 2026' };
  const rolloutDescriptors = [lsofRecord(rollout)];
  const executableDescriptors = [{ ...lsofRecord(codexExecutable, 'txt'), access: null }];
  const signatures = new Map([
    [codexReal, {
      valid: true,
      identifier: 'codex',
      teamIdentifier: '2DC432GLL2',
      authorities: ['Developer ID Application: OpenAI OpCo, LLC (2DC432GLL2)'],
    }],
    ['/usr/lib/dyld', { valid: false }],
  ]);
  const options: Record<string, unknown> = {
    platform: 'darwin',
    parentPid: 4242,
    currentUid: processIdentity.uid,
    projectRoot,
    sessionsRoot,
    parentBefore: processIdentity,
    signatures,
    executableDescriptors,
    rolloutDescriptors,
    ...overrides,
  };
  options.readParentAfter ??= () => ({ ...processIdentity });
  options.readSignaturesAfter ??= () => new Map(options.signatures as Map<string, object>);
  options.readDescriptorsAfter ??= () => [
    ...(options.executableDescriptors as object[]),
    ...(options.rolloutDescriptors as object[]),
  ];
  return options;
}

describe('5955 Codex parent attestation', () => {
  it('derives the exact root Codex thread from the signed parent and its open rollout', () => {
    const result = unsafeResolveCodexParentIdentityForTests(validOptions());
    expect(result.success, JSON.stringify(result)).toBe(true);
    expect(result).toMatchObject({
      success: true,
      identity: {
        ownerClientKind: 'codex',
        ownerSessionId: SESSION_ID,
        sessionEnvKey: 'CODEX_THREAD_ID',
        ownerSessionProvenance: 'codex-parent-rollout',
      },
    });
  });

  it('rejects a wrong signer, changed parent identity, and non-darwin fallback', () => {
    const wrongSigner = validOptions();
    const signedPath = ((wrongSigner.executableDescriptors as Array<{ name: string }>)[0]).name;
    wrongSigner.signatures = new Map([[signedPath, {
      valid: true,
      identifier: 'codex',
      teamIdentifier: 'ATTACKER',
      authorities: ['Developer ID Application: Example Corp (ATTACKER)'],
    }]]);
    expect(unsafeResolveCodexParentIdentityForTests(wrongSigner)).toMatchObject({
      success: false,
      code: 'codex-parent-signature-untrusted',
    });

    const changed = validOptions();
    changed.readParentAfter = () => ({ ...(changed.parentBefore as object), startedAt: 'Thu Aug 13 01:29:53 2026' });
    expect(unsafeResolveCodexParentIdentityForTests(changed)).toMatchObject({
      success: false,
      code: 'codex-parent-changed',
    });

    expect(unsafeResolveCodexParentIdentityForTests(validOptions({ platform: 'linux' }))).toMatchObject({
      success: false,
      code: 'codex-parent-platform-unsupported',
    });
  });

  it('rejects descriptor drift and executable mutation during verification', () => {
    const drift = validOptions();
    const after = (drift.readDescriptorsAfter as () => Array<Record<string, string>>)();
    drift.readDescriptorsAfter = () => after.map((record, index) => index === 0 ? { ...record, inode: '1' } : record);
    expect(unsafeResolveCodexParentIdentityForTests(drift)).toMatchObject({
      success: false,
      code: 'codex-parent-descriptors-changed',
    });

    const replaced = validOptions();
    const executable = ((replaced.executableDescriptors as Array<{ name: string }>)[0]).name;
    writeFileSync(executable, 'replacement\n', { mode: 0o755 });
    replaced.readSignaturesAfter = () => new Map([[executable, { valid: false }]]);
    expect(unsafeResolveCodexParentIdentityForTests(replaced)).toMatchObject({
      success: false,
      code: 'codex-parent-signature-changed',
    });
  });

  it('selects the root TUI thread and rejects subagent or ambiguous root sessions', () => {
    const options = validOptions();
    const sessionsRoot = options.sessionsRoot as string;
    const projectRoot = options.projectRoot as string;
    const guardian = writeRollout(sessionsRoot, projectRoot, GUARDIAN_ID, {
      session_id: SESSION_ID,
      parent_thread_id: SESSION_ID,
      thread_source: 'subagent',
      source: { subagent: { other: 'guardian' } },
    });
    options.rolloutDescriptors = [
      ...(options.rolloutDescriptors as object[]),
      lsofRecord(guardian, '39'),
    ];
    expect(unsafeResolveCodexParentIdentityForTests(options)).toMatchObject({
      success: true,
      identity: { ownerSessionId: SESSION_ID },
    });

    const secondRoot = writeRollout(
      sessionsRoot,
      projectRoot,
      '019ff9d0-c21b-7062-ac58-645e897ef361',
    );
    options.rolloutDescriptors = [
      ...(options.rolloutDescriptors as object[]),
      lsofRecord(secondRoot, '44'),
    ];
    expect(unsafeResolveCodexParentIdentityForTests(options)).toMatchObject({
      success: false,
      code: 'codex-parent-session-ambiguous',
    });
  });

  it('binds the descriptor inode and rejects replaced, symlinked, or cross-project rollouts', () => {
    const replaced = validOptions();
    const descriptor = { ...(replaced.rolloutDescriptors as object[])[0], inode: '1' };
    replaced.rolloutDescriptors = [descriptor];
    expect(unsafeResolveCodexParentIdentityForTests(replaced)).toMatchObject({
      success: false,
      code: 'codex-parent-rollout-untrusted',
    });

    const linked = validOptions();
    const original = ((linked.rolloutDescriptors as Array<{ name: string }>)[0]).name;
    const symlink = join(dirname(dirname(original)), '14', basename(original));
    mkdirSync(dirname(symlink), { recursive: true });
    symlinkSync(original, symlink);
    linked.rolloutDescriptors = [{ ...lsofRecord(original), name: symlink }];
    expect(unsafeResolveCodexParentIdentityForTests(linked)).toMatchObject({
      success: false,
      code: 'codex-parent-rollout-untrusted',
    });

    const crossProject = validOptions();
    const rollout = ((crossProject.rolloutDescriptors as Array<{ name: string }>)[0]).name;
    const line = JSON.parse(readFileSync(rollout, 'utf8')) as { payload: Record<string, unknown> };
    line.payload.cwd = join(dirname(crossProject.projectRoot as string), 'other-project');
    mkdirSync(line.payload.cwd as string, { recursive: true });
    writeFileSync(rollout, `${JSON.stringify(line)}\n`);
    crossProject.rolloutDescriptors = [lsofRecord(rollout)];
    expect(unsafeResolveCodexParentIdentityForTests(crossProject)).toMatchObject({
      success: false,
      code: 'codex-parent-session-missing',
    });
  });

  it('reads only the bounded session-metadata line from a large rollout', () => {
    const options = validOptions();
    const rollout = ((options.rolloutDescriptors as Array<{ name: string }>)[0]).name;
    const firstLine = readFileSync(rollout, 'utf8');
    writeFileSync(rollout, `${firstLine}${'x'.repeat(600 * 1024)}\n`);
    expect(unsafeReadRolloutHeadForTests(rollout)).toBe(firstLine);

    const noNewline = join(dirname(rollout), `rollout-2026-08-13T01-30-35-${GUARDIAN_ID}.jsonl`);
    writeFileSync(noNewline, 'x'.repeat(512 * 1024 + 1));
    expect(() => unsafeReadRolloutHeadForTests(noNewline)).toThrow(/metadata.*bound/i);
  });

  it('parses only closed lsof and codesign field grammars', () => {
    expect(parseLsofRecords([
      'p4242',
      'fcwd',
      'a ',
      'tDIR',
      'D0x1000010',
      'i5282137',
      `n${tmpdir()}`,
      'f7',
      'au',
      'tunix',
      'n->0x33885f89735f283c',
      'f33',
      'a ',
      'tNPOLICY',
      'n',
      'f42',
      'au',
      'tREG',
      'D0x1000010',
      'i70315734',
      `n${join(tmpdir(), 'rollout.jsonl')}`,
      '',
    ].join('\n'))).toEqual([{
      fd: 'cwd',
      access: null,
      type: 'DIR',
      device: '0x1000010',
      inode: '5282137',
      name: tmpdir(),
    }, {
      fd: '7',
      access: 'u',
      type: 'unix',
      name: '->0x33885f89735f283c',
    }, {
      fd: '33',
      access: null,
      type: 'NPOLICY',
      name: '',
    }, {
      fd: '42',
      access: 'u',
      type: 'REG',
      device: '0x1000010',
      inode: '70315734',
      name: join(tmpdir(), 'rollout.jsonl'),
    }]);
    expect(() => parseLsofRecords('f42\ntREG\nD0x1\ni1\nnbad\nEXTRA\n')).toThrow(/lsof/i);
    expect(() => parseLsofRecords('p4242\nf42\ntREG\ntREG\n')).toThrow(/duplicated/i);

    expect(parseCodesignDetails([
      'Executable=/Applications/Codex.app/Contents/MacOS/codex',
      'Identifier=codex',
      'Authority=Developer ID Application: OpenAI OpCo, LLC (2DC432GLL2)',
      'TeamIdentifier=2DC432GLL2',
      '',
    ].join('\n'))).toEqual({
      identifier: 'codex',
      teamIdentifier: '2DC432GLL2',
      authorities: ['Developer ID Application: OpenAI OpCo, LLC (2DC432GLL2)'],
    });
    expect(() => parseCodesignDetails('Identifier=codex\nIdentifier=other\nTeamIdentifier=2DC432GLL2\n')).toThrow(/codesign/i);
  });

  it('keeps the runtime mint closed to caller-supplied parent evidence', () => {
    expect(mintRuntimeMCPAttestation).toHaveLength(1);
    const attestationSource = readFileSync(join(REPO_ROOT, '.claude', 'helpers', 'mcp-attestation.cjs'), 'utf8');
    expect(attestationSource).toContain('function mintRuntimeMCPAttestation(entrypointPath)');
    expect(attestationSource).not.toMatch(/mintRuntimeMCPAttestation\s*\(\s*options/);
    const launcher = readFileSync(join(REPO_ROOT, '.claude', 'helpers', 'hive-flow-mcp-launcher.cjs'), 'utf8');
    expect(launcher).toContain('mintRuntimeMCPAttestation');
    expect(launcher).not.toMatch(/mintMCPAttestation\s*\(\s*\{/);
    expect(basename(((validOptions().executableDescriptors as Array<{ name: string }>)[0]).name)).toBe('codex');
  });

  it.skipIf(process.platform === 'win32')(
    'accepts a root-owned executable while keeping root-owned session data untrusted',
    () => {
      const executable = realpathSync.native('/bin/ls');
      const descriptor = { ...lsofRecord(executable, 'txt'), access: null };
      const nonRootUid = process.getuid?.() || 501;
      expect(statSync(executable).uid).toBe(0);
      expect(unsafeTrustedDescriptorFileForTests(
        descriptor,
        nonRootUid,
        true,
        true,
      )).not.toBeNull();
      expect(unsafeTrustedDescriptorFileForTests(
        descriptor,
        nonRootUid,
        false,
        false,
      )).toBeNull();
    },
  );

  it('preserves direct-environment clients through the runtime entry and records provenance', () => {
    const root = makeRoot();
    const helper = join(REPO_ROOT, '.claude', 'helpers', 'mcp-attestation.cjs');
    const entrypoint = join(root, 'cli', 'bin', 'mcp-server.js');
    mkdirSync(dirname(entrypoint), { recursive: true });
    writeFileSync(entrypoint, 'fixture\n');
    const result = runRuntimeMint(root, helper, entrypoint, {
      HIVE_FLOW_CLIENT_KIND: 'claude',
      CLAUDE_CODE_SESSION_ID: 'claude-direct-session',
      CLAUDE_PROJECT_DIR: root,
      CLAUDECODE: '1',
    });

    expect(result).toMatchObject({
      success: true,
      record: {
        ownerClientKind: 'claude',
        ownerSessionId: 'claude-direct-session',
        sessionEnvKey: 'CLAUDE_CODE_SESSION_ID',
        ownerSessionProvenance: 'environment',
        projectRoot: realpathSync.native(root),
      },
    });
  });

  it('fails closed through the runtime entry without operator env or a Codex parent', () => {
    const root = makeRoot();
    const helper = join(REPO_ROOT, '.claude', 'helpers', 'mcp-attestation.cjs');
    const entrypoint = join(root, 'cli', 'bin', 'mcp-server.js');
    mkdirSync(dirname(entrypoint), { recursive: true });
    writeFileSync(entrypoint, 'fixture\n');
    const result = runRuntimeMint(root, helper, entrypoint, {});

    expect(result).toMatchObject({ success: false, code: 'missing-operator' });
  });
});

function runRuntimeMint(
  root: string,
  helper: string,
  entrypoint: string,
  operatorEnv: Record<string, string>,
): Record<string, unknown> {
  chmodSync(root, 0o700);
  const script = [
    "const helper = require(process.argv[1]);",
    "const result = helper.mintRuntimeMCPAttestation(process.argv[2]);",
    "console.log(JSON.stringify({ success: result.success, code: result.code, record: result.record }));",
    "if (result.success) result.cleanup();",
  ].join('');
  const env = {
    HOME: root,
    PATH: process.env.PATH,
    ...operatorEnv,
  };
  const child = spawnSync(process.execPath, ['-e', script, helper, entrypoint], {
    cwd: root,
    env,
    encoding: 'utf8',
    timeout: 10_000,
  });
  expect(child.error).toBeUndefined();
  expect(child.signal).toBeNull();
  expect(child.status, child.stderr).toBe(0);
  return JSON.parse(child.stdout.trim()) as Record<string, unknown>;
}
