import { describe, expect, it, afterAll, beforeEach } from 'vitest';
import fc from 'fast-check';
import { createRequire } from 'node:module';
import { copyFileSync, existsSync, mkdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdtempSync } from 'node:fs';
import { createHash, createHmac } from 'node:crypto';
import { propertyRunsFromEnv } from './property-runs.js';

const PROPERTY_RUNS = propertyRunsFromEnv(100);

const require = createRequire(import.meta.url);
const here = dirname(fileURLToPath(import.meta.url));
const source = resolve(here, '../../../../../.claude/helpers/enforcement.cjs');
const settingsSource = resolve(here, '../../../../../.claude/settings.json');
const policySource = resolve(here, '../permission-guard/protected-paths.cjs');
const policyJsonSource = resolve(here, '../permission-guard/protected-paths.policy.json');
const root = realpathSync(mkdtempSync(join(tmpdir(), 'hive-flow-enforcement-security-')));
const helperPath = join(root, '.claude', 'helpers', 'enforcement.cjs');
mkdirSync(dirname(helperPath), { recursive: true });
copyFileSync(source, helperPath);
const policyPath = join(root, 'v3', '@hive-flow', 'cli', 'src', 'permission-guard', 'protected-paths.cjs');
mkdirSync(dirname(policyPath), { recursive: true });
copyFileSync(policySource, policyPath);
copyFileSync(policyJsonSource, join(dirname(policyPath), 'protected-paths.policy.json'));
mkdirSync(join(root, '.claude'), { recursive: true });
copyFileSync(settingsSource, join(root, '.claude', 'settings.json'));

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let enf: any;

function resetModule(): void {
  delete require.cache[require.resolve(helperPath)];
  enf = require(helperPath);
}

function statePath(): string {
  return enf.getStateFile();
}

function scopedStatePath(scopeType: string, scopeId: string): string {
  return join(root, '.hive-flow', 'enforcement', `${scopeType}s`, scopeId, 'state.json');
}

function rolePath(agentId: string): string {
  return join(root, '.hive-flow', 'enforcement', 'agents', agentId, 'role.json');
}

function readScopedState(scopeType: string, scopeId: string): Record<string, unknown> | null {
  const file = scopeType === 'global' ? statePath() : scopedStatePath(scopeType, scopeId);
  try {
    return JSON.parse(readFileSync(file, 'utf8')).state;
  } catch {
    return null;
  }
}

function writeScopedState(scopeType: string, scopeId: string, state: Record<string, unknown>): void {
  const file = scopeType === 'global' ? statePath() : scopedStatePath(scopeType, scopeId);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify(enf.signState({
    consecutiveDenials: 0,
    lastActivity: new Date(0).toISOString(),
    history: [],
    resetAt: null,
    integrityCompromised: false,
    ...state,
  })));
}

function clearAgentEnv(): void {
  delete process.env.AGENTIC_FLOW_AGENT_ID;
  delete process.env.CLAUDE_AGENT_ID;
  delete process.env.CLAUDE_SESSION_ID;
  delete process.env.HIVE_FLOW_AGENT_TOKEN;
  delete process.env.HIVE_FLOW_HIVE_ID;
  delete process.env.CLAUDE_PARENT_AGENT_ID;
  delete process.env.HIVE_FLOW_DEV_OVERRIDE_TOKEN;
}

function enableDevOverride(): void {
  const overridePath = join(root, '.hive-flow', 'enforcement', 'dev-override.conf');
  mkdirSync(dirname(overridePath), { recursive: true });
  writeFileSync(overridePath, 'HIVE_FLOW_DEV_OVERRIDE=on\n');
}

function createRootOverrideToken(nonce = 'enforcement-security-property'): string {
  const key = enf.getOrCreateHmacKey();
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
    nonce,
  })).toString('base64url');
  const hmac = createHmac('sha256', key).update(body).digest('hex');
  return `${body}.${hmac}`;
}

function createRootOverrideTokenFromClaims(claims: Record<string, unknown>, signingKey = enf.getOrCreateHmacKey()): string {
  const body = Buffer.from(JSON.stringify(claims)).toString('base64url');
  const hmac = createHmac('sha256', signingKey).update(body).digest('hex');
  return `${body}.${hmac}`;
}

function issueRootOverrideToken(): void {
  process.env.HIVE_FLOW_DEV_OVERRIDE_TOKEN = createRootOverrideToken();
}

function writeRootOverrideTokenToConfig(): void {
  const overridePath = join(root, '.hive-flow', 'enforcement', 'dev-override.conf');
  mkdirSync(dirname(overridePath), { recursive: true });
  writeFileSync(overridePath, `HIVE_FLOW_DEV_OVERRIDE=on\nHIVE_FLOW_DEV_OVERRIDE_TOKEN=${createRootOverrideToken('enforcement-config-token')}\n`);
}

const SETTINGS_PRESET_ENTRIES = [
  {
    event: 'PreToolUse',
    matcher: 'Bash|Write|Edit|MultiEdit',
    command: 'node "$CLAUDE_PROJECT_DIR"/.claude/helpers/hook-handler.cjs permission-guard',
    timeout: 5000,
  },
  {
    event: 'PostToolUse',
    matcher: 'Write|Edit|MultiEdit',
    command: 'node "$CLAUDE_PROJECT_DIR"/.claude/helpers/settings-reconciler.cjs',
    timeout: 5000,
  },
];

const SETTINGS_BASELINE_ALLOW = ['mcp__hive-flow__*'];
type SettingsMutation = 'valid' | 'drop-preset' | 'disable-all' | 'allow-widen' | 'bare-governance-allow' | 'junk';

function writeSignedSettingsPresets(): void {
  const presetsPath = join(root, '.hive-flow', 'enforcement', 'settings-presets.json');
  mkdirSync(dirname(presetsPath), { recursive: true });
  writeFileSync(presetsPath, JSON.stringify(enf.signState({
    version: 2,
    entries: SETTINGS_PRESET_ENTRIES,
    baselineAllow: SETTINGS_BASELINE_ALLOW,
  })));
}

function settingsContent(mutation: SettingsMutation): string {
  if (mutation === 'junk') return '{"hooks":';
  const entries = mutation === 'drop-preset'
    ? SETTINGS_PRESET_ENTRIES.slice(1)
    : SETTINGS_PRESET_ENTRIES;
  const settings: Record<string, unknown> = {
    hooks: {},
    permissions: { allow: [...SETTINGS_BASELINE_ALLOW] },
  };
  for (const entry of entries) {
    const hooks = settings.hooks as Record<string, Array<Record<string, unknown>>>;
    hooks[entry.event] = hooks[entry.event] || [];
    hooks[entry.event].push({
      matcher: entry.matcher,
      hooks: [{ type: 'command', command: entry.command, timeout: entry.timeout }],
    });
  }
  if (mutation === 'disable-all') settings.disableAllHooks = true;
  if (mutation === 'allow-widen') {
    settings.permissions = { allow: [...SETTINGS_BASELINE_ALLOW, 'Write(.claude/settings.json)'] };
  }
  if (mutation === 'bare-governance-allow') {
    settings.permissions = { allow: [...SETTINGS_BASELINE_ALLOW, 'v3/@hive-flow/cli/src/permission-guard/gate.ts'] };
  }
  return JSON.stringify(settings);
}

function prepareSignedOverrideSettings(filePath = '.claude/settings.json'): void {
  clearAgentEnv();
  resetModule();
  rmSync(join(root, '.hive-flow', 'enforcement'), { recursive: true, force: true });
  enableDevOverride();
  issueRootOverrideToken();
  writeSignedSettingsPresets();
  const absolute = join(root, filePath);
  mkdirSync(dirname(absolute), { recursive: true });
  writeFileSync(absolute, settingsContent('valid'));
}

function baseRootOverrideClaims(nowMs = Date.now()): Record<string, unknown> {
  const key = enf.getOrCreateHmacKey();
  const keyId = createHash('sha256')
    .update('hive-flow-dev-override-key-id\0')
    .update(key)
    .digest('hex')
    .slice(0, 16);
  return {
    kind: 'hive-flow-dev-override-root',
    version: 1,
    keyId,
    projectDir: root,
    issuedAt: nowMs,
    expiresAt: nowMs + 60_000,
    nonce: `nonce-${nowMs}`,
  };
}

describe('enforcement security property contracts', () => {
  beforeEach(() => {
    clearAgentEnv();
    resetModule();
    rmSync(join(root, '.hive-flow', 'enforcement'), { recursive: true, force: true });
    mkdirSync(dirname(statePath()), { recursive: true });
  });

  afterAll(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it('recovers tampered signed state at WARNED minimum for arbitrary prior levels', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: 3 }),
        fc.integer({ min: 0, max: 50 }),
        fc.array(fc.string({ maxLength: 24 }), { maxLength: 5 }),
        (level, violations, restrictedGroups) => {
          resetModule();
          rmSync(join(root, '.hive-flow', 'enforcement'), { recursive: true, force: true });
          mkdirSync(dirname(statePath()), { recursive: true });
          const state = {
            level,
            violations,
            consecutiveDenials: 0,
            lastActivity: new Date(0).toISOString(),
            restrictedGroups,
            history: [],
            resetAt: null,
            integrityCompromised: false,
          };
          const envelope = enf.signState(state);
          envelope.hmac = `${envelope.hmac.slice(1)}0`;
          writeFileSync(statePath(), JSON.stringify(envelope));

          const recovered = enf.getState();
          expect(recovered.level).toBeGreaterThanOrEqual(enf.LEVELS.WARNED);
          expect(recovered.integrityCompromised).toBe(true);
          expect(recovered.violations).toBeGreaterThanOrEqual(1);

          const rewritten = JSON.parse(readFileSync(statePath(), 'utf8'));
          expect(enf.verifyState(rewritten).valid).toBe(true);
        },
      ),
      { seed: 20_621, numRuns: PROPERTY_RUNS },
    );
  });

  it('treats generated protected write destinations as circumvention', () => {
    const protectedLeaves = fc.constantFrom(
      '.claude/settings.json',
      '.claude/settings.local.json',
      '.claude/helpers/enforcement.cjs',
      '.claude/helpers/role-enforcement.cjs',
      '.hive-flow/enforcement/state.json',
      'v3/@hive-flow/cli/src/permission-guard/gate.ts',
      'v3/@hive-flow/cli/dist/src/mcp-tools/index.js',
      'scripts/permission-guard-setup.mjs',
    );
    const toolName = fc.constantFrom(
      'Write',
      'Edit',
      'MultiEdit',
      'NotebookEdit',
      'mcp__filesystem__write_file',
      'mcp__filesystem__move_file',
      'mcp__filesystem__rename_file',
      'mcp__filesystem__copy_file',
      'mcp__filesystem__delete_file',
    );

    fc.assert(
      fc.property(protectedLeaves, toolName, (leaf, tool) => {
        const input = tool === 'mcp__filesystem__move_file' || tool === 'mcp__filesystem__rename_file' || tool === 'mcp__filesystem__copy_file'
          ? { source: 'tmp.txt', destination: leaf }
          : tool === 'NotebookEdit'
            ? { notebook_path: leaf, file_path: leaf, path: leaf }
            : { file_path: leaf, path: leaf };
        const result = enf.detectCircumvention(tool, input, {
          level: 0,
          violations: 0,
          restrictedGroups: [],
          history: [],
          integrityCompromised: false,
        });
        expect(result.circumvention).toBe(true);
      }),
      { seed: 20_622, numRuns: PROPERTY_RUNS },
    );
  });

  it('treats protected MCP rename/copy sources as circumvention', () => {
    const state = {
      level: 0,
      violations: 0,
      restrictedGroups: [],
      history: [],
      integrityCompromised: false,
    };

    for (const toolName of ['mcp__filesystem__rename_file', 'mcp__filesystem__copy_file']) {
      const result = enf.detectCircumvention(toolName, {
        source: 'v3/@hive-flow/cli/src/permission-guard/gate.ts',
        destination: 'tmp/gate.ts',
      }, state);

      expect(result.circumvention).toBe(true);
    }
  });

  it('treats protected read-policy targets as circumvention', () => {
    const state = {
      level: 0,
      violations: 0,
      restrictedGroups: [],
      history: [],
      integrityCompromised: false,
    };

    for (const filePath of [
      '.hive-flow/enforcement/.hmac-key',
      '.HIVE-FLOW/enforcement/.hmac-key',
      '.hive-flow/ENFORCEMENT/.hmac-key',
      '.hive-flow/enforcement/state.json',
      '.env',
      '.claude/settings.json',
      '.claude/settings.local.json',
    ]) {
      for (const toolName of [
        'Read',
        'mcp__filesystem__read_file',
        'mcp__filesystem__read_text_file',
        'mcp__filesystem__read_media_file',
      ]) {
        const result = enf.detectCircumvention(toolName, {
          file_path: filePath,
          path: filePath,
        }, state);

        expect(result.circumvention, `${toolName} ${filePath}`).toBe(true);
      }
    }

    expect(enf.detectCircumvention('mcp__filesystem__read_multiple_files', {
      paths: ['src/app.ts', '.claude/settings.local.json'],
    }, state).circumvention).toBe(true);
  });

  it('does not classify normal hive data writes as protected path circumvention', () => {
    expect(enf.isProtectedPath(join(root, '.hive-flow', 'data', 'watcher-hive.json'))).toBe(false);
    expect(enf.isProtectedPath(join(root, '.hive-flow', 'data', 'hive.done'))).toBe(false);
    expect(enf.isGlobalProtectedPath(join(root, '.claude', 'helpers', 'enforcement.cjs'))).toBe(true);
  });

  it('matches protected paths on path boundaries rather than raw prefixes', () => {
    expect(enf.isProtectedPath(join(root, '.claude', 'settings.json'))).toBe(true);
    expect(enf.isProtectedPath(join(root, '.CLAUDE', 'settings.json'))).toBe(true);
    expect(enf.isProtectedPath(join(root, '.claude', 'settings.local.json'))).toBe(true);
    expect(enf.isProtectedPath(join(root, '.CLAUDE', 'settings.LOCAL.json'))).toBe(true);
    expect(enf.isProtectedPath(join(root, '.claude', 'settings.json.bak'))).toBe(false);
    expect(enf.isProtectedPath(join(root, '.claude', 'settings.local.json.bak'))).toBe(false);
    expect(enf.isProtectedPath(join(root, '.claude', 'settings.json.d', 'note.md'))).toBe(false);

    expect(enf.isProtectedPath(join(root, '.claude', 'helpers'))).toBe(true);
    expect(enf.isProtectedPath(join(root, '.claude', 'helpers', 'enforcement.cjs'))).toBe(true);
    expect(enf.isProtectedPath(join(root, '.CLAUDE', 'HELPERS', 'enforcement.cjs'))).toBe(true);
    expect(enf.isProtectedPath(join(root, '.claude', 'helpers-old', 'enforcement.cjs'))).toBe(false);

    expect(enf.isProtectedPath(join(root, '.hive-flow', 'workflows'))).toBe(true);
    expect(enf.isProtectedPath(join(root, '.hive-flow', 'workflows', 'state.json'))).toBe(true);
    expect(enf.isProtectedPath(join(root, '.HIVE-FLOW', 'WORKFLOWS', 'state.json'))).toBe(true);
    expect(enf.isProtectedPath(join(root, '.hive-flow', 'workflows-old', 'state.json'))).toBe(false);

    expect(enf.isProtectedPath(join(root, 'v3', '@hive-flow', 'cli', 'src', 'permission-guard', 'gate.ts'))).toBe(true);
    expect(enf.isProtectedPath(join(root, 'v3', '@hive-flow', 'cli', 'src', 'PERMISSION-GUARD', 'gate.ts'))).toBe(true);
    expect(enf.isProtectedPath(join(root, 'scripts', 'permission-guard-setup.mjs'))).toBe(true);
    expect(enf.isProtectedPath(join(process.env.HOME || '/tmp', '.hive-flow', 'permission-guard', 'config.json'))).toBe(true);
  });

  it('denies ordinary agent protected-workflow writes without escalation', () => {
    process.env.AGENTIC_FLOW_AGENT_ID = 'agent-a';

    const result = enf.processPreToolUse({
      tool_name: 'Write',
      tool_input: { file_path: '.hive-flow/workflows/state.json' },
    });

    expect(result.hookSpecificOutput.hookEventName).toBe('PreToolUse');
    expect(result.hookSpecificOutput.permissionDecision).toBe('deny');
    expect(result.hookSpecificOutput.permissionDecisionReason).toContain('Use the gated project workflow');
    expect(readScopedState('agent', 'agent-a')?.level).not.toBe(enf.LEVELS.RESTRICTED);
    expect(readScopedState('global', 'global')).toBeNull();
  });

  it('denies native Task protected-workflow writes without poisoning session/global scopes', () => {
    process.env.CLAUDE_SESSION_ID = 'coordinator-session';

    const result = enf.processPreToolUse({
      hook_event_name: 'PreToolUse',
      agent_id: 'native-task-agent',
      session_id: 'coordinator-session',
      tool_name: 'Write',
      tool_input: { file_path: '.hive-flow/workflows/native-state.json' },
    });

    expect(enf.getAgentId({ agent_id: 'native-task-agent' })).toBe('native-task-agent');
    expect(result.hookSpecificOutput.hookEventName).toBe('PreToolUse');
    expect(result.hookSpecificOutput.permissionDecision).toBe('deny');
    expect(result.hookSpecificOutput.permissionDecisionReason).toContain('Use the gated project workflow');
    expect(readScopedState('agent', 'native-task-agent')?.level).not.toBe(enf.LEVELS.RESTRICTED);
    expect(readScopedState('agent', 'coordinator-session')).toBeNull();
    expect(readScopedState('global', 'global')).toBeNull();
  });

  it('scopes unknown ordinary violations to project state instead of global', () => {
    process.env.CLAUDE_SESSION_ID = 'coordinator-session-only';

    const result = enf.processPreToolUse({
      tool_name: 'Bash',
      tool_input: { command: "bash -c 'eval $(echo echo hi)'" },
    });

    const projectId = enf.resolveScopeContext().projectId;
    expect(result.hookSpecificOutput.hookEventName).toBe('PreToolUse');
    expect(result.hookSpecificOutput.permissionDecision).toBe('deny');
    expect(enf.getAgentId({})).toBeNull();
    expect(readScopedState('project', projectId)?.level).toBe(enf.LEVELS.WARNED);
    expect(readScopedState('agent', 'coordinator-session-only')).toBeNull();
    expect(readScopedState('global', 'global')).toBeNull();
  });

  it('still escalates coordinator enforcement-file attacks globally', () => {
    const result = enf.processPreToolUse({
      tool_name: 'Write',
      tool_input: { file_path: '.claude/helpers/enforcement.cjs' },
    });

    expect(result.hookSpecificOutput.hookEventName).toBe('PreToolUse');
    expect(result.hookSpecificOutput.permissionDecision).toBe('deny');
    expect(readScopedState('global', 'global')?.level).toBe(enf.LEVELS.RESTRICTED);
  });

  it('keeps subagent enforcement-file attacks denied and scoped to the offending agent', () => {
    process.env.AGENTIC_FLOW_AGENT_ID = 'agent-b';

    const result = enf.processPreToolUse({
      tool_name: 'Write',
      tool_input: { file_path: '.claude/helpers/enforcement.cjs' },
    });

    expect(result.hookSpecificOutput.hookEventName).toBe('PreToolUse');
    expect(result.hookSpecificOutput.permissionDecision).toBe('deny');
    expect(readScopedState('agent', 'agent-b')?.level).toBe(enf.LEVELS.RESTRICTED);
    expect(readScopedState('global', 'global')).toBeNull();
  });

  it('escalates non-substrate global protected writes while leaving project protected workflows deny-only', () => {
    const globalProtectedTargets = [
      'v3/@hive-flow/cli/src/permission-guard/gate.ts',
      'v3/@hive-flow/cli/dist/src/mcp-tools/index.js',
      'scripts/install-enforcement.mjs',
      '.env',
    ];

    for (const [index, filePath] of globalProtectedTargets.entries()) {
      clearAgentEnv();
      resetModule();
      rmSync(join(root, '.hive-flow', 'enforcement'), { recursive: true, force: true });
      const agentId = `global-protected-agent-${index}`;
      process.env.AGENTIC_FLOW_AGENT_ID = agentId;

      const result = enf.processPreToolUse({
        tool_name: 'Write',
        tool_input: { file_path: filePath },
      });

      expect(result.hookSpecificOutput.permissionDecision, filePath).toBe('deny');
      expect(readScopedState('agent', agentId)?.level, filePath).toBe(enf.LEVELS.RESTRICTED);
      expect(readScopedState('global', 'global'), filePath).toBeNull();
    }

    clearAgentEnv();
    resetModule();
    rmSync(join(root, '.hive-flow', 'enforcement'), { recursive: true, force: true });
    process.env.AGENTIC_FLOW_AGENT_ID = 'project-workflow-agent';

    const workflowResult = enf.processPreToolUse({
      tool_name: 'Write',
      tool_input: { file_path: '.hive-flow/workflows/state.json' },
    });

    expect(workflowResult.hookSpecificOutput.permissionDecision).toBe('deny');
    expect(readScopedState('agent', 'project-workflow-agent')).toBeNull();
    expect(readScopedState('global', 'global')).toBeNull();
  });

  it('E2E: RESTRICTED scoped state blocks write tools before execution', () => {
    process.env.AGENTIC_FLOW_AGENT_ID = 'restricted-agent';
    writeScopedState('agent', 'restricted-agent', {
      level: enf.LEVELS.RESTRICTED,
      violations: 2,
      restrictedGroups: ['write'],
    });

    const result = enf.processPreToolUse({
      tool_name: 'Write',
      tool_input: { file_path: 'src/generated.ts' },
    });

    expect(result.hookSpecificOutput.hookEventName).toBe('PreToolUse');
    expect(result.hookSpecificOutput.permissionDecision).toBe('deny');
    expect(result.hookSpecificOutput.permissionDecisionReason).toContain('[ENFORCEMENT RESTRICTED');
    expect(result.hookSpecificOutput.permissionDecisionReason).toContain("Tool 'Write' blocked");
  });

  it('E2E: HALTED global state blocks hive-flow agent spawn before execution', () => {
    writeScopedState('global', 'global', {
      level: enf.LEVELS.HALTED,
      violations: 4,
      restrictedGroups: ['exec', 'write'],
    });

    const result = enf.processPreToolUse({
      tool_name: 'mcp__hive-flow__agent_spawn',
      tool_input: { agentType: 'coder', name: 'blocked-worker' },
    });

    expect(result.hookSpecificOutput.hookEventName).toBe('PreToolUse');
    expect(result.hookSpecificOutput.permissionDecision).toBe('deny');
    expect(result.hookSpecificOutput.permissionDecisionReason).toContain('[ENFORCEMENT HALT');
    expect(result.hookSpecificOutput.permissionDecisionReason).toContain('All tools blocked');
  });

  it('E2E: subagent reset-term grep does not escalate and leaves coordinator benign writes allowed', () => {
    process.env.AGENTIC_FLOW_AGENT_ID = 'grep-worker';

    const agentTrip = enf.processPreToolUse({
      tool_name: 'Bash',
      tool_input: { command: "grep 'enforcement-reset' v3/docs/design/ENFORCEMENT-OVERBLOCK-HANDOFF.md" },
    });

    expect(agentTrip).toEqual({});
    expect(readScopedState('agent', 'grep-worker')?.level).not.toBe(enf.LEVELS.RESTRICTED);
    expect(readScopedState('global', 'global')).toBeNull();

    clearAgentEnv();
    const coordinatorWrite = enf.processPreToolUse({
      tool_name: 'Write',
      tool_input: { file_path: 'v3/docs/design/overblock-followup.md' },
    });

    expect(coordinatorWrite).toEqual({});
  });

  it('E2E: RESTRICTED coordinator write gate is path-aware', () => {
    writeScopedState('global', 'global', {
      level: enf.LEVELS.RESTRICTED,
      violations: 2,
      restrictedGroups: ['write'],
    });

    expect(enf.processPreToolUse({
      tool_name: 'Write',
      tool_input: { file_path: 'v3/docs/design/benign-plan.md' },
    })).toEqual({});

    const outOfProjectWrite = enf.processPreToolUse({
      tool_name: 'Write',
      tool_input: { file_path: join(tmpdir(), 'hive-flow-overblock-outside.md') },
    });
    expect(outOfProjectWrite.hookSpecificOutput.permissionDecision).toBe('deny');
    expect(outOfProjectWrite.hookSpecificOutput.permissionDecisionReason).toContain('outside project');

    const protectedWrite = enf.processPreToolUse({
      tool_name: 'Write',
      tool_input: { file_path: '.claude/settings.json' },
    });
    expect(protectedWrite.hookSpecificOutput.permissionDecision).toBe('deny');
    expect(protectedWrite.hookSpecificOutput.permissionDecisionReason).toMatch(/protected path|CIRCUMVENTION/);
  });

  it('E2E: RESTRICTED offending agent remains fail-closed for writes', () => {
    process.env.AGENTIC_FLOW_AGENT_ID = 'restricted-writer';
    writeScopedState('agent', 'restricted-writer', {
      level: enf.LEVELS.RESTRICTED,
      violations: 2,
      restrictedGroups: ['write'],
    });

    const result = enf.processPreToolUse({
      tool_name: 'Write',
      tool_input: { file_path: 'v3/docs/design/agent-owned-note.md' },
    });

    expect(result.hookSpecificOutput.permissionDecision).toBe('deny');
    expect(result.hookSpecificOutput.permissionDecisionReason).toContain('[ENFORCEMENT RESTRICTED');
  });

  it('allows canonical hook invocations while restricted but blocks arbitrary scripts', () => {
    const restricted = { restrictedGroups: ['write'] };

    expect(enf.detectCircumvention(
      'Bash',
      { command: 'node "$CLAUDE_PROJECT_DIR"/.claude/helpers/hook-handler.cjs permission-guard' },
      restricted,
    ).circumvention).toBe(false);

    expect(enf.detectCircumvention(
      'Bash',
      { command: 'node ./random-script.js' },
      restricted,
    )).toMatchObject({ circumvention: true, denyOnly: true });

    expect(enf.detectCircumvention(
      'Bash',
      { command: 'node "$CLAUDE_PROJECT_DIR"/.claude/helpers/hook-handler.cjs permission-guard; node ./random-script.js' },
      restricted,
    )).toMatchObject({ circumvention: true, denyOnly: true });
  });

  it('allows verification-style script commands while write-restricted', () => {
    const restricted = { restrictedGroups: ['write'] };

    expect(enf.detectCircumvention(
      'Bash',
      { command: 'node --check .claude/helpers/enforcement.cjs' },
      restricted,
    ).circumvention).toBe(false);

    expect(enf.detectCircumvention(
      'Bash',
      { command: 'node --test v3/@hive-flow/cli/src/__tests__/enforcement-security-property.test.ts' },
      restricted,
    ).circumvention).toBe(false);
  });

  it('does not classify the signed reset hook path as Bash reset circumvention', () => {
    const state = {
      level: 0,
      violations: 0,
      restrictedGroups: [],
      history: [],
      integrityCompromised: false,
    };

    expect(enf.detectCircumvention(
      'Bash',
      { command: 'node "$CLAUDE_PROJECT_DIR"/.claude/helpers/hook-handler.cjs enforcement-reset-check' },
      state,
    ).circumvention).toBe(false);

    expect(enf.detectCircumvention(
      'Bash',
      { command: 'node .claude/helpers/hook-handler.cjs enforcement-reset-check --scope all' },
      state,
    ).circumvention).toBe(false);

    expect(enf.detectCircumvention(
      'Bash',
      { command: 'echo \'{"user_prompt":"/reset-enforcement"}\' | node .claude/helpers/hook-handler.cjs enforcement-reset-check' },
      state,
    ).circumvention).toBe(true);

    expect(enf.detectCircumvention(
      'Bash',
      { command: 'node .claude/helpers/hook-handler.cjs enforcement-reset-check < /tmp/reset.json' },
      state,
    ).circumvention).toBe(true);

    expect(enf.detectCircumvention(
      'Bash',
      { command: 'node .claude/helpers/enforcement.cjs --reset' },
      state,
    ).circumvention).toBe(true);
  });

  it('does not classify filenames containing reset-enforcement as reset invocations', () => {
    const state = {
      level: 0,
      violations: 0,
      restrictedGroups: [],
      history: [],
      integrityCompromised: false,
    };

    expect(enf.detectCircumvention(
      'Bash',
      { command: 'git add .claude/commands/reset-enforcement.md' },
      state,
    ).circumvention).toBe(false);

    expect(enf.detectCircumvention(
      'Bash',
      { command: 'git add docs/enforcement-reset-notes.md' },
      state,
    ).circumvention).toBe(false);

    expect(enf.detectCircumvention(
      'Bash',
      { command: "grep 'enforcement-reset' v3/docs/design" },
      state,
    ).circumvention).toBe(false);

    expect(enf.detectCircumvention(
      'Bash',
      { command: "rg 'install-enforcement.mjs' v3/docs/design" },
      state,
    ).circumvention).toBe(false);
  });

  it('denies protected config writes when only the dev override toggle is active', () => {
    enableDevOverride();

    const result = enf.processPreToolUse({
      tool_name: 'Write',
      tool_input: { file_path: '.claude/settings.json' },
    });

    expect(result.hookSpecificOutput.permissionDecision).toBe('deny');
    expect(result.hookSpecificOutput.permissionDecisionReason).toContain('protected path');
  });

  it('denies signed-root protected config writes when settings content is not verifiable', () => {
    enableDevOverride();
    issueRootOverrideToken();

    const result = enf.processPreToolUse({
      tool_name: 'Write',
      tool_input: { file_path: '.claude/settings.json' },
    });

    expect(result.hookSpecificOutput.permissionDecision).toBe('deny');
    expect(result.hookSpecificOutput.permissionDecisionReason).toContain('protected path');
  });

  it('denies signed-root protected config writes from override file when settings content is not verifiable', () => {
    writeRootOverrideTokenToConfig();

    const result = enf.processPreToolUse({
      tool_name: 'Write',
      tool_input: { file_path: '.claude/settings.json' },
    });

    expect(result.hookSpecificOutput.permissionDecision).toBe('deny');
    expect(result.hookSpecificOutput.permissionDecisionReason).toContain('protected path');
  });

  it('keeps subagent protected config writes blocked when dev override is active', () => {
    process.env.AGENTIC_FLOW_AGENT_ID = 'worker-agent';
    enableDevOverride();

    const result = enf.processPreToolUse({
      tool_name: 'Write',
      tool_input: { file_path: '.claude/settings.json' },
    });

    expect(result.hookSpecificOutput.permissionDecision).toBe('deny');
    expect(result.hookSpecificOutput.permissionDecisionReason).toContain('protected path');
  });

  it('keeps the dev override toggle and enforcement secret state above the grant', () => {
    enableDevOverride();
    issueRootOverrideToken();

    for (const filePath of [
      '.hive-flow/enforcement/dev-override.conf',
      '.hive-flow/enforcement/.hmac-key',
      '.hive-flow/enforcement/state.json',
      '.claude/helpers/enforcement.cjs',
    ]) {
      const result = enf.processPreToolUse({
        tool_name: 'Write',
        tool_input: { file_path: filePath },
      });

      expect(result.hookSpecificOutput.permissionDecision).toBe('deny');
      expect(result.hookSpecificOutput.permissionDecisionReason).toContain('CIRCUMVENTION');
    }

    const readKey = enf.processPreToolUse({
      tool_name: 'Read',
      tool_input: { file_path: '.hive-flow/enforcement/.hmac-key' },
    });

    expect(readKey.hookSpecificOutput.permissionDecision).toBe('deny');
    expect(readKey.hookSpecificOutput.permissionDecisionReason).toContain('protected enforcement');
  });

  it('allows settings writes under dev override iff projected content preserves the signed guard contract', () => {
    const target = fc.constantFrom('.claude/settings.json', '.claude/settings.local.json');
    const mutation = fc.constantFrom<SettingsMutation>(
      'valid',
      'drop-preset',
      'disable-all',
      'allow-widen',
      'bare-governance-allow',
      'junk',
    );

    fc.assert(
      fc.property(target, mutation, (filePath, mutationKind) => {
        clearAgentEnv();
        resetModule();
        rmSync(join(root, '.hive-flow', 'enforcement'), { recursive: true, force: true });
        enableDevOverride();
        issueRootOverrideToken();
        writeSignedSettingsPresets();

        const result = enf.processPreToolUse({
          tool_name: 'Write',
          tool_input: { file_path: filePath, content: settingsContent(mutationKind) },
        });

        if (mutationKind === 'valid') {
          expect(result).toEqual({});
        } else {
          expect(result.hookSpecificOutput.permissionDecision).toBe('deny');
          expect(result.hookSpecificOutput.permissionDecisionReason).toContain('protected path');
        }
      }),
      { seed: 20_641, numRuns: PROPERTY_RUNS },
    );
  });

  it('content-guards Edit projected settings including missing old_string', () => {
    const filePath = '.claude/settings.json';

    prepareSignedOverrideSettings(filePath);
    const valid = enf.processPreToolUse({
      tool_name: 'Edit',
      tool_input: {
        file_path: filePath,
        old_string: SETTINGS_BASELINE_ALLOW[0],
        new_string: SETTINGS_BASELINE_ALLOW[0],
      },
    });
    expect(valid).toEqual({});

    prepareSignedOverrideSettings(filePath);
    const allowWiden = enf.processPreToolUse({
      tool_name: 'Edit',
      tool_input: {
        file_path: filePath,
        old_string: SETTINGS_BASELINE_ALLOW[0],
        new_string: `${SETTINGS_BASELINE_ALLOW[0]}","Write(.claude/settings.json)`,
      },
    });
    expect(allowWiden.hookSpecificOutput.permissionDecision).toBe('deny');
    expect(allowWiden.hookSpecificOutput.permissionDecisionReason).toContain('protected path');

    prepareSignedOverrideSettings(filePath);
    const bareGovernanceAllow = enf.processPreToolUse({
      tool_name: 'Edit',
      tool_input: {
        file_path: filePath,
        old_string: SETTINGS_BASELINE_ALLOW[0],
        new_string: `${SETTINGS_BASELINE_ALLOW[0]}","v3/@hive-flow/cli/src/permission-guard/gate.ts`,
      },
    });
    expect(bareGovernanceAllow.hookSpecificOutput.permissionDecision).toBe('deny');
    expect(bareGovernanceAllow.hookSpecificOutput.permissionDecisionReason).toContain('protected path');

    prepareSignedOverrideSettings(filePath);
    const missingOldString = enf.processPreToolUse({
      tool_name: 'Edit',
      tool_input: {
        file_path: filePath,
        old_string: 'missing-signed-settings-substring',
        new_string: 'replacement',
      },
    });
    expect(missingOldString.hookSpecificOutput.permissionDecision).toBe('deny');
    expect(missingOldString.hookSpecificOutput.permissionDecisionReason).toContain('protected path');
  });

  it('content-guards MultiEdit projected settings including allow widening', () => {
    const filePath = '.claude/settings.local.json';

    prepareSignedOverrideSettings(filePath);
    const valid = enf.processPreToolUse({
      tool_name: 'MultiEdit',
      tool_input: {
        file_path: filePath,
        edits: [
          { old_string: SETTINGS_BASELINE_ALLOW[0], new_string: SETTINGS_BASELINE_ALLOW[0] },
        ],
      },
    });
    expect(valid).toEqual({});

    prepareSignedOverrideSettings(filePath);
    const allowWiden = enf.processPreToolUse({
      tool_name: 'MultiEdit',
      tool_input: {
        file_path: filePath,
        edits: [
          { old_string: SETTINGS_BASELINE_ALLOW[0], new_string: `${SETTINGS_BASELINE_ALLOW[0]}","Write(.claude/settings.json)` },
        ],
      },
    });
    expect(allowWiden.hookSpecificOutput.permissionDecision).toBe('deny');
    expect(allowWiden.hookSpecificOutput.permissionDecisionReason).toContain('protected path');

    prepareSignedOverrideSettings(filePath);
    const missingOldString = enf.processPreToolUse({
      tool_name: 'MultiEdit',
      tool_input: {
        file_path: filePath,
        edits: [
          { old_string: 'missing-signed-settings-substring', new_string: 'replacement' },
        ],
      },
    });
    expect(missingOldString.hookSpecificOutput.permissionDecision).toBe('deny');
    expect(missingOldString.hookSpecificOutput.permissionDecisionReason).toContain('protected path');
  });

  it('rejects malformed, tampered, expired, overlong, wrong-project, and incomplete root override tokens', () => {
    const nowMs = Date.now();
    const invalidCase = fc.constantFrom(
      'tampered-signature',
      'expired',
      'overlong-ttl',
      'wrong-project',
      'missing-version',
      'missing-key-id',
      'short-nonce',
      'wrong-key',
    );

    fc.assert(
      fc.property(invalidCase, (kind) => {
        clearAgentEnv();
        resetModule();
        rmSync(join(root, '.hive-flow', 'enforcement'), { recursive: true, force: true });
        enableDevOverride();

        const claims = baseRootOverrideClaims(nowMs);
        let token = createRootOverrideTokenFromClaims(claims);
        if (kind === 'tampered-signature') {
          token = `${token.slice(0, -1)}${token.endsWith('0') ? '1' : '0'}`;
        } else if (kind === 'expired') {
          token = createRootOverrideTokenFromClaims({ ...claims, issuedAt: nowMs - 120_000, expiresAt: nowMs - 60_000 });
        } else if (kind === 'overlong-ttl') {
          token = createRootOverrideTokenFromClaims({ ...claims, expiresAt: nowMs + 13 * 60 * 60 * 1000 });
        } else if (kind === 'wrong-project') {
          token = createRootOverrideTokenFromClaims({ ...claims, projectDir: join(tmpdir(), 'hive-flow-wrong-project') });
        } else if (kind === 'missing-version') {
          const { version: _version, ...withoutVersion } = claims;
          token = createRootOverrideTokenFromClaims(withoutVersion);
        } else if (kind === 'missing-key-id') {
          const { keyId: _keyId, ...withoutKeyId } = claims;
          token = createRootOverrideTokenFromClaims(withoutKeyId);
        } else if (kind === 'short-nonce') {
          token = createRootOverrideTokenFromClaims({ ...claims, nonce: 'short' });
        } else if (kind === 'wrong-key') {
          token = createRootOverrideTokenFromClaims(claims, 'wrong-hmac-key');
        }
        process.env.HIVE_FLOW_DEV_OVERRIDE_TOKEN = token;

        expect(enf.verifyDevOverrideRootToken(null, nowMs)).toBe(false);
        const result = enf.processPreToolUse({
          tool_name: 'Write',
          tool_input: { file_path: '.git/info/exclude' },
        });
        expect(result.hookSpecificOutput.permissionDecision).toBe('deny');
      }),
      { seed: 20_642, numRuns: PROPERTY_RUNS },
    );
  });

  it('accepts a valid root override token only when no subagent identity is present', () => {
    const envField = fc.option(
      fc.constantFrom('AGENTIC_FLOW_AGENT_ID', 'CLAUDE_AGENT_ID', 'CLAUDE_PARENT_AGENT_ID'),
      { nil: null },
    );
    const hookField = fc.option(fc.constantFrom('agent_id', 'agentId'), { nil: null });

    fc.assert(
      fc.property(envField, hookField, (envName, hookName) => {
        clearAgentEnv();
        resetModule();
        rmSync(join(root, '.hive-flow', 'enforcement'), { recursive: true, force: true });
        enableDevOverride();
        issueRootOverrideToken();
        if (envName) process.env[envName] = `${envName.toLowerCase()}-worker`;
        const input = hookName ? { [hookName]: 'native-task-worker' } : null;

        expect(enf.verifyDevOverrideRootToken(input)).toBe(!envName && !hookName);
      }),
      { seed: 20_643, numRuns: PROPERTY_RUNS },
    );
  });

  it('keeps RESTRICTED write decisions path-aware across project, protected, outside, traversal, symlink, and casefold targets', () => {
    mkdirSync(join(root, 'tmp'), { recursive: true });
    try {
      symlinkSync(join(root, '.claude', 'settings.json'), join(root, 'tmp', 'settings-link'));
    } catch {
      // The symlink may already exist from a shrunk/replayed property case.
    }

    const writeCase = fc.constantFrom(
      { filePath: 'v3/docs/design/benign-note.md', allowed: true },
      { filePath: '.claude/settings.json', allowed: false },
      { filePath: '.CLAUDE/settings.json', allowed: false },
      { filePath: join(tmpdir(), 'hive-flow-restricted-outside.md'), allowed: false },
      { filePath: '../hive-flow-restricted-traversal.md', allowed: false },
      { filePath: 'tmp/settings-link', allowed: false },
      { filePath: '.HIVE-FLOW/enforcement/state.json', allowed: false },
    );

    fc.assert(
      fc.property(writeCase, (candidate) => {
        clearAgentEnv();
        resetModule();
        rmSync(join(root, '.hive-flow', 'enforcement'), { recursive: true, force: true });
        writeScopedState('global', 'global', {
          level: enf.LEVELS.RESTRICTED,
          violations: 2,
          restrictedGroups: ['write'],
        });

        const result = enf.processPreToolUse({
          tool_name: 'Write',
          tool_input: { file_path: candidate.filePath },
        });

        if (candidate.allowed) {
          expect(result).toEqual({});
        } else {
          expect(result.hookSpecificOutput.permissionDecision).toBe('deny');
        }
      }),
      { seed: 20_644, numRuns: PROPERTY_RUNS },
    );
  });

  it('denies trusted subagent protected-workflow trips without escalating any scope', () => {
    const first = fc.constantFrom(...'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz'.split(''));
    const rest = fc.array(
      fc.constantFrom(...'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789_-'.split('')),
      { minLength: 0, maxLength: 24 },
    ).map(chars => chars.join(''));
    const agentIdArb = fc.tuple(first, rest).map(([head, tail]) => `${head}${tail}`);

    fc.assert(
      fc.property(agentIdArb, (agentId) => {
        clearAgentEnv();
        resetModule();
        rmSync(join(root, '.hive-flow', 'enforcement'), { recursive: true, force: true });
        process.env.AGENTIC_FLOW_AGENT_ID = agentId;
        const scopedAgentId = enf.getAgentId({});

        const result = enf.processPreToolUse({
          tool_name: 'Write',
          tool_input: { file_path: `.hive-flow/workflows/${agentId}.json` },
        });

        expect(result.hookSpecificOutput.permissionDecision).toBe('deny');
        expect(readScopedState('agent', scopedAgentId)).toBeNull();
        expect(readScopedState('global', 'global')).toBeNull();
      }),
      { seed: 20_645, numRuns: PROPERTY_RUNS },
    );
  });

  it('matches protected paths on boundaries with casefolding without treating sibling prefixes as protected', () => {
    const protectedCase = fc.constantFrom(
      { protectedPath: '.claude/settings.json', siblingPath: '.claude/settings.json.bak' },
      { protectedPath: '.claude/settings.local.json', siblingPath: '.claude/settings.local.json.bak' },
      { protectedPath: '.env', siblingPath: '.env.example' },
      { protectedPath: '.hive-flow/enforcement/state.json', siblingPath: '.hive-flow/enforcement-old/state.json' },
      { protectedPath: 'v3/@hive-flow/cli/src/permission-guard/gate.ts', siblingPath: 'v3/@hive-flow/cli/src/permission-guard-old/gate.ts' },
    );

    fc.assert(
      fc.property(protectedCase, ({ protectedPath, siblingPath }) => {
        expect(enf.isProtectedPath(protectedPath)).toBe(true);
        expect(enf.isProtectedPath(protectedPath.toUpperCase())).toBe(true);
        expect(enf.isProtectedPath(siblingPath)).toBe(false);
      }),
      { seed: 20_646, numRuns: PROPERTY_RUNS },
    );
  });

  it('allows one-shot project-root env prefixes but escalates exported spoof and gate-bypass env vars', () => {
    const state = {
      level: 0,
      violations: 0,
      restrictedGroups: [],
      history: [],
      integrityCompromised: false,
    };

    expect(enf.detectCircumvention(
      'Bash',
      { command: 'HIVE_FLOW_PROJECT_ROOT=/tmp/spoofed node v3/@hive-flow/cli/bin/cli.js status' },
      state,
    ).circumvention).toBe(false);

    expect(enf.detectCircumvention(
      'Bash',
      { command: 'export HIVE_FLOW_PROJECT_ROOT=/tmp/spoofed' },
      state,
    ).circumvention).toBe(true);

    expect(enf.detectCircumvention(
      'Bash',
      { command: 'HIVE_FLOW_ENFORCEMENT_DISABLED=1 node .claude/helpers/hook-handler.cjs permission-guard' },
      state,
    )).toMatchObject({ circumvention: true, systemic: true });
  });

  it('default reset clears global, scoped state, and per-agent role files', () => {
    const agentId = 'blocked-agent';
    mkdirSync(dirname(scopedStatePath('agent', agentId)), { recursive: true });
    mkdirSync(dirname(rolePath(agentId)), { recursive: true });
    writeFileSync(scopedStatePath('agent', agentId), JSON.stringify(enf.signState({
      level: enf.LEVELS.RESTRICTED,
      violations: 3,
      consecutiveDenials: 1,
      restrictedGroups: ['exec', 'write'],
      history: [],
      integrityCompromised: false,
    })));
    writeFileSync(rolePath(agentId), JSON.stringify({ stale: true }));
    writeFileSync(statePath(), JSON.stringify(enf.signState({
      level: enf.LEVELS.RESTRICTED,
      violations: 2,
      consecutiveDenials: 1,
      restrictedGroups: ['exec', 'write'],
      history: [],
      integrityCompromised: false,
    })));

    const reset = enf.resetEnforcement();

    expect(reset.level).toBe(enf.LEVELS.NORMAL);
    expect(reset.restrictedGroups).toEqual([]);
    expect(existsSync(scopedStatePath('agent', agentId))).toBe(false);
    expect(existsSync(rolePath(agentId))).toBe(false);
    expect(readScopedState('global', 'global')?.level).toBe(enf.LEVELS.NORMAL);
    expect(enf.verifyState(JSON.parse(readFileSync(statePath(), 'utf8'))).valid).toBe(true);
  });

  it('reset parser supports explicit all/global/agent/project scope syntax', () => {
    expect(enf.parseResetScope('/reset-enforcement')).toEqual({ scope: 'all' });
    expect(enf.parseResetScope('/reset-enforcement --scope all')).toEqual({ scope: 'all' });
    expect(enf.parseResetScope('/reset-enforcement --scope global')).toEqual({ scope: 'global' });
    expect(enf.parseResetScope('/reset-enforcement --scope agent --agent worker-a')).toEqual({ scope: 'agent', agentId: 'worker-a' });
    expect(enf.parseResetScope('/reset-enforcement --agent=worker-b')).toEqual({ scope: 'agent', agentId: 'worker-b' });
    expect(enf.parseResetScope('/reset-enforcement --scope session --session claude-123')).toEqual({ scope: 'session', sessionId: 'claude-123' });
    expect(enf.parseResetScope('/reset-enforcement --project')).toEqual({ scope: 'project', project: true });
  });

  it('does not flag inert eval text but still blocks shell eval execution', () => {
    expect(enf.isObfuscated(`node -e "console.log('eval(')"`)).toBe(false);
    expect(enf.isObfuscated("bash -c 'eval $(echo echo hi)'")).toBe(true);
  });

  it('tokenizes command positions without treating quoted mentions as invocations', () => {
    const tokens = enf.shellTokens("grep 'reset-enforcement' v3/docs/design && bash -c 'node --eval \"console.log(1)\"'");
    expect(tokens).toContainEqual(expect.objectContaining({ text: 'grep', quoted: false }));
    expect(tokens).toContainEqual(expect.objectContaining({ text: 'reset-enforcement', quoted: true }));

    const executions = enf.collectShellCommandExecutions(
      "grep 'reset-enforcement' v3/docs/design && bash -c 'node --eval \"console.log(1)\"'",
    );

    expect(executions.map((execution: { command: string }) => execution.command)).toEqual([
      'grep',
      'bash',
      'node',
    ]);
    expect(enf.hasCommandPositionInvocation(
      "grep 'reset-enforcement' v3/docs/design",
      (execution: { command: string }) => /^(?:reset-enforcement|enforcement-reset)$/.test(execution.command),
    )).toBe(false);
    expect(enf.hasCommandPositionInvocation(
      "bash -c 'reset-enforcement'",
      (execution: { command: string }) => execution.command === 'reset-enforcement',
    )).toBe(true);
  });

  it('denies inline interpreter eval without escalating the effective scope', () => {
    process.env.AGENTIC_FLOW_AGENT_ID = 'inline-eval-worker';

    for (const command of [
      'bash -c "node --eval \\"console.log(1)\\""',
      'npx node -e "console.log(1)"',
      'pnpm --dir v3 --filter @hive-flow/cli exec node -e "console.log(1)"',
      'npm exec -- node -e "console.log(1)"',
      'yarn node -e "console.log(1)"',
    ]) {
      const result = enf.processPreToolUse({
        tool_name: 'Bash',
        tool_input: { command },
      });

      expect(result.hookSpecificOutput.permissionDecision, command).toBe('deny');
      expect(result.hookSpecificOutput.permissionDecisionReason).toContain('Inline code execution is blocked');
      expect(result.hookSpecificOutput.permissionDecisionReason).toContain('use Read, Write, or Edit');
      expect(result.hookSpecificOutput.permissionDecisionReason).toContain('write a script file');
      expect(readScopedState('agent', 'inline-eval-worker')).toBeNull();
      expect(readScopedState('global', 'global')).toBeNull();
    }
  });

  it('allows normal package-runner verification commands', () => {
    const state = {
      level: 0,
      violations: 0,
      restrictedGroups: [],
      history: [],
      integrityCompromised: false,
    };

    for (const command of [
      'pnpm --dir v3 --filter @hive-flow/cli exec vitest run src/__tests__/enforcement-security-property.test.ts',
      'npx tsc --noEmit',
      'npm exec eslint -- src/index.ts',
      'yarn vitest run src/__tests__/enforcement-security-property.test.ts',
    ]) {
      expect(enf.detectCircumvention('Bash', { command }, state).circumvention, command).toBe(false);
    }
  });

  it('only blocks Bash redirects when the redirect target is protected', () => {
    const state = {
      level: 0,
      violations: 0,
      restrictedGroups: [],
      history: [],
      integrityCompromised: false,
    };

    expect(enf.detectCircumvention(
      'Bash',
      { command: 'grep x .hive-flow/enforcement/audit.jsonl 2>/dev/null' },
      state,
    ).circumvention).toBe(false);

    expect(enf.detectCircumvention(
      'Bash',
      { command: "cat > v3/docs/x.md <<'EOF'\n.claude/helpers/enforcement.cjs\nEOF" },
      state,
    ).circumvention).toBe(false);

    expect(enf.detectCircumvention(
      'Bash',
      { command: 'echo x > .claude/settings.json.d/note.md' },
      state,
    ).circumvention).toBe(false);

    expect(enf.detectCircumvention(
      'Bash',
      { command: 'echo x > .hive-flow/enforcement-old/state.json' },
      state,
    ).circumvention).toBe(false);

    expect(enf.detectCircumvention(
      'Bash',
      { command: 'echo x > .claude/helpers/enforcement.cjs' },
      state,
    ).circumvention).toBe(true);

    expect(enf.detectCircumvention(
      'Bash',
      { command: 'printf x | tee .hive-flow/enforcement/state.json' },
      state,
    ).circumvention).toBe(true);

    expect(enf.detectCircumvention(
      'Bash',
      { command: "sed -i 's/.claude\\/settings.json/.claude\\/settings.local.json/g' v3/docs/notes.md && echo ok" },
      state,
    ).circumvention).toBe(false);

    expect(enf.detectCircumvention(
      'Bash',
      { command: "sed -i 's/permission-guard/noop/g' .claude/settings.json && echo ok" },
      state,
    ).circumvention).toBe(true);
  });
});
