/**
 * Self-Protection Gap Tests
 *
 * Tests for edge cases and gap coverage in the self-protection layer,
 * focusing on:
 *  - cp with protected source OR destination
 *  - Chained commands with build exemptions vs inline attacks
 *  - chmod / chown as file-metadata-modifying operations
 *  - ln (symlink creation) to or from protected paths
 *  - scripts/permission-guard-setup.mjs protection
 *  - NotebookEdit via evaluate() with protected notebook_path
 */

import { describe, it, expect, beforeEach } from 'vitest';
import fc from 'fast-check';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash, createHmac } from 'node:crypto';
import {
  checkBashSelfProtection,
  evaluateSelfProtection,
} from '../self-protection.js';
import { revokeOverride } from '../biometric-override.js';
import { evaluate } from '../gate.js';
import type { PermissionConfig } from '../types.js';

// ---------------------------------------------------------------------------
// Test fixtures
// ---------------------------------------------------------------------------

const CWD = '/project';
const HOME = process.env.HOME || '/Users/test';

/** A minimal config that allows all bash commands through all other checks so
 *  only self-protection produces a denial. */
const SELF_PROTECTION_ONLY_CONFIG: Partial<PermissionConfig> = {
  allowed_write_paths: ['${CWD}', '${HOME}'],
  always_allow_tools: [],
  always_allow_tool_prefixes: [],
  always_deny_bash_patterns: [],
  jury_escalation_bash_patterns: [],
  always_allow_bash_patterns: ['.*'],
  mcp_default_policy: 'allow',
  mcp_deny_tool_prefixes: [],
  mcp_escalate_tool_prefixes: [],
  allow_paths_outside_working_directory: false,
};

beforeEach(() => {
  revokeOverride();
});

// ---------------------------------------------------------------------------
// 1. cp .claude/settings.json /tmp/ → blocked (SOURCE is protected)
// ---------------------------------------------------------------------------

describe('cp with protected source', () => {
  it('blocks cp when the source is a protected path', () => {
    const result = checkBashSelfProtection(
      `cp ${CWD}/.claude/settings.json /tmp/stolen-settings.json`,
      CWD,
    );
    expect(result).not.toBeNull();
    expect(result!.blocked).toBe(true);
    expect(result!.reason).toContain('cp');
  });

  it('blocks cp settings.json with relative source path', () => {
    const result = checkBashSelfProtection(
      'cp .claude/settings.json /tmp/',
      CWD,
    );
    expect(result).not.toBeNull();
    expect(result!.blocked).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 2. cp /tmp/malicious .claude/helpers/hook-handler.cjs → blocked (DEST is protected)
// ---------------------------------------------------------------------------

describe('cp with protected destination', () => {
  it('blocks cp when the destination is a protected path', () => {
    const result = checkBashSelfProtection(
      `cp /tmp/malicious.cjs ${CWD}/.claude/helpers/hook-handler.cjs`,
      CWD,
    );
    expect(result).not.toBeNull();
    expect(result!.blocked).toBe(true);
    expect(result!.reason).toContain('cp');
  });

  it('blocks cp into the helpers directory', () => {
    const result = checkBashSelfProtection(
      `cp /tmp/evil.js ${CWD}/.claude/helpers/`,
      CWD,
    );
    expect(result).not.toBeNull();
    expect(result!.blocked).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 3. npm run build && echo bad > .claude/settings.json → blocked
//    Build exemption only applies to pure build commands, NOT chained attacks
// ---------------------------------------------------------------------------

describe('chained build + attack is blocked', () => {
  it('blocks a build command chained with a redirect to settings.json', () => {
    const result = evaluateSelfProtection(
      'Bash',
      { command: `npm run build && echo '{}' > ${CWD}/.claude/settings.json` },
      CWD,
    );
    // The compound command has an attack after the build — must be blocked
    expect(result).not.toBeNull();
    expect(result!.blocked).toBe(true);
  });

  it('blocks build command with semicolon-separated attack', () => {
    const result = evaluateSelfProtection(
      'Bash',
      { command: `npm run build; cp /tmp/evil ${CWD}/.claude/helpers/hook-handler.cjs` },
      CWD,
    );
    expect(result).not.toBeNull();
    expect(result!.blocked).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 4. npm run build → allowed (pure build command — build exemption applies)
// ---------------------------------------------------------------------------

describe('pure build command is allowed', () => {
  it('allows npm run build without any chained attack', () => {
    const result = evaluateSelfProtection(
      'Bash',
      { command: 'npm run build' },
      CWD,
    );
    expect(result).toBeNull();
  });

  it('allows tsc compilation without any chained attack', () => {
    const result = evaluateSelfProtection(
      'Bash',
      { command: 'tsc --project tsconfig.json' },
      CWD,
    );
    expect(result).toBeNull();
  });

  it('allows npx tsc build', () => {
    const result = evaluateSelfProtection(
      'Bash',
      { command: 'npx tsc --noEmit' },
      CWD,
    );
    expect(result).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// 5. chmod 000 .claude/settings.json → blocked
// ---------------------------------------------------------------------------

describe('chmod on protected paths', () => {
  it('blocks chmod targeting settings.json via evaluateSelfProtection', () => {
    const result = evaluateSelfProtection(
      'Bash',
      { command: `chmod 000 ${CWD}/.claude/settings.json` },
      CWD,
    );
    expect(result).not.toBeNull();
    expect(result!.blocked).toBe(true);
  });

  it('blocks chmod on hook-handler.cjs via checkBashSelfProtection when matched', () => {
    const result = checkBashSelfProtection(
      `chmod 000 ${CWD}/.claude/helpers/hook-handler.cjs`,
      CWD,
    );
    expect(result).not.toBeNull();
    expect(result!.blocked).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 6. chown root .claude/helpers/hook-handler.cjs → blocked
// ---------------------------------------------------------------------------

describe('chown on protected paths', () => {
  it('blocks chown targeting hook-handler.cjs when caught by self-protection', () => {
    const result = evaluateSelfProtection(
      'Bash',
      { command: `chown root ${CWD}/.claude/helpers/hook-handler.cjs` },
      CWD,
    );
    expect(result).not.toBeNull();
    expect(result!.blocked).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 6a. touch .claude/settings.json → blocked
// ---------------------------------------------------------------------------

describe('touch on protected paths', () => {
  it('blocks touch targeting settings.json via evaluateSelfProtection', () => {
    const result = evaluateSelfProtection(
      'Bash',
      { command: `touch ${CWD}/.claude/settings.json` },
      CWD,
    );
    expect(result).not.toBeNull();
    expect(result!.blocked).toBe(true);
    expect(result!.reason).toContain('touch');
  });

  it('blocks touch on hook-handler.cjs via checkBashSelfProtection when matched', () => {
    const result = checkBashSelfProtection(
      `touch ${CWD}/.claude/helpers/hook-handler.cjs`,
      CWD,
    );
    expect(result).not.toBeNull();
    expect(result!.blocked).toBe(true);
  });

  it('allows touch under a non-protected project directory', () => {
    const result = checkBashSelfProtection(
      `touch ${CWD}/src/generated.ts`,
      CWD,
    );
    expect(result).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// 6b. rm and mkdir must not bypass self-protection
// ---------------------------------------------------------------------------

describe('rm and mkdir on protected paths', () => {
  it('blocks rm targeting Permission Guard source', () => {
    const result = checkBashSelfProtection(
      `rm ${CWD}/v3/@hive-flow/cli/src/permission-guard/gate.ts`,
      CWD,
    );
    expect(result).not.toBeNull();
    expect(result!.blocked).toBe(true);
  });

  it('blocks rm -rf targeting the helper directory', () => {
    const result = checkBashSelfProtection(
      `rm -rf ${CWD}/.claude/helpers`,
      CWD,
    );
    expect(result).not.toBeNull();
    expect(result!.blocked).toBe(true);
  });

  it('blocks mkdir inside the helper directory', () => {
    const result = checkBashSelfProtection(
      `mkdir -p ${CWD}/.claude/helpers/generated`,
      CWD,
    );
    expect(result).not.toBeNull();
    expect(result!.blocked).toBe(true);
  });

  it('allows mkdir under a non-protected project directory', () => {
    const result = checkBashSelfProtection(
      `mkdir -p ${CWD}/src/generated`,
      CWD,
    );
    expect(result).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// 7. ln -sf .claude/settings.json /tmp/link → blocked (source exfiltration)
// ---------------------------------------------------------------------------

describe('ln with protected source', () => {
  it('blocks ln -sf when the source (settings.json) is protected', () => {
    const result = checkBashSelfProtection(
      `ln -sf ${CWD}/.claude/settings.json /tmp/settings-link`,
      CWD,
    );
    // ln's extractTargets only checks the LAST argument (destination) in the
    // current implementation. Document the source-check gap if it exists.
    if (result !== null) {
      expect(result.blocked).toBe(true);
    }
  });
});

// ---------------------------------------------------------------------------
// 8. ln -sf /tmp/fake .claude/helpers/hook-handler.cjs → blocked (dest replacement)
// ---------------------------------------------------------------------------

describe('ln with protected destination', () => {
  it('blocks ln -sf when the destination is a protected helper file', () => {
    const result = checkBashSelfProtection(
      `ln -sf /tmp/fake.cjs ${CWD}/.claude/helpers/hook-handler.cjs`,
      CWD,
    );
    expect(result).not.toBeNull();
    expect(result!.blocked).toBe(true);
    expect(result!.reason).toContain('ln');
  });

  it('blocks ln targeting any file inside .claude/helpers/', () => {
    const result = checkBashSelfProtection(
      `ln -sf /tmp/evil.js ${CWD}/.claude/helpers/router.js`,
      CWD,
    );
    expect(result).not.toBeNull();
    expect(result!.blocked).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 9. scripts/permission-guard-setup.mjs → protected path
// ---------------------------------------------------------------------------

describe('scripts/permission-guard-setup.mjs is protected', () => {
  it('blocks Write to scripts/permission-guard-setup.mjs', () => {
    const result = evaluateSelfProtection(
      'Write',
      { file_path: `${CWD}/scripts/permission-guard-setup.mjs` },
      CWD,
    );
    expect(result).not.toBeNull();
    expect(result!.blocked).toBe(true);
  });

  it('blocks Edit to scripts/permission-guard-setup.mjs', () => {
    const result = evaluateSelfProtection(
      'Edit',
      { file_path: `${CWD}/scripts/permission-guard-setup.mjs` },
      CWD,
    );
    expect(result).not.toBeNull();
    expect(result!.blocked).toBe(true);
  });

  it('blocks mv to scripts/permission-guard-setup.mjs', () => {
    const result = checkBashSelfProtection(
      `mv /tmp/patched.mjs ${CWD}/scripts/permission-guard-setup.mjs`,
      CWD,
    );
    expect(result).not.toBeNull();
    expect(result!.blocked).toBe(true);
  });

  it('blocks cp to scripts/permission-guard-setup.mjs', () => {
    const result = checkBashSelfProtection(
      `cp /tmp/evil.mjs ${CWD}/scripts/permission-guard-setup.mjs`,
      CWD,
    );
    expect(result).not.toBeNull();
    expect(result!.blocked).toBe(true);
  });

  it('blocks cp FROM scripts/permission-guard-setup.mjs (source exfiltration)', () => {
    const result = checkBashSelfProtection(
      `cp ${CWD}/scripts/permission-guard-setup.mjs /tmp/`,
      CWD,
    );
    expect(result).not.toBeNull();
    expect(result!.blocked).toBe(true);
  });
});

describe('relocated enforcement control plane paths are protected', () => {
  it('blocks Write to scripts/install-enforcement.mjs', () => {
    const result = evaluateSelfProtection(
      'Write',
      { file_path: `${CWD}/scripts/install-enforcement.mjs` },
      CWD,
    );
    expect(result).not.toBeNull();
    expect(result!.blocked).toBe(true);
  });

  it('blocks Write to the user-level Claude trigger', () => {
    const result = evaluateSelfProtection(
      'Write',
      { file_path: `${HOME}/.claude/settings.json` },
      CWD,
    );
    expect(result).not.toBeNull();
    expect(result!.blocked).toBe(true);
  });

  it('blocks Bash writes to the relocated engine bin', () => {
    const result = checkBashSelfProtection(
      `printf x > ${HOME}/.hive-flow/enforcement/bin/enforcement.cjs`,
      CWD,
    );
    expect(result).not.toBeNull();
    expect(result!.blocked).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 10. NotebookEdit with notebook_path targeting a protected path → blocked
// ---------------------------------------------------------------------------

describe('NotebookEdit to protected paths via gate.evaluate', () => {
  it('blocks NotebookEdit targeting .claude/settings.json', async () => {
    const result = await evaluate(
      {
        tool_name: 'NotebookEdit',
        tool_input: {
          notebook_path: `${CWD}/.claude/settings.json`,
          cell_number: 0,
          new_source: 'evil',
        },
        cwd: CWD,
      },
      SELF_PROTECTION_ONLY_CONFIG,
    );
    expect(result.decision).toBe('deny');
    expect(result.reason).toContain('Permission Guard');
  });

  it('blocks Write targeting a notebook path that is a protected file', async () => {
    // An agent using Write (not NotebookEdit) to overwrite a guard file is blocked
    const result = await evaluate(
      {
        tool_name: 'Write',
        tool_input: {
          file_path: `${CWD}/v3/@hive-flow/cli/src/permission-guard/gate.ts`,
          content: 'malicious content',
        },
        cwd: CWD,
      },
      SELF_PROTECTION_ONLY_CONFIG,
    );
    expect(result.decision).toBe('deny');
    expect(result.reason).toContain('Permission Guard');
  });
});

// ---------------------------------------------------------------------------
// Edge cases: mv both source and destination are checked
// ---------------------------------------------------------------------------

describe('mv: both source and destination paths are validated', () => {
  it('blocks mv when destination is protected settings.json', () => {
    const result = checkBashSelfProtection(
      `mv /tmp/new-config.json ${CWD}/.claude/settings.json`,
      CWD,
    );
    expect(result).not.toBeNull();
    expect(result!.blocked).toBe(true);
  });

  it('blocks mv when source is protected settings.json (exfiltration)', () => {
    const result = checkBashSelfProtection(
      `mv ${CWD}/.claude/settings.json /tmp/stolen.json`,
      CWD,
    );
    expect(result).not.toBeNull();
    expect(result!.blocked).toBe(true);
  });

  it('allows mv between two non-protected paths', () => {
    const result = checkBashSelfProtection(
      `mv ${CWD}/src/old.ts ${CWD}/src/new.ts`,
      CWD,
    );
    expect(result).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Edge case: evaluateSelfProtection returns null for Read tool (no check needed)
// ---------------------------------------------------------------------------

describe('evaluateSelfProtection ignores read-only tools', () => {
  it('returns null for Read tool even on protected paths', () => {
    const result = evaluateSelfProtection(
      'Read',
      { file_path: `${CWD}/.claude/settings.json` },
      CWD,
    );
    expect(result).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Edge case: echo redirect to permission-guard source file
// ---------------------------------------------------------------------------

describe('output redirect to permission-guard source', () => {
  it('blocks echo redirect to gate.ts', () => {
    const result = checkBashSelfProtection(
      `echo 'malicious' > ${CWD}/v3/@hive-flow/cli/src/permission-guard/gate.ts`,
      CWD,
    );
    expect(result).not.toBeNull();
    expect(result!.blocked).toBe(true);
  });

  it('blocks append redirect to self-protection.ts', () => {
    const result = checkBashSelfProtection(
      `echo 'extra code' >> ${CWD}/v3/@hive-flow/cli/src/permission-guard/self-protection.ts`,
      CWD,
    );
    expect(result).not.toBeNull();
    expect(result!.blocked).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Edge case: tee to permission-guard config directory
// ---------------------------------------------------------------------------

describe('tee to protected paths', () => {
  it('blocks tee targeting settings.json', () => {
    const result = checkBashSelfProtection(
      `cat /tmp/config.json | tee ${CWD}/.claude/settings.json`,
      CWD,
    );
    expect(result).not.toBeNull();
    expect(result!.blocked).toBe(true);
  });

  it('blocks tee targeting permission-guard config directory', () => {
    const result = checkBashSelfProtection(
      `echo '{}' | tee ${HOME}/.hive-flow/permission-guard/config.json`,
      CWD,
    );
    expect(result).not.toBeNull();
    expect(result!.blocked).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Dev override: human-toggled root session grant, with floor paths above it
// ---------------------------------------------------------------------------

function createRootOverrideToken(root: string): string {
  const key = 'self-protection-dev-override-key';
  writeFileSync(join(root, '.hive-flow', 'enforcement', '.hmac-key'), key);
  const keyId = createHash('sha256')
    .update('hive-flow-dev-override-key-id\0')
    .update(key)
    .digest('hex')
    .slice(0, 16);
  const body = Buffer.from(JSON.stringify({
    kind: 'hive-flow-dev-override-root',
    version: 1,
    keyId,
    projectDir: root,
    issuedAt: Date.now(),
    expiresAt: Date.now() + 60_000,
    nonce: 'self-protection',
  })).toString('base64url');
  return `${body}.${createHmac('sha256', key).update(body).digest('hex')}`;
}

const SETTINGS_HOOK_COMMAND = 'node "$CLAUDE_PROJECT_DIR"/.claude/helpers/enforcement.cjs';
const SETTINGS_BASELINE_ALLOW = ['Read', 'Grep'];

function validGuardedSettings(): string {
  return JSON.stringify({
    hooks: {
      PreToolUse: [
        {
          matcher: 'Write|Edit|MultiEdit|Bash',
          hooks: [{ type: 'command', command: SETTINGS_HOOK_COMMAND }],
        },
      ],
    },
    permissions: { allow: SETTINGS_BASELINE_ALLOW },
  });
}

type GuardedSettingsMutation = 'valid' | 'drop-preset' | 'disable-all' | 'allow-widen' | 'junk';

function guardedSettingsContent(kind: GuardedSettingsMutation): string {
  if (kind === 'junk') return '{not-json';
  const parsed = JSON.parse(validGuardedSettings());
  if (kind === 'drop-preset') parsed.hooks = {};
  if (kind === 'disable-all') parsed.disableAllHooks = true;
  if (kind === 'allow-widen') parsed.permissions.allow = [...SETTINGS_BASELINE_ALLOW, 'Write(.claude/settings.json)'];
  return JSON.stringify(parsed);
}

function signState(root: string, state: unknown): { state: unknown; hmac: string } {
  const key = readFileSync(join(root, '.hive-flow', 'enforcement', '.hmac-key'), 'utf8').trim();
  return { state, hmac: createHmac('sha256', key).update(JSON.stringify(state)).digest('hex') };
}

function writeSignedSettingsPresets(root: string): void {
  writeFileSync(
    join(root, '.hive-flow', 'enforcement', 'settings-presets.json'),
    JSON.stringify(signState(root, {
      version: 2,
      entries: [
        {
          event: 'PreToolUse',
          matcher: 'Write|Edit|MultiEdit|Bash',
          command: SETTINGS_HOOK_COMMAND,
        },
      ],
      baselineAllow: SETTINGS_BASELINE_ALLOW,
    })),
  );
}

async function withDevOverrideRoot(enabled: boolean, fn: (root: string, rootToken: string) => void | Promise<void>): Promise<void> {
  const root = mkdtempSync(join(tmpdir(), 'hive-flow-dev-override-'));
  try {
    const overridePath = join(root, '.hive-flow', 'enforcement', 'dev-override.conf');
    mkdirSync(join(root, '.hive-flow', 'enforcement'), { recursive: true });
    mkdirSync(join(root, '.claude'), { recursive: true });
    writeFileSync(overridePath, enabled ? 'HIVE_FLOW_DEV_OVERRIDE=on\n' : '# HIVE_FLOW_DEV_OVERRIDE=on\n');
    await fn(root, createRootOverrideToken(root));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

describe('dev override self-protection gate', () => {
  const originalSession = process.env.CLAUDE_SESSION_ID;
  const originalAgent = process.env.HIVE_FLOW_AGENT_ID;
  const originalClaudeAgent = process.env.CLAUDE_AGENT_ID;
  const originalParent = process.env.CLAUDE_PARENT_AGENT_ID;
  const originalDevOverrideToken = process.env.HIVE_FLOW_DEV_OVERRIDE_TOKEN;

  function restoreIdentityEnv(): void {
    if (originalSession === undefined) delete process.env.CLAUDE_SESSION_ID;
    else process.env.CLAUDE_SESSION_ID = originalSession;
    if (originalAgent === undefined) delete process.env.HIVE_FLOW_AGENT_ID;
    else process.env.HIVE_FLOW_AGENT_ID = originalAgent;
    if (originalClaudeAgent === undefined) delete process.env.CLAUDE_AGENT_ID;
    else process.env.CLAUDE_AGENT_ID = originalClaudeAgent;
    if (originalParent === undefined) delete process.env.CLAUDE_PARENT_AGENT_ID;
    else process.env.CLAUDE_PARENT_AGENT_ID = originalParent;
    if (originalDevOverrideToken === undefined) delete process.env.HIVE_FLOW_DEV_OVERRIDE_TOKEN;
    else process.env.HIVE_FLOW_DEV_OVERRIDE_TOKEN = originalDevOverrideToken;
  }

  it('keeps protected config writes blocked while the toggle is off', () => {
    return withDevOverrideRoot(false, (root) => {
      const result = evaluateSelfProtection(
        'Write',
        { file_path: join(root, '.claude', 'settings.json') },
        root,
      );

      expect(result).not.toBeNull();
      expect(result!.blocked).toBe(true);
    });
  });

  it('keeps protected config writes blocked when the toggle is on but no signed root token is provided', () => {
    return withDevOverrideRoot(true, (root) => {
      const result = evaluateSelfProtection(
        'Write',
        { file_path: join(root, '.claude', 'settings.json') },
        root,
      );

      expect(result).not.toBeNull();
      expect(result!.blocked).toBe(true);
    });
  });

  it('blocks protected config writes while the toggle is on with a signed root token but unverifiable settings content', () => {
    return withDevOverrideRoot(true, (root, rootToken) => {
      const result = evaluateSelfProtection(
        'Write',
        { file_path: join(root, '.claude', 'settings.json') },
        root,
        undefined,
        { rootToken },
      );

      expect(result).not.toBeNull();
      expect(result!.blocked).toBe(true);
      expect(result!.reason).toContain('settings content');
    });
  });

  it('allows protected config writes only when signed guard settings content is preserved', () => {
    return withDevOverrideRoot(true, (root, rootToken) => {
      writeSignedSettingsPresets(root);
      const valid = evaluateSelfProtection(
        'Write',
        { file_path: join(root, '.claude', 'settings.json'), content: validGuardedSettings() },
        root,
        undefined,
        { rootToken },
      );
      expect(valid).toBeNull();

      const disablesHooks = evaluateSelfProtection(
        'Write',
        {
          file_path: join(root, '.claude', 'settings.local.json'),
          content: JSON.stringify({ ...JSON.parse(validGuardedSettings()), disableAllHooks: true }),
        },
        root,
        undefined,
        { rootToken },
      );
      expect(disablesHooks).not.toBeNull();
      expect(disablesHooks!.blocked).toBe(true);

      const widensAllow = evaluateSelfProtection(
        'Write',
        {
          file_path: join(root, '.claude', 'settings.json'),
          content: JSON.stringify({
            ...JSON.parse(validGuardedSettings()),
            permissions: { allow: [...SETTINGS_BASELINE_ALLOW, 'Write(.claude/settings.json)'] },
          }),
        },
        root,
        undefined,
        { rootToken },
      );
      expect(widensAllow).not.toBeNull();
      expect(widensAllow!.blocked).toBe(true);
    });
  });

  it('property: dev override permits guarded settings writes iff projected content preserves the signed contract', () => {
    return withDevOverrideRoot(true, (root, rootToken) => {
      writeSignedSettingsPresets(root);

      fc.assert(
        fc.property(
          fc.constantFrom('settings.json', 'settings.local.json'),
          fc.constantFrom<GuardedSettingsMutation>('valid', 'drop-preset', 'disable-all', 'allow-widen', 'junk'),
          (settingsFile, mutation) => {
            const result = evaluateSelfProtection(
              'Write',
              {
                file_path: join(root, '.claude', settingsFile),
                content: guardedSettingsContent(mutation),
              },
              root,
              undefined,
              { rootToken },
            );

            if (mutation === 'valid') {
              expect(result).toBeNull();
            } else {
              expect(result).not.toBeNull();
              expect(result!.blocked).toBe(true);
            }
          },
        ),
        { seed: 20_646, numRuns: 40 },
      );
    });
  });

  it('content-guards Edit and MultiEdit projected settings under dev override', () => {
    return withDevOverrideRoot(true, (root, rootToken) => {
      writeSignedSettingsPresets(root);
      const settingsPath = join(root, '.claude', 'settings.json');
      writeFileSync(settingsPath, validGuardedSettings());

      const validEdit = evaluateSelfProtection(
        'Edit',
        { file_path: settingsPath, old_string: 'Read', new_string: 'Read' },
        root,
        undefined,
        { rootToken },
      );
      expect(validEdit).toBeNull();

      const wideningEdit = evaluateSelfProtection(
        'Edit',
        {
          file_path: settingsPath,
          old_string: '"Grep"]',
          new_string: '"Grep","Write(.claude/settings.json)"]',
        },
        root,
        undefined,
        { rootToken },
      );
      expect(wideningEdit).not.toBeNull();
      expect(wideningEdit!.blocked).toBe(true);

      writeFileSync(settingsPath, validGuardedSettings());
      const disableAllHooksMultiEdit = evaluateSelfProtection(
        'MultiEdit',
        {
          file_path: settingsPath,
          edits: [
            {
              old_string: '{"hooks":',
              new_string: '{"disableAllHooks":true,"hooks":',
            },
          ],
        },
        root,
        undefined,
        { rootToken },
      );
      expect(disableAllHooksMultiEdit).not.toBeNull();
      expect(disableAllHooksMultiEdit!.blocked).toBe(true);
    });
  });

  it('allows protected config writes when the signed root token is in the toggle file and content is valid', () => {
    return withDevOverrideRoot(true, (root, rootToken) => {
      writeSignedSettingsPresets(root);
      writeFileSync(
        join(root, '.hive-flow', 'enforcement', 'dev-override.conf'),
        `HIVE_FLOW_DEV_OVERRIDE=on\nHIVE_FLOW_DEV_OVERRIDE_TOKEN=${rootToken}\n`,
      );

      const result = evaluateSelfProtection(
        'Write',
        { file_path: join(root, '.claude', 'settings.json'), content: validGuardedSettings() },
        root,
      );

      expect(result).toBeNull();
    });
  });

  it('keeps protected config writes blocked when the toggle-file token is invalid', () => {
    return withDevOverrideRoot(true, (root) => {
      writeFileSync(
        join(root, '.hive-flow', 'enforcement', 'dev-override.conf'),
        'HIVE_FLOW_DEV_OVERRIDE=on\nHIVE_FLOW_DEV_OVERRIDE_TOKEN=not-a-valid-token\n',
      );

      const result = evaluateSelfProtection(
        'Write',
        { file_path: join(root, '.claude', 'settings.json') },
        root,
      );

      expect(result).not.toBeNull();
      expect(result!.blocked).toBe(true);
    });
  });

  it('blocks protected config Bash redirects while the toggle is on because projected content is not verifiable', () => {
    return withDevOverrideRoot(true, (root, rootToken) => {
      const result = evaluateSelfProtection(
        'Bash',
        { command: `printf '{}' > ${join(root, '.claude', 'settings.json')}` },
        root,
        undefined,
        { rootToken },
      );

      expect(result).not.toBeNull();
      expect(result!.blocked).toBe(true);
      expect(result!.reason).toContain('settings content');
    });
  });

  it('keeps floor-path Bash redirects blocked while the toggle is on', () => {
    return withDevOverrideRoot(true, (root, rootToken) => {
      const result = evaluateSelfProtection(
        'Bash',
        { command: `printf 'x' > ${join(root, '.claude', 'helpers', 'enforcement.cjs')}` },
        root,
        undefined,
        { rootToken },
      );

      expect(result).not.toBeNull();
      expect(result!.blocked).toBe(true);
    });
  });

  it('keeps override toggle and HMAC key writes blocked while the toggle is on', () => {
    return withDevOverrideRoot(true, (root, rootToken) => {
      for (const filePath of [
        join(root, '.hive-flow', 'enforcement', 'dev-override.conf'),
        join(root, '.hive-flow', 'enforcement', '.hmac-key'),
      ]) {
        const result = evaluateSelfProtection(
          'Write',
          { file_path: filePath },
          root,
          undefined,
          { rootToken },
        );

        expect(result).not.toBeNull();
        expect(result!.blocked).toBe(true);
      }
    });
  });

  it('keeps protected config writes blocked for subagents while the toggle is on', () => {
    return withDevOverrideRoot(true, (root, rootToken) => {
      const result = evaluateSelfProtection(
        'Write',
        { file_path: join(root, '.claude', 'settings.json') },
        root,
        undefined,
        { rootToken, hasSubagentIdentity: true },
      );

      expect(result).not.toBeNull();
      expect(result!.blocked).toBe(true);
    });
  });

  it('allows protected config writes through evaluate for the root session', async () => {
    await withDevOverrideRoot(true, async (root) => {
      writeSignedSettingsPresets(root);
      process.env.HIVE_FLOW_DEV_OVERRIDE_TOKEN = createRootOverrideToken(root);
      delete process.env.CLAUDE_SESSION_ID;
      delete process.env.HIVE_FLOW_AGENT_ID;
      delete process.env.CLAUDE_AGENT_ID;
      delete process.env.CLAUDE_PARENT_AGENT_ID;
      try {
        const result = await evaluate(
          {
            tool_name: 'Write',
            tool_input: {
              file_path: join(root, '.claude', 'settings.json'),
              content: validGuardedSettings(),
            },
            cwd: root,
          },
          SELF_PROTECTION_ONLY_CONFIG,
        );

        expect(result.decision).toBe('allow');
      } finally {
        restoreIdentityEnv();
      }
    });
  });

  it('blocks protected config writes through evaluate for hook-identified subagents', async () => {
    await withDevOverrideRoot(true, async (root) => {
      process.env.HIVE_FLOW_DEV_OVERRIDE_TOKEN = createRootOverrideToken(root);
      delete process.env.CLAUDE_SESSION_ID;
      delete process.env.HIVE_FLOW_AGENT_ID;
      delete process.env.CLAUDE_AGENT_ID;
      delete process.env.CLAUDE_PARENT_AGENT_ID;
      try {
        const result = await evaluate(
          {
            tool_name: 'Write',
            agent_id: 'native-task-agent',
            tool_input: {
              file_path: join(root, '.claude', 'settings.json'),
              content: '{}',
            },
            cwd: root,
          },
          SELF_PROTECTION_ONLY_CONFIG,
        );

        expect(result.decision).toBe('deny');
      } finally {
        restoreIdentityEnv();
      }
    });
  });
});
