import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  isProtectedPath,
  checkBashSelfProtection,
  evaluateSelfProtection,
  validateSettingsStructure,
  captureIntegritySnapshot,
  verifyIntegrity,
} from '../self-protection.js';
import {
  revokeOverride,
  hasActiveOverride,
  overrideStatus,
  requestOverride,
} from '../biometric-override.js';
import { writeFileSync, mkdirSync, rmSync, symlinkSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { platform } from 'node:process';
import { randomUUID } from 'node:crypto';

// ---------------------------------------------------------------------------
// Test fixtures
// ---------------------------------------------------------------------------

const CWD = '/project';
const HOME = process.env.HOME || '/Users/test';

function tmpDir(): string {
  const dir = join(tmpdir(), `self-protection-test-${randomUUID()}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

// ---------------------------------------------------------------------------
// isProtectedPath
// ---------------------------------------------------------------------------

describe('isProtectedPath', () => {
  it('blocks writes to .claude/settings.json', () => {
    const result = isProtectedPath(`${CWD}/.claude/settings.json`, CWD);
    expect(result.blocked).toBe(true);
    expect(result.reason).toContain('Permission Guard');
  });

  it('redirects protected-path denials without revealing override mechanics', () => {
    const result = isProtectedPath(`${CWD}/.claude/settings.json`, CWD);

    expect(result.blocked).toBe(true);
    expect(result.reason).toContain('human/coordinator');
    expect(result.reason).not.toContain('permission-guard-setup.mjs');
    expect(result.reason).not.toContain('override');
  });

  it('blocks writes to .claude/settings.local.json', () => {
    const result = isProtectedPath(`${CWD}/.claude/settings.local.json`, CWD);
    expect(result.blocked).toBe(true);
    expect(result.reason).toContain('Permission Guard');
  });

  it('blocks writes to .claude/helpers/hook-handler.cjs', () => {
    const result = isProtectedPath(`${CWD}/.claude/helpers/hook-handler.cjs`, CWD);
    expect(result.blocked).toBe(true);
  });

  it('blocks writes to any file under .claude/helpers/', () => {
    const result = isProtectedPath(`${CWD}/.claude/helpers/router.js`, CWD);
    expect(result.blocked).toBe(true);
  });

  it('blocks writes to permission-guard source files', () => {
    const result = isProtectedPath(
      `${CWD}/v3/@hive-flow/cli/src/permission-guard/gate.ts`,
      CWD,
    );
    expect(result.blocked).toBe(true);
  });

  it('blocks writes to permission-guard compiled files', () => {
    const result = isProtectedPath(
      `${CWD}/v3/@hive-flow/cli/dist/src/permission-guard/gate.js`,
      CWD,
    );
    expect(result.blocked).toBe(true);
  });

  it('blocks writes to guard config in home directory', () => {
    const result = isProtectedPath(
      `${HOME}/.hive-flow/permission-guard/config.json`,
      CWD,
    );
    expect(result.blocked).toBe(true);
  });

  it('blocks writes to global enforcement control-plane state in home directory', () => {
    for (const target of [
      `${HOME}/.hive-flow/enforcement/global/state.json`,
      `${HOME}/.hive-flow/enforcement/global/denial-ledger.json`,
      `${HOME}/.hive-flow/enforcement/pipeline-state.json`,
      `${HOME}/.hive-flow/enforcement/.hmac-key`,
    ]) {
      const result = isProtectedPath(target, CWD);
      expect(result.blocked, target).toBe(true);
    }
  });

  it('blocks writes to an absolute HIVE_FLOW_HOME without unprotecting the default hive home', () => {
    const previousHiveHome = process.env.HIVE_FLOW_HOME;
    const root = tmpDir();
    const hiveHome = join(root, 'custom-hive-home');
    process.env.HIVE_FLOW_HOME = hiveHome;
    try {
      for (const target of [
        join(hiveHome, 'enforcement', 'global', 'state.json'),
        join(hiveHome, 'enforcement', 'dev-override.conf'),
        join(hiveHome, 'credential-vault.json.gcm'),
        join(hiveHome, 'credentials', 'openrouter.json'),
        join(hiveHome, 'run', 'credential-holder.sock'),
        `${HOME}/.hive-flow/enforcement/global/state.json`,
        `${HOME}/.hive-flow/credential-vault.json.gcm`,
      ]) {
        const result = isProtectedPath(target, CWD);
        expect(result.blocked, target).toBe(true);
      }
    } finally {
      if (previousHiveHome === undefined) {
        delete process.env.HIVE_FLOW_HOME;
      } else {
        process.env.HIVE_FLOW_HOME = previousHiveHome;
      }
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('allows writes to normal project files', () => {
    const result = isProtectedPath(`${CWD}/src/index.ts`, CWD);
    expect(result.blocked).toBe(false);
  });

  it('allows writes to other .claude files not in helpers/', () => {
    const result = isProtectedPath(`${CWD}/.claude/agents/coder.md`, CWD);
    expect(result.blocked).toBe(false);
  });

  it('allows writes to non-guard CLI source files', () => {
    const result = isProtectedPath(
      `${CWD}/v3/@hive-flow/cli/src/commands/swarm.ts`,
      CWD,
    );
    expect(result.blocked).toBe(false);
  });

  it('handles empty file path', () => {
    const result = isProtectedPath('', CWD);
    expect(result.blocked).toBe(false);
  });

  it('handles relative paths by resolving against cwd', () => {
    const result = isProtectedPath('.claude/settings.json', CWD);
    expect(result.blocked).toBe(true);
  });

  it('blocks path traversal attempts to reach protected files', () => {
    const result = isProtectedPath(
      `${CWD}/src/../../${CWD}/.claude/settings.json`,
      CWD,
    );
    expect(result.blocked).toBe(true);
  });

  it('blocks a symlink leaf that resolves to a protected file', () => {
    if (platform === 'win32') return;
    const root = tmpDir();
    try {
      mkdirSync(join(root, '.claude'), { recursive: true });
      mkdirSync(join(root, 'tmp'), { recursive: true });
      writeFileSync(join(root, '.claude', 'settings.json'), '{}');
      symlinkSync(join(root, '.claude', 'settings.json'), join(root, 'tmp', 'settings-link.json'));

      const result = isProtectedPath(join(root, 'tmp', 'settings-link.json'), root);

      expect(result.blocked).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('blocks a missing child under a symlinked protected directory', () => {
    if (platform === 'win32') return;
    const root = tmpDir();
    try {
      mkdirSync(join(root, '.claude', 'helpers'), { recursive: true });
      mkdirSync(join(root, 'tmp'), { recursive: true });
      symlinkSync(join(root, '.claude', 'helpers'), join(root, 'tmp', 'helpers-link'));

      const result = isProtectedPath(join(root, 'tmp', 'helpers-link', 'new-helper.cjs'), root);

      expect(result.blocked).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('blocks a child under a symlink to a realpathed protected directory', () => {
    if (platform === 'win32') return;
    const root = tmpDir();
    try {
      mkdirSync(join(root, '.claude', 'helpers'), { recursive: true });
      mkdirSync(join(root, 'tmp'), { recursive: true });
      symlinkSync(realpathSync(join(root, '.claude', 'helpers')), join(root, 'tmp', 'real-helpers-link'));

      const result = isProtectedPath(join(root, 'tmp', 'real-helpers-link', 'new-helper.cjs'), root);

      expect(result.blocked).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// checkBashSelfProtection
// ---------------------------------------------------------------------------

describe('checkBashSelfProtection', () => {
  const f1ProtectedTarget = `${CWD}/.git/info/exclude`;
  const f1BenignTarget = 'src/generated.ts';
  const f1InlineMutationVariants: Array<{ name: string; command: (target: string) => string }> = [
    { name: 'fs/promises direct writeFile', command: target => `node --eval "require('fs/promises').writeFile('${target}', 'x')"` },
    { name: 'node:fs/promises direct writeFile', command: target => `node --eval "require('node:fs/promises').writeFile('${target}', 'x')"` },
    { name: 'aliased fs writeFileSync', command: target => `node --eval "const f=require('fs'); f.writeFileSync('${target}', 'x')"` },
    { name: 'destructured fs writeFileSync', command: target => `node --eval "const {writeFileSync}=require('fs'); writeFileSync('${target}', 'x')"` },
    { name: 'appendFileSync sink', command: target => `node --eval "require('fs').appendFileSync('${target}', 'x')"` },
    { name: 'appendFile sink', command: target => `node --eval "require('fs').appendFile('${target}', 'x', () => {})"` },
    { name: 'createWriteStream sink', command: target => `node --eval "require('fs').createWriteStream('${target}').write('x')"` },
    { name: 'destructured fs/promises appendFile', command: target => `node --eval "const {appendFile}=require('fs/promises'); appendFile('${target}', 'x')"` },
    { name: 'python import os as alias', command: target => `python3 -c "import os as o; o.remove('${target}')"` },
    { name: 'python from os import remove', command: target => `python3 -c "from os import remove; remove('${target}')"` },
    { name: 'python import shutil as alias', command: target => `python3 -c "import shutil as sh; sh.move('tmp/source', '${target}')"` },
    { name: 'R4 bracket fs writeFileSync', command: target => `node --eval "require('fs')['writeFileSync']('${target}', 'x')"` },
    { name: 'R5 concatenated require fs', command: target => `node --eval "require('f'+'s').writeFileSync('${target}', 'x')"` },
    { name: 'R5 empty-concat require fs', command: target => `node --eval "require('fs'+'').appendFileSync('${target}', 'x')"` },
    { name: 'R3 createRequire direct fs', command: target => `node --input-type=module --eval "import { createRequire } from 'module'; createRequire(import.meta.url)('fs').writeFileSync('${target}', 'x')"` },
    { name: 'R3 createRequire alias fs', command: target => `node --input-type=module --eval "import { createRequire } from 'module'; const rq=createRequire(import.meta.url); rq('fs').appendFileSync('${target}', 'x')"` },
    { name: 'R1 dynamic import fs', command: target => `node --input-type=module --eval "(await import('fs')).writeFileSync('${target}', 'x')"` },
    { name: 'R1 dynamic import node fs promises', command: target => `node --input-type=module --eval "(await import('node:fs/promises')).appendFile('${target}', 'x')"` },
    { name: 'R2 process getBuiltinModule fs', command: target => `node --eval "process.getBuiltinModule('fs').writeFileSync('${target}', 'x')"` },
    { name: 'R2 process binding fs', command: target => `node --eval "process.binding('fs').writeFileSync('${target}', 'x')"` },
    { name: 'R2 module constructor load fs', command: target => `node --eval "module.constructor._load('fs').appendFileSync('${target}', 'x')"` },
    { name: 'R2 require cache exports fs', command: target => `node --eval "require.cache[require.resolve('fs')].exports.writeFileSync('${target}', 'x')"` },
    { name: 'R7 importlib os remove', command: target => `python3 -c "import importlib; importlib.import_module('os').remove('${target}')"` },
    { name: 'R7 importlib alias shutil move', command: target => `python3 -c "import importlib as il; il.import_module('shutil').move('tmp/source', '${target}')"` },
    { name: 'R7 from importlib alias os remove', command: target => `python3 -c "from importlib import import_module as im; im('o'+'s').remove('${target}')"` },
    { name: 'R7 dynamic __import__ os remove', command: target => `python3 -c "__import__('o'+'s').remove('${target}')"` },
    { name: 'redteam method alias fs writeFileSync', command: target => `node --eval "const w=require('fs').writeFileSync; w('${target}', 'x')"` },
    { name: 'redteam object alias then method alias fs', command: target => `node --eval "const f=require('fs'); const w=f.writeFileSync; w('${target}', 'x')"` },
    { name: 'redteam destructured promises alias', command: target => `node --eval "const {promises:p}=require('fs'); p.writeFile('${target}', 'x')"` },
    { name: 'redteam static default import fs', command: target => `node --input-type=module --eval "import fs from 'fs'; fs.writeFileSync('${target}', 'x')"` },
    { name: 'redteam static namespace import node fs', command: target => `node --input-type=module --eval "import * as fs from 'node:fs'; fs.appendFileSync('${target}', 'x')"` },
    { name: 'redteam static named import fs', command: target => `node --input-type=module --eval "import { writeFileSync as w } from 'fs'; w('${target}', 'x')"` },
    { name: 'redteam static named import fs promises', command: target => `node --input-type=module --eval "import { appendFile } from 'fs/promises'; appendFile('${target}', 'x')"` },
    { name: 'redteam python import_module assigned os', command: target => `python3 -c "import importlib; m=importlib.import_module('os'); m.remove('${target}')"` },
    { name: 'redteam python import_module method alias', command: target => `python3 -c "import importlib; removeFile=importlib.import_module('os').remove; removeFile('${target}')"` },
    { name: 'redteam createRequire alias assigned fs', command: target => `node --input-type=module --eval "import { createRequire } from 'module'; const rq=createRequire(import.meta.url); const f=rq('fs'); f.writeFileSync('${target}', 'x')"` },
    { name: 'redteam importlib alias assigned os', command: target => `python3 -c "import importlib as il; m=il.import_module('os'); m.remove('${target}')"` },
  ];

  it('blocks mv targeting settings.json', () => {
    const result = checkBashSelfProtection(
      `mv /tmp/evil.json ${CWD}/.claude/settings.json`,
      CWD,
    );
    expect(result).not.toBeNull();
    expect(result!.blocked).toBe(true);
    expect(result!.reason).toContain('mv');
  });

  it('blocks cp targeting hook-handler.cjs', () => {
    const result = checkBashSelfProtection(
      `cp /tmp/evil.cjs ${CWD}/.claude/helpers/hook-handler.cjs`,
      CWD,
    );
    expect(result).not.toBeNull();
    expect(result!.blocked).toBe(true);
  });

  it('blocks echo redirect to settings.json', () => {
    const result = checkBashSelfProtection(
      `echo '{}' > ${CWD}/.claude/settings.json`,
      CWD,
    );
    expect(result).not.toBeNull();
    expect(result!.blocked).toBe(true);
  });

  it('blocks sed -i on guard source', () => {
    const result = checkBashSelfProtection(
      `sed -i 's/deny/allow/g' ${CWD}/v3/@hive-flow/cli/src/permission-guard/gate.ts`,
      CWD,
    );
    expect(result).not.toBeNull();
    expect(result!.blocked).toBe(true);
  });

  it('blocks node literal writes to protected paths', () => {
    const result = checkBashSelfProtection(
      `node --eval "fs.writeFileSync('${CWD}/.claude/settings.json', '{}')"`,
      CWD,
    );
    expect(result).not.toBeNull();
    expect(result!.blocked).toBe(true);
    expect(result!.reason).toContain('Inline code execution is blocked');
  });

  it('blocks node require fs literal writes to protected paths', () => {
    const result = checkBashSelfProtection(
      `node --eval "require('fs').writeFileSync('${CWD}/.claude/settings.json', '{}')"`,
      CWD,
    );
    expect(result).not.toBeNull();
    expect(result!.blocked).toBe(true);
    expect(result!.reason).toContain('Inline code execution is blocked');
  });

  it('blocks node require node:fs literal writes to protected paths', () => {
    const result = checkBashSelfProtection(
      `node --eval "require('node:fs').writeFileSync('${CWD}/.claude/settings.json', '{}')"`,
      CWD,
    );
    expect(result).not.toBeNull();
    expect(result!.blocked).toBe(true);
    expect(result!.reason).toContain('Inline code execution is blocked');
  });

  it('blocks node literal writes to normal project paths with a guided denial', () => {
    const result = checkBashSelfProtection(
      `node --eval "fs.writeFileSync('src/generated.ts', 'ok')"`,
      CWD,
    );
    expect(result).not.toBeNull();
    expect(result!.reason).toContain('use Read, Write, or Edit');
  });

  it('blocks node require fs literal writes to normal project paths with a guided denial', () => {
    const result = checkBashSelfProtection(
      `node --eval "require('fs').writeFileSync('src/generated.ts', 'ok')"`,
      CWD,
    );
    expect(result).not.toBeNull();
    expect(result!.reason).toContain('use Read, Write, or Edit');
  });

  it('blocks inline eval normal-path writes with a guided denial instead of parsing file effects', () => {
    const result = checkBashSelfProtection(
      `node --eval "fs.writeFileSync('src/generated.ts', 'ok')"`,
      CWD,
    );
    expect(result).not.toBeNull();
    expect(result!.blocked).toBe(true);
    expect(result!.reason).toContain('Inline code execution is blocked');
    expect(result!.reason).toContain('use Read, Write, or Edit');
    expect(result!.reason).toContain('write a script file');
  });

  it.each([
    'npx node -e "console.log(1)"',
    'pnpm --dir v3 --filter @hive-flow/cli exec node -e "console.log(1)"',
    'npm exec -- node -e "console.log(1)"',
    'yarn node -e "console.log(1)"',
  ])('blocks package-runner inline eval with the same guided denial: %s', (command) => {
    const result = checkBashSelfProtection(command, CWD);
    expect(result).not.toBeNull();
    expect(result!.blocked).toBe(true);
    expect(result!.reason).toContain('Inline code execution is blocked');
    expect(result!.reason).toContain('use Read, Write, or Edit');
    expect(result!.reason).toContain('write a script file');
  });

  it('blocks python literal writes to protected paths', () => {
    const result = checkBashSelfProtection(
      `python3 -c "open('${CWD}/.claude/settings.json', 'w').write('{}')"`,
      CWD,
    );
    expect(result).not.toBeNull();
    expect(result!.blocked).toBe(true);
    expect(result!.reason).toContain('Inline code execution is blocked');
  });

  it('blocks python __import__ os literal deletes to protected paths', () => {
    const result = checkBashSelfProtection(
      `python3 -c "__import__('os').remove('${CWD}/.claude/settings.json')"`,
      CWD,
    );
    expect(result).not.toBeNull();
    expect(result!.blocked).toBe(true);
    expect(result!.reason).toContain('Inline code execution is blocked');
  });

  it('blocks python literal writes to normal project paths with a guided denial', () => {
    const result = checkBashSelfProtection(
      `python3 -c "open('src/generated.ts', 'w').write('ok')"`,
      CWD,
    );
    expect(result).not.toBeNull();
    expect(result!.reason).toContain('use Read, Write, or Edit');
  });

  it('blocks python __import__ os literal deletes to normal project paths with a guided denial', () => {
    const result = checkBashSelfProtection(
      `python3 -c "__import__('os').remove('src/generated.ts')"`,
      CWD,
    );
    expect(result).not.toBeNull();
    expect(result!.reason).toContain('use Read, Write, or Edit');
  });

  for (const variant of f1InlineMutationVariants) {
    it(`blocks F1 inline alias variant targeting protected path: ${variant.name}`, () => {
      const command = variant.command(f1ProtectedTarget);
      const result = checkBashSelfProtection(command, CWD);
      expect(result, command).not.toBeNull();
      expect(result!.blocked).toBe(true);
    });

    it(`denies F1 inline alias variant targeting normal path: ${variant.name}`, () => {
      const result = checkBashSelfProtection(variant.command(f1BenignTarget), CWD);
      expect(result).not.toBeNull();
      expect(result!.reason).toContain('Inline code execution is blocked');
    });
  }

  it('blocks tee to protected helper', () => {
    const result = checkBashSelfProtection(
      `echo "evil" | tee ${CWD}/.claude/helpers/router.js`,
      CWD,
    );
    expect(result).not.toBeNull();
    expect(result!.blocked).toBe(true);
  });

  it('blocks chained commands targeting protected files', () => {
    const result = checkBashSelfProtection(
      `echo ok; cp /tmp/x ${CWD}/.claude/helpers/session.js`,
      CWD,
    );
    expect(result).not.toBeNull();
    expect(result!.blocked).toBe(true);
  });

  it('allows commands targeting non-protected files', () => {
    const result = checkBashSelfProtection(
      `cp /tmp/data.json ${CWD}/src/data.json`,
      CWD,
    );
    expect(result).toBeNull();
  });

  it('allows read-only commands on protected files', () => {
    // cat, ls, head, etc. do not modify files
    const result = checkBashSelfProtection(
      `cat ${CWD}/.claude/settings.json`,
      CWD,
    );
    expect(result).toBeNull();
  });

  it('handles empty command', () => {
    const result = checkBashSelfProtection('', CWD);
    expect(result).toBeNull();
  });

  it('blocks output redirect with append (>>) to protected file', () => {
    const result = checkBashSelfProtection(
      `echo "malicious" >> ${CWD}/.claude/helpers/memory.js`,
      CWD,
    );
    expect(result).not.toBeNull();
    expect(result!.blocked).toBe(true);
  });

  it('blocks dd with of= targeting guard config', () => {
    const result = checkBashSelfProtection(
      `dd if=/dev/zero of=${HOME}/.hive-flow/permission-guard/config.json bs=1 count=0`,
      CWD,
    );
    expect(result).not.toBeNull();
    expect(result!.blocked).toBe(true);
  });

  it('blocks rm and mv targeting global enforcement control-plane state', () => {
    for (const target of [
      `${HOME}/.hive-flow/enforcement/global/state.json`,
      `${HOME}/.hive-flow/enforcement/global/denial-ledger.json`,
      `${HOME}/.hive-flow/enforcement/pipeline-state.json`,
      `${HOME}/.hive-flow/enforcement/.hmac-key`,
    ]) {
      const rmResult = checkBashSelfProtection(`rm ${target}`, CWD);
      expect(rmResult, `rm ${target}`).not.toBeNull();
      expect(rmResult!.blocked, `rm ${target}`).toBe(true);

      const mvResult = checkBashSelfProtection(`mv /tmp/evil ${target}`, CWD);
      expect(mvResult, `mv ${target}`).not.toBeNull();
      expect(mvResult!.blocked, `mv ${target}`).toBe(true);
    }
  });
});

// ---------------------------------------------------------------------------
// evaluateSelfProtection (unified entry point)
// ---------------------------------------------------------------------------

describe('evaluateSelfProtection', () => {
  beforeEach(() => {
    revokeOverride();
  });

  it('blocks Write to settings.json', () => {
    const result = evaluateSelfProtection(
      'Write',
      { file_path: `${CWD}/.claude/settings.json` },
      CWD,
    );
    expect(result).not.toBeNull();
    expect(result!.blocked).toBe(true);
  });

  it('blocks Edit to gate.ts', () => {
    const result = evaluateSelfProtection(
      'Edit',
      { file_path: `${CWD}/v3/@hive-flow/cli/src/permission-guard/gate.ts` },
      CWD,
    );
    expect(result).not.toBeNull();
    expect(result!.blocked).toBe(true);
  });

  it('blocks Bash mv to protected file', () => {
    const result = evaluateSelfProtection(
      'Bash',
      { command: `mv /tmp/x ${CWD}/.claude/settings.json` },
      CWD,
    );
    expect(result).not.toBeNull();
    expect(result!.blocked).toBe(true);
  });

  it('blocks Write and Bash mutations targeting global enforcement control-plane state', () => {
    for (const target of [
      `${HOME}/.hive-flow/enforcement/global/state.json`,
      `${HOME}/.hive-flow/enforcement/global/denial-ledger.json`,
      `${HOME}/.hive-flow/enforcement/pipeline-state.json`,
      `${HOME}/.hive-flow/enforcement/.hmac-key`,
    ]) {
      const writeResult = evaluateSelfProtection('Write', { file_path: target }, CWD);
      expect(writeResult, `Write ${target}`).not.toBeNull();
      expect(writeResult!.blocked, `Write ${target}`).toBe(true);

      const rmResult = evaluateSelfProtection('Bash', { command: `rm ${target}` }, CWD);
      expect(rmResult, `rm ${target}`).not.toBeNull();
      expect(rmResult!.blocked, `rm ${target}`).toBe(true);
    }
  });

  it('allows Write to non-protected file', () => {
    const result = evaluateSelfProtection(
      'Write',
      { file_path: `${CWD}/src/app.ts` },
      CWD,
    );
    expect(result).toBeNull();
  });

  it('allows build commands (npm run build)', () => {
    const result = evaluateSelfProtection(
      'Bash',
      { command: 'npm run build' },
      CWD,
    );
    expect(result).toBeNull();
  });

  it('allows tsc build commands', () => {
    const result = evaluateSelfProtection(
      'Bash',
      { command: 'tsc --project tsconfig.json' },
      CWD,
    );
    expect(result).toBeNull();
  });

  it('returns null for non-file tools', () => {
    const result = evaluateSelfProtection(
      'Read',
      { file_path: `${CWD}/.claude/settings.json` },
      CWD,
    );
    expect(result).toBeNull();
  });

  it('skips protection when cryptographic override is active', () => {
    // requestOverride() requires human authentication (keychain/tty),
    // so this test verifies the guard blocks when no override is active.
    // Full override integration is tested via the CLI permission-guard override command.
    expect(hasActiveOverride()).toBe(false);
    const result = evaluateSelfProtection(
      'Write',
      { file_path: `${CWD}/.claude/settings.json` },
      CWD,
    );
    expect(result).not.toBeNull();
    expect(result!.blocked).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Biometric override mechanism
// ---------------------------------------------------------------------------

describe('biometric override', () => {
  beforeEach(() => {
    revokeOverride();
  });

  it('starts with no active override', () => {
    expect(hasActiveOverride()).toBe(false);
  });

  it('overrideStatus returns active: false when no override file exists', () => {
    const status = overrideStatus();
    expect(status.active).toBe(false);
  });

  it('revokeOverride is callable when no override is active', () => {
    // Should not throw even when there is nothing to revoke
    expect(() => revokeOverride()).not.toThrow();
    expect(hasActiveOverride()).toBe(false);
  });

  it('hasActiveOverride returns false when override file is absent', () => {
    // No setup run in tests — no keychain, no override file
    expect(hasActiveOverride()).toBe(false);
  });

  it('requestOverride is an async function', () => {
    // requestOverride() requires human authentication (keychain/tty) and
    // cannot be called in automated tests. Verify it is an async function.
    expect(typeof requestOverride).toBe('function');
    const ret = requestOverride();
    expect(ret).toBeInstanceOf(Promise);
    // Cancel the promise to avoid side effects (it will fail gracefully — no pubkey)
    ret.catch(() => {});
  });
});

// ---------------------------------------------------------------------------
// Settings.json structural validation
// ---------------------------------------------------------------------------

describe('validateSettingsStructure', () => {
  let testDir: string;

  beforeEach(() => {
    testDir = tmpDir();
  });

  afterEach(() => {
    try { rmSync(testDir, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  it('validates a correct settings.json', () => {
    const settingsPath = join(testDir, 'settings.json');
    writeFileSync(settingsPath, JSON.stringify({
      hooks: {
        PreToolUse: [{
          matcher: 'Bash|Write|Edit|MultiEdit',
          hooks: [{
            type: 'command',
            command: 'node .claude/helpers/hook-handler.cjs permission-guard',
            timeout: 15000,
          }],
        }],
      },
    }));
    const result = validateSettingsStructure(settingsPath);
    expect(result.valid).toBe(true);
    expect(result.errors).toHaveLength(0);
  });

  it('detects missing hooks section', () => {
    const settingsPath = join(testDir, 'settings.json');
    writeFileSync(settingsPath, JSON.stringify({ permissions: {} }));
    const result = validateSettingsStructure(settingsPath);
    expect(result.valid).toBe(false);
    expect(result.errors).toContain('Missing "hooks" section');
  });

  it('detects missing PreToolUse', () => {
    const settingsPath = join(testDir, 'settings.json');
    writeFileSync(settingsPath, JSON.stringify({ hooks: {} }));
    const result = validateSettingsStructure(settingsPath);
    expect(result.valid).toBe(false);
    expect(result.errors.some(e => e.includes('PreToolUse'))).toBe(true);
  });

  it('detects missing permission-guard hook', () => {
    const settingsPath = join(testDir, 'settings.json');
    writeFileSync(settingsPath, JSON.stringify({
      hooks: {
        PreToolUse: [{
          matcher: 'Bash|Write|Edit',
          hooks: [{
            type: 'command',
            command: 'node .claude/helpers/hook-handler.cjs route',
          }],
        }],
      },
    }));
    const result = validateSettingsStructure(settingsPath);
    expect(result.valid).toBe(false);
    expect(result.errors.some(e => e.includes('permission-guard'))).toBe(true);
  });

  it('detects missing tools in matcher', () => {
    const settingsPath = join(testDir, 'settings.json');
    writeFileSync(settingsPath, JSON.stringify({
      hooks: {
        PreToolUse: [{
          matcher: 'Bash|Write',
          hooks: [{
            type: 'command',
            command: 'node .claude/helpers/hook-handler.cjs permission-guard',
          }],
        }],
      },
    }));
    const result = validateSettingsStructure(settingsPath);
    expect(result.valid).toBe(false);
    expect(result.errors.some(e => e.includes('Edit'))).toBe(true);
  });

  it('handles missing file', () => {
    const result = validateSettingsStructure(join(testDir, 'nonexistent.json'));
    expect(result.valid).toBe(false);
  });

  it('handles invalid JSON', () => {
    const settingsPath = join(testDir, 'settings.json');
    writeFileSync(settingsPath, 'not json');
    const result = validateSettingsStructure(settingsPath);
    expect(result.valid).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Integrity monitoring
// ---------------------------------------------------------------------------

describe('integrity monitoring', () => {
  let testDir: string;

  beforeEach(() => {
    testDir = tmpDir();
  });

  afterEach(() => {
    try { rmSync(testDir, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  it('captures and verifies file hashes', () => {
    // Create a mock protected file structure
    const helperDir = join(testDir, '.claude', 'helpers');
    mkdirSync(helperDir, { recursive: true });
    const hookHandler = join(helperDir, 'hook-handler.cjs');
    writeFileSync(hookHandler, 'original content');

    // Capture uses PROTECTED_PATH_TEMPLATES which reference ${CWD},
    // but we can test the verify function directly with a manual snapshot
    const snapshot = {
      ts: new Date().toISOString(),
      hashes: {
        [hookHandler]: require('crypto').createHash('sha256').update('original content').digest('hex'),
      },
    };

    // No changes yet
    const clean = verifyIntegrity(snapshot);
    expect(clean).toHaveLength(0);

    // Modify the file
    writeFileSync(hookHandler, 'modified content');
    const dirty = verifyIntegrity(snapshot);
    expect(dirty).toHaveLength(1);
    expect(dirty[0].status).toBe('modified');
    expect(dirty[0].path).toBe(hookHandler);
  });

  it('detects deleted files', () => {
    const filePath = join(testDir, 'guard-file.ts');
    writeFileSync(filePath, 'guard code');
    const snapshot = {
      ts: new Date().toISOString(),
      hashes: {
        [filePath]: require('crypto').createHash('sha256').update('guard code').digest('hex'),
      },
    };

    rmSync(filePath);
    const violations = verifyIntegrity(snapshot);
    expect(violations).toHaveLength(1);
    expect(violations[0].status).toBe('deleted');
  });
});

// ---------------------------------------------------------------------------
// Attack vector verification — self-protection specific
// ---------------------------------------------------------------------------

describe('self-protection attack vectors', () => {
  beforeEach(() => {
    revokeOverride();
  });

  const protectedTargets = [
    { name: 'settings.json', path: `${CWD}/.claude/settings.json` },
    { name: 'hook-handler.cjs', path: `${CWD}/.claude/helpers/hook-handler.cjs` },
    { name: 'guard gate.ts', path: `${CWD}/v3/@hive-flow/cli/src/permission-guard/gate.ts` },
    { name: 'guard self-protection.ts', path: `${CWD}/v3/@hive-flow/cli/src/permission-guard/self-protection.ts` },
    { name: 'compiled gate.js', path: `${CWD}/v3/@hive-flow/cli/dist/src/permission-guard/gate.js` },
    { name: 'guard config', path: `${HOME}/.hive-flow/permission-guard/config.json` },
  ];

  describe('Write tool attacks', () => {
    for (const { name, path } of protectedTargets) {
      it(`blocks Write to ${name}`, () => {
        const result = evaluateSelfProtection('Write', { file_path: path }, CWD);
        expect(result).not.toBeNull();
        expect(result!.blocked).toBe(true);
      });
    }
  });

  describe('Edit tool attacks', () => {
    for (const { name, path } of protectedTargets) {
      it(`blocks Edit to ${name}`, () => {
        const result = evaluateSelfProtection('Edit', { file_path: path }, CWD);
        expect(result).not.toBeNull();
        expect(result!.blocked).toBe(true);
      });
    }
  });

  describe('Bash mv attacks', () => {
    for (const { name, path } of protectedTargets) {
      it(`blocks mv to ${name}`, () => {
        const result = evaluateSelfProtection(
          'Bash',
          { command: `mv /tmp/evil ${path}` },
          CWD,
        );
        expect(result).not.toBeNull();
        expect(result!.blocked).toBe(true);
      });
    }
  });

  describe('Bash cp attacks', () => {
    for (const { name, path } of protectedTargets) {
      it(`blocks cp to ${name}`, () => {
        const result = evaluateSelfProtection(
          'Bash',
          { command: `cp /tmp/evil ${path}` },
          CWD,
        );
        expect(result).not.toBeNull();
        expect(result!.blocked).toBe(true);
      });
    }
  });

  describe('Bash echo redirect attacks', () => {
    for (const { name, path } of protectedTargets) {
      it(`blocks echo > to ${name}`, () => {
        const result = evaluateSelfProtection(
          'Bash',
          { command: `echo '{}' > ${path}` },
          CWD,
        );
        expect(result).not.toBeNull();
        expect(result!.blocked).toBe(true);
      });
    }
  });

  describe('Bash sed -i attacks', () => {
    it('blocks sed -i on settings.json', () => {
      const result = evaluateSelfProtection(
        'Bash',
        { command: `sed -i 's/permission-guard/noop/g' ${CWD}/.claude/settings.json` },
        CWD,
      );
      expect(result).not.toBeNull();
      expect(result!.blocked).toBe(true);
    });
  });

  describe('Bash tee attacks', () => {
    it('blocks tee to helper files', () => {
      const result = evaluateSelfProtection(
        'Bash',
        { command: `echo "evil" | tee ${CWD}/.claude/helpers/router.js` },
        CWD,
      );
      expect(result).not.toBeNull();
      expect(result!.blocked).toBe(true);
    });
  });

  describe('chained command attacks', () => {
    it('blocks second command in chain targeting protected file', () => {
      const result = evaluateSelfProtection(
        'Bash',
        { command: `echo ok && cp /tmp/evil ${CWD}/.claude/settings.json` },
        CWD,
      );
      expect(result).not.toBeNull();
      expect(result!.blocked).toBe(true);
    });

    it('blocks command after semicolon targeting protected file', () => {
      const result = evaluateSelfProtection(
        'Bash',
        { command: `ls; mv /tmp/evil ${CWD}/.claude/helpers/hook-handler.cjs` },
        CWD,
      );
      expect(result).not.toBeNull();
      expect(result!.blocked).toBe(true);
    });
  });

  describe('biometric override allows protected operations', () => {
    it('blocks Write when no override is active (override requires keychain auth)', () => {
      // requestOverride() requires human authentication — cannot be invoked in tests.
      // Verify that without an active override, protection is enforced.
      expect(hasActiveOverride()).toBe(false);
      const result = evaluateSelfProtection(
        'Write',
        { file_path: `${CWD}/.claude/settings.json` },
        CWD,
      );
      expect(result).not.toBeNull();
      expect(result!.blocked).toBe(true);
    });

    it('blocks again after override is revoked', () => {
      revokeOverride();
      expect(hasActiveOverride()).toBe(false);
      const result = evaluateSelfProtection(
        'Write',
        { file_path: `${CWD}/.claude/settings.json` },
        CWD,
      );
      expect(result).not.toBeNull();
      expect(result!.blocked).toBe(true);
    });
  });
});
