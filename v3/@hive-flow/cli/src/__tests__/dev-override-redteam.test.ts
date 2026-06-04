import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import fc from 'fast-check';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { createHmac } from 'node:crypto';
import { propertyRunsFromEnv } from './property-runs.js';

const require = createRequire(import.meta.url);
const PROPERTY_RUNS = propertyRunsFromEnv(100);
const here = dirname(fileURLToPath(import.meta.url));
const source = resolve(here, '../../../../../.claude/helpers/enforcement.cjs');
const settingsSource = resolve(here, '../../../../../.claude/settings.json');
const root = realpathSync(mkdtempSync(join(tmpdir(), 'hive-flow-dev-override-redteam-')));
const helperPath = join(root, '.claude', 'helpers', 'enforcement.cjs');
mkdirSync(dirname(helperPath), { recursive: true });
copyFileSync(source, helperPath);
mkdirSync(join(root, '.claude'), { recursive: true });
copyFileSync(settingsSource, join(root, '.claude', 'settings.json'));

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let enf: any;

function resetModule(): void {
  delete require.cache[require.resolve(helperPath)];
  enf = require(helperPath);
}

function clearIdentityEnv(): void {
  delete process.env.AGENTIC_FLOW_AGENT_ID;
  delete process.env.CLAUDE_AGENT_ID;
  delete process.env.CLAUDE_SESSION_ID;
  delete process.env.CLAUDE_PARENT_AGENT_ID;
  delete process.env.HIVE_FLOW_AGENT_TOKEN;
  delete process.env.HIVE_FLOW_HIVE_ID;
  delete process.env.HIVE_FLOW_DEV_OVERRIDE_TOKEN;
}

function enableDevOverride(): void {
  const overridePath = join(root, '.hive-flow', 'enforcement', 'dev-override.conf');
  mkdirSync(dirname(overridePath), { recursive: true });
  writeFileSync(overridePath, 'HIVE_FLOW_DEV_OVERRIDE=on\n');
}

function createRootOverrideToken(nonce = 'dev-override-redteam'): string {
  const key = enf.getOrCreateHmacKey();
  const body = Buffer.from(JSON.stringify({
    kind: 'hive-flow-dev-override-root',
    projectDir: root,
    issuedAt: Date.now(),
    expiresAt: Date.now() + 60_000,
    nonce,
  })).toString('base64url');
  const hmac = createHmac('sha256', key).update(body).digest('hex');
  return `${body}.${hmac}`;
}

function issueRootOverrideToken(): void {
  process.env.HIVE_FLOW_DEV_OVERRIDE_TOKEN = createRootOverrideToken();
}

function writeRootOverrideTokenToConfig(): void {
  const overridePath = join(root, '.hive-flow', 'enforcement', 'dev-override.conf');
  writeFileSync(overridePath, `HIVE_FLOW_DEV_OVERRIDE=on\nHIVE_FLOW_DEV_OVERRIDE_TOKEN=${createRootOverrideToken('dev-override-config-token')}\n`);
}

function resetRootOverrideState(): void {
  clearIdentityEnv();
  resetModule();
  rmSync(join(root, '.hive-flow', 'enforcement'), { recursive: true, force: true });
  mkdirSync(join(root, '.hive-flow', 'enforcement'), { recursive: true });
  enableDevOverride();
  issueRootOverrideToken();
}

describe('dev override self-red-team probes', () => {
  beforeEach(() => {
    resetRootOverrideState();
  });

  afterAll(() => {
    clearIdentityEnv();
    rmSync(root, { recursive: true, force: true });
  });

  it('does not let a hook agent_id ride the root session override', () => {
    for (const field of ['agent_id', 'agentId']) {
      const result = enf.processPreToolUse({
        tool_name: 'Write',
        [field]: 'native-task-agent',
        tool_input: { file_path: '.claude/settings.json' },
      });

      expect(result.hookSpecificOutput.permissionDecision).toBe('deny');
      expect(result.hookSpecificOutput.permissionDecisionReason).toContain('protected path');
    }
  });

  it('does not let agent environment identities ride the root session override', () => {
    for (const envName of ['AGENTIC_FLOW_AGENT_ID', 'CLAUDE_AGENT_ID'] as const) {
      process.env[envName] = `${envName.toLowerCase()}-worker`;
      const result = enf.processPreToolUse({
        tool_name: 'Write',
        tool_input: { file_path: '.claude/settings.json' },
      });

      expect(result.hookSpecificOutput.permissionDecision).toBe('deny');
      expect(result.hookSpecificOutput.permissionDecisionReason).toContain('protected path');
      delete process.env[envName];
    }
  });

  it('does not enable the override when the toggle is absent or commented out', () => {
    rmSync(join(root, '.hive-flow', 'enforcement'), { recursive: true, force: true });
    mkdirSync(join(root, '.hive-flow', 'enforcement'), { recursive: true });
    writeFileSync(join(root, '.hive-flow', 'enforcement', 'dev-override.conf'), '# HIVE_FLOW_DEV_OVERRIDE=on\n');

    const result = enf.processPreToolUse({
      tool_name: 'Write',
      tool_input: { file_path: '.claude/settings.json' },
    });

    expect(result.hookSpecificOutput.permissionDecision).toBe('deny');
    expect(result.hookSpecificOutput.permissionDecisionReason).toContain('protected path');
  });

  it('does not enable the override from the toggle alone without a signed root token', () => {
    delete process.env.HIVE_FLOW_DEV_OVERRIDE_TOKEN;

    const result = enf.processPreToolUse({
      tool_name: 'Write',
      tool_input: { file_path: '.claude/settings.json' },
    });

    expect(result.hookSpecificOutput.permissionDecision).toBe('deny');
    expect(result.hookSpecificOutput.permissionDecisionReason).toContain('protected path');
  });

  it('does not let a parent-agent marked session use the root override', () => {
    process.env.CLAUDE_PARENT_AGENT_ID = 'parent-agent';

    const result = enf.processPreToolUse({
      tool_name: 'Write',
      tool_input: { file_path: '.claude/settings.json' },
    });

    expect(result.hookSpecificOutput.permissionDecision).toBe('deny');
    expect(result.hookSpecificOutput.permissionDecisionReason).toContain('protected path');
  });

  it('allows the signed root session to edit .git/info/exclude while the override is active', () => {
    const result = enf.processPreToolUse({
      tool_name: 'Write',
      tool_input: { file_path: '.git/info/exclude' },
    });

    expect(result).toEqual({});
  });

  it('allows a signed root token from dev-override.conf without session env', () => {
    delete process.env.HIVE_FLOW_DEV_OVERRIDE_TOKEN;
    writeRootOverrideTokenToConfig();

    const result = enf.processPreToolUse({
      tool_name: 'Write',
      tool_input: { file_path: '.git/info/exclude' },
    });

    expect(result).toEqual({});
  });

  it('does not allow source-side protected renames under the root override', () => {
    for (const toolName of [
      'mcp__filesystem__move_file',
      'mcp__filesystem__rename_file',
      'mcp__filesystem__copy_file',
    ]) {
      const result = enf.processPreToolUse({
        tool_name: toolName,
        tool_input: {
          source: '.claude/settings.json',
          destination: 'tmp/settings.json',
        },
      });

      expect(result.hookSpecificOutput.permissionDecision).toBe('deny');
      expect(result.hookSpecificOutput.permissionDecisionReason).toContain('FROM protected path');
    }
  });

  it('does not allow generated MCP destination aliases to target floor paths under the root override', () => {
    const destinationField = fc.constantFrom('destination', 'dest', 'target');
    const toolName = fc.constantFrom(
      'mcp__filesystem__move_file',
      'mcp__filesystem__rename_file',
      'mcp__filesystem__copy_file',
    );
    const protectedTarget = fc.constantFrom(
      '.hive-flow/enforcement/state.json',
      '.hive-flow/enforcement/dev-override.conf',
      '.claude/helpers/enforcement.cjs',
      '.claude/helpers/role-enforcement.cjs',
      '.claude/helpers/hook-handler.cjs',
    );

    fc.assert(
      fc.property(destinationField, toolName, protectedTarget, (field, tool, target) => {
        resetRootOverrideState();

        const result = enf.processPreToolUse({
          tool_name: tool,
          tool_input: {
            source: 'tmp/source.json',
            [field]: target,
          },
        });

        expect(result.hookSpecificOutput.permissionDecision).toBe('deny');
        expect(result.hookSpecificOutput.permissionDecisionReason).toContain('protected path');
      }),
      { seed: 20_631, numRuns: PROPERTY_RUNS },
    );
  });

  it('does not allow destination aliases to target floor paths under the root override', () => {
    for (const destinationField of ['destination', 'dest', 'target']) {
      resetRootOverrideState();
      const result = enf.processPreToolUse({
        tool_name: 'mcp__filesystem__rename_file',
        tool_input: {
          source: 'tmp/state.json',
          [destinationField]: '.hive-flow/enforcement/state.json',
        },
      });

      expect(result.hookSpecificOutput.permissionDecision).toBe('deny');
      expect(result.hookSpecificOutput.permissionDecisionReason).toContain('protected path');
    }
  });

  it('allows Bash redirects to grantable config paths but not floor paths', () => {
    const settingsWrite = enf.processPreToolUse({
      tool_name: 'Bash',
      tool_input: { command: 'printf "{}" > .claude/settings.json' },
    });
    expect(settingsWrite).toEqual({});

    const coreWrite = enf.processPreToolUse({
      tool_name: 'Bash',
      tool_input: { command: 'printf "x" > .claude/helpers/enforcement.cjs' },
    });
    expect(coreWrite.hookSpecificOutput.permissionDecision).toBe('deny');
    expect(coreWrite.hookSpecificOutput.permissionDecisionReason).toContain('protected path');
  });

  it('does not allow HMAC-key reads under the root override', () => {
    const result = enf.processPreToolUse({
      tool_name: 'mcp__filesystem__read_text_file',
      tool_input: { path: '.hive-flow/enforcement/.hmac-key' },
    });

    expect(result.hookSpecificOutput.permissionDecision).toBe('deny');
    expect(result.hookSpecificOutput.permissionDecisionReason).toContain('HMAC key');
  });

  it('does not allow the root override to edit the override toggle itself', () => {
    const result = enf.processPreToolUse({
      tool_name: 'Write',
      tool_input: { file_path: '.hive-flow/enforcement/dev-override.conf' },
    });

    expect(result.hookSpecificOutput.permissionDecision).toBe('deny');
    expect(result.hookSpecificOutput.permissionDecisionReason).toContain('protected path');
  });

  it('does not allow the root override to edit scoped signing state files', () => {
    for (const filePath of [
      '.hive-flow/enforcement/agents/worker/role.json',
      '.hive-flow/enforcement/sessions/session/state.json',
      '.hive-flow/enforcement/hives/hive/state.json',
      '.hive-flow/enforcement/projects/project/state.json',
    ]) {
      const result = enf.processPreToolUse({
        tool_name: 'Write',
        tool_input: { file_path: filePath },
      });

      expect(result.hookSpecificOutput.permissionDecision).toBe('deny');
      expect(result.hookSpecificOutput.permissionDecisionReason).toContain('protected path');
    }
  });

  it('does not classify reset-looking filenames as reset invocations', () => {
    const result = enf.processPreToolUse({
      tool_name: 'Bash',
      tool_input: { command: 'git add .claude/commands/reset-enforcement.md docs/enforcement-reset-notes.md' },
    });

    expect(result).toEqual({});
  });

  it('still blocks actual reset invocation attempts', () => {
    const result = enf.processPreToolUse({
      tool_name: 'Bash',
      tool_input: { command: 'node .claude/helpers/enforcement.cjs --reset' },
    });

    expect(result.hookSpecificOutput.permissionDecision).toBe('deny');
    expect(result.hookSpecificOutput.permissionDecisionReason).toContain('Attempted enforcement reset');
  });

  it('does not persist a forged signed state after denied probes', () => {
    const result = enf.processPreToolUse({
      tool_name: 'Write',
      tool_input: { file_path: '.hive-flow/enforcement/dev-override.conf' },
    });
    expect(result.hookSpecificOutput.permissionDecision).toBe('deny');

    const stateEnvelope = JSON.parse(readFileSync(enf.getStateFile(), 'utf8'));
    expect(enf.verifyState(stateEnvelope).valid).toBe(true);
  });
});
