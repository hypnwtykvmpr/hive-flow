import { describe, expect, it, afterAll, beforeEach } from 'vitest';
import fc from 'fast-check';
import { createRequire } from 'node:module';
import { copyFileSync, existsSync, mkdirSync, readFileSync, realpathSync, rmSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdtempSync } from 'node:fs';
import { createHash, createHmac } from 'node:crypto';
import { propertyRunsFromEnv } from './property-runs.js';
import { checkMCPEnforcement, ToolRisk as McpToolRisk } from '../mcp-tools/mcp-enforcement-gate.js';

const PROPERTY_RUNS = propertyRunsFromEnv(100);

const require = createRequire(import.meta.url);
const fsForLockSpy = require('node:fs') as typeof import('node:fs');
const here = dirname(fileURLToPath(import.meta.url));
const source = resolve(here, '../../../../../.claude/helpers/enforcement.cjs');
const settingsSource = resolve(here, '../../../../../.claude/settings.json');
const policySource = resolve(here, '../permission-guard/protected-paths.cjs');
const policyJsonSource = resolve(here, '../permission-guard/protected-paths.policy.json');
const root = realpathSync(mkdtempSync(join(tmpdir(), 'hive-flow-enforcement-security-')));
const previousHiveFlowHome = process.env.HIVE_FLOW_HOME;
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

function hiveHomeForTest(): string {
  return join(root, 'global-hive-home');
}

function legacyProjectEnforcementPath(...parts: string[]): string {
  return join(root, '.hive-flow', 'enforcement', ...parts);
}

function resetEnforcementStoresForTest(): void {
  rmSync(legacyProjectEnforcementPath(), { recursive: true, force: true });
  rmSync(hiveHomeForTest(), { recursive: true, force: true });
}

function enforcementStateRoot(): string {
  return join(process.env.HIVE_FLOW_HOME || join(root, '.hive-flow'), 'enforcement');
}

function scopedStatePath(scopeType: string, scopeId: string): string {
  return join(enforcementStateRoot(), `${scopeType}s`, scopeId, 'state.json');
}

function rolePath(agentId: string): string {
  return join(enforcementStateRoot(), 'agents', agentId, 'role.json');
}

function readScopedState(scopeType: string, scopeId: string): Record<string, unknown> | null {
  const file = scopeType === 'global' ? statePath() : scopedStatePath(scopeType, scopeId);
  try {
    return JSON.parse(readFileSync(file, 'utf8')).state;
  } catch {
    return null;
  }
}

function denialLedgerPath(): string {
  return join(enforcementStateRoot(), 'global', 'denial-ledger.json');
}

function denialLedgerLockPath(): string {
  return join(enforcementStateRoot(), 'global', 'denial-ledger.lock');
}

function readViolationRows(): Array<Record<string, unknown>> {
  const file = join(enforcementStateRoot(), 'global', 'violations.jsonl');
  if (!existsSync(file)) return [];
  return readFileSync(file, 'utf8')
    .split(/\r?\n/)
    .filter(Boolean)
    .map(line => JSON.parse(line) as Record<string, unknown>);
}

function readDenialLedgerState(): Record<string, unknown> {
  const envelope = JSON.parse(readFileSync(denialLedgerPath(), 'utf8'));
  const verified = enf.verifyState(envelope);
  expect(verified.valid).toBe(true);
  return verified.state as Record<string, unknown>;
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
  delete process.env.HIVE_FLOW_AGENT_ID;
  delete process.env.CLAUDE_AGENT_ID;
  delete process.env.CLAUDE_SESSION_ID;
  delete process.env.CODEX_SESSION_ID;
  delete process.env.HIVE_FLOW_SESSION_ID;
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
  const presetsPath = join(hiveHomeForTest(), 'enforcement', 'settings-presets.json');
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
  resetEnforcementStoresForTest();
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
    process.env.HIVE_FLOW_HOME = hiveHomeForTest();
    resetModule();
    resetEnforcementStoresForTest();
    rmSync(join(root, '.hive-flow', 'data', 'compaction-recovery-required.json'), { force: true });
    rmSync(join(root, '.hive-flow', 'data', 'compaction-recovery-ack.json'), { force: true });
    mkdirSync(dirname(statePath()), { recursive: true });
  });

  afterAll(() => {
    if (previousHiveFlowHome === undefined) delete process.env.HIVE_FLOW_HOME;
    else process.env.HIVE_FLOW_HOME = previousHiveFlowHome;
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
          resetEnforcementStoresForTest();
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
    expect(enf.isProtectedPath(join(hiveHomeForTest(), 'projects', 'project-a', 'data', 'watcher-hive.json'))).toBe(false);
    expect(enf.isProtectedPath(join(hiveHomeForTest(), 'sessions', 'session-a', 'scratch.json'))).toBe(false);
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
    process.env.HIVE_FLOW_AGENT_ID = 'agent-a';

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

  it('blocks agent_task_async at RESTRICTED with agent_task parity', () => {
    resetModule();
    resetEnforcementStoresForTest();
    writeScopedState('global', 'global', {
      level: enf.LEVELS.RESTRICTED,
      violations: 0,
      restrictedGroups: [],
      history: [],
      integrityCompromised: false,
    });

    const previousProjectDir = process.env.CLAUDE_PROJECT_DIR;
    process.env.CLAUDE_PROJECT_DIR = root;
    try {
      const asyncResult = checkMCPEnforcement('mcp__hive-flow__agent_task_async');
      const syncResult = checkMCPEnforcement('mcp__hive-flow__agent_task');

      expect(asyncResult.allowed).toBe(false);
      expect(syncResult.allowed).toBe(false);
      expect(asyncResult.risk).toBe(McpToolRisk.CRITICAL);
      expect(syncResult.risk).toBe(McpToolRisk.CRITICAL);
      expect(asyncResult.reason).toContain('CRITICAL risk');
      expect(syncResult.reason).toContain('CRITICAL risk');
    } finally {
      if (previousProjectDir === undefined) {
        delete process.env.CLAUDE_PROJECT_DIR;
      } else {
        process.env.CLAUDE_PROJECT_DIR = previousProjectDir;
      }
    }
  });

  it('scopes root-session ordinary non-substrate violations to session state instead of project/global', () => {
    process.env.CLAUDE_SESSION_ID = 'coordinator-session-only';

    const result = enf.processPreToolUse({
      tool_name: 'Bash',
      tool_input: { command: "bash -c 'eval $(echo echo hi)'" },
    });

    const ctx = enf.resolveScopeContext();
    expect(result.hookSpecificOutput.hookEventName).toBe('PreToolUse');
    expect(result.hookSpecificOutput.permissionDecision).toBe('deny');
    expect(enf.getAgentId({})).toBeNull();
    expect(ctx.sid).toBe('coordinator-session-only');
    expect(readScopedState('session', 'coordinator-session-only')?.level).toBe(enf.LEVELS.WARNED);
    expect(readScopedState('project', ctx.projectId)).toBeNull();
    expect(readScopedState('agent', 'coordinator-session-only')).toBeNull();
    expect(readScopedState('global', 'global')).toBeNull();
  });

  it('uses CODEX_SESSION_ID before Claude/Hive env ids for root-session scope state', () => {
    process.env.CODEX_SESSION_ID = 'codex-root-session-only';
    process.env.CLAUDE_SESSION_ID = 'claude-root-session-wrong';
    process.env.HIVE_FLOW_SESSION_ID = 'hive-root-session-wrong';

    const result = enf.processPreToolUse({
      tool_name: 'Bash',
      tool_input: { command: "bash -c 'eval $(echo echo hi)'" },
    });

    const ctx = enf.resolveScopeContext();
    expect(result.hookSpecificOutput.permissionDecision).toBe('deny');
    expect(enf.getAgentId({})).toBeNull();
    expect(ctx.sid).toBe('codex-root-session-only');
    expect(readScopedState('session', 'codex-root-session-only')?.level).toBe(enf.LEVELS.WARNED);
    expect(readScopedState('session', 'claude-root-session-wrong')).toBeNull();
    expect(readScopedState('session', 'hive-root-session-wrong')).toBeNull();
  });

  it('writes new enforcement state under HIVE_FLOW_HOME and leaves project-local state as legacy-only', () => {
    process.env.CLAUDE_SESSION_ID = 'global-home-session';

    const result = enf.processPreToolUse({
      tool_name: 'Bash',
      tool_input: { command: "bash -c 'eval $(echo echo hi)'" },
    });

    const sessionStateFile = enf.getScopedStateFile('session', 'global-home-session');
    expect(result.hookSpecificOutput.permissionDecision).toBe('deny');
    expect(sessionStateFile).toBe(join(hiveHomeForTest(), 'enforcement', 'sessions', 'global-home-session', 'state.json'));
    expect(existsSync(sessionStateFile)).toBe(true);
    expect(existsSync(legacyProjectEnforcementPath('sessions', 'global-home-session', 'state.json'))).toBe(false);
    expect(existsSync(legacyProjectEnforcementPath('state.json'))).toBe(false);
  });

  it('loads project-local scoped state only as a legacy fallback during migration', () => {
    const sessionId = 'legacy-session-state';
    const legacyStateFile = legacyProjectEnforcementPath('sessions', sessionId, 'state.json');
    mkdirSync(dirname(legacyStateFile), { recursive: true });
    writeFileSync(legacyStateFile, JSON.stringify(enf.signState({
      level: enf.LEVELS.RESTRICTED,
      violations: 2,
      consecutiveDenials: 1,
      restrictedGroups: ['write'],
      history: [],
      resetAt: null,
      integrityCompromised: false,
    })));
    process.env.CLAUDE_SESSION_ID = sessionId;

    const ctx = enf.resolveScopeContext();
    const effective = enf.loadEffectiveState(ctx).effective;
    const newStateFile = enf.getScopedStateFile('session', sessionId);

    expect(effective.scopeType).toBe('session');
    expect(effective.scopeId).toBe(sessionId);
    expect(effective.state.level).toBe(enf.LEVELS.RESTRICTED);
    expect(existsSync(newStateFile)).toBe(false);

    enf.saveScopedState('session', sessionId, {
      ...effective.state,
      violations: 3,
    });

    expect(readScopedState('session', sessionId)?.violations).toBe(3);
    expect(existsSync(newStateFile)).toBe(true);
    expect(existsSync(legacyStateFile)).toBe(true);
  });

  it('does not let one root session ordinary violation restrict a co-resident root session', () => {
    process.env.CLAUDE_SESSION_ID = 'session-a';

    const result = enf.processPreToolUse({
      tool_name: 'Bash',
      tool_input: { command: "bash -c 'eval $(echo echo hi)'" },
    });

    expect(result.hookSpecificOutput.permissionDecision).toBe('deny');
    expect(readScopedState('session', 'session-a')?.level).toBe(enf.LEVELS.WARNED);

    process.env.CLAUDE_SESSION_ID = 'session-b';
    const sessionB = enf.loadEffectiveState(enf.resolveScopeContext()).effective;

    expect(sessionB.state.level).toBe(enf.LEVELS.NORMAL);
    expect(readScopedState('session', 'session-b')).toBeNull();
    expect(readScopedState('project', enf.resolveScopeContext().projectId)).toBeNull();
    expect(readScopedState('global', 'global')).toBeNull();
  });

  it('scopes root-session systemic but non-substrate trips to the current session instead of global halt', () => {
    for (const [index, command] of [
      'export HIVE_FLOW_ENFORCEMENT_DISABLED=1',
      'HIVE_FLOW_PIPELINE_OVERRIDE=1 node .claude/helpers/hook-handler.cjs permission-guard',
      'CF_WF_7D=1 pnpm --dir v3 --filter @hive-flow/cli test:enforcement',
    ].entries()) {
      const sessionId = `session-gate-bypass-${index}`;
      clearAgentEnv();
      process.env.HIVE_FLOW_HOME = hiveHomeForTest();
      process.env.CLAUDE_SESSION_ID = sessionId;
      resetModule();
      resetEnforcementStoresForTest();

      const result = enf.processPreToolUse({
        tool_name: 'Bash',
        tool_input: { command },
      });

      expect(result.hookSpecificOutput.permissionDecision, command).toBe('deny');
      expect(readScopedState('session', sessionId)?.level, command).toBe(enf.LEVELS.RESTRICTED);
      expect(readScopedState('global', 'global'), command).toBeNull();
    }
  });

  it('includes session scope in effective state MAX for the owning root session', () => {
    process.env.CLAUDE_SESSION_ID = 'session-owned-level';
    writeScopedState('session', 'session-owned-level', {
      level: enf.LEVELS.RESTRICTED,
      violations: 1,
      restrictedGroups: ['exec'],
      history: [],
      integrityCompromised: false,
    });

    const effective = enf.loadEffectiveState(enf.resolveScopeContext());

    expect(effective.scopes.some((scope: { scopeType: string; scopeId: string }) => (
      scope.scopeType === 'session' && scope.scopeId === 'session-owned-level'
    ))).toBe(true);
    expect(effective.effective.scopeType).toBe('session');
    expect(effective.effective.scopeId).toBe('session-owned-level');
    expect(effective.effective.state.level).toBe(enf.LEVELS.RESTRICTED);
  });

  it('denies first protected substrate mutations without escalating and records the ledger', () => {
    process.env.HIVE_FLOW_AGENT_ID = 'tier1-agent';

    const result = enf.processPreToolUse({
      tool_name: 'Write',
      tool_input: { file_path: '.claude/helpers/role-enforcement.cjs' },
    });

    expect(result.hookSpecificOutput.permissionDecision).toBe('deny');
    expect(result.hookSpecificOutput.permissionDecisionReason).toContain('protected path');
    expect(result.hookSpecificOutput.permissionDecisionReason).not.toContain('Escalated');
    expect(readScopedState('agent', 'tier1-agent')).toBeNull();
    expect(readScopedState('global', 'global')).toBeNull();

    const ledger = readDenialLedgerState();
    const entries = Object.values(ledger.entries as Record<string, { channels: string[]; target: string }>);
    expect(entries).toHaveLength(1);
    expect(entries[0].channels).toEqual(['write']);
    expect(entries[0].target).toContain('/.claude/helpers/role-enforcement.cjs');
  });

  it('escalates protected mutations only after a cross-channel repeat on the same actor and target', () => {
    process.env.HIVE_FLOW_AGENT_ID = 'tier2-agent';

    const first = enf.processPreToolUse({
      tool_name: 'Write',
      tool_input: { file_path: '.claude/helpers/role-enforcement.cjs' },
    });
    expect(first.hookSpecificOutput.permissionDecision).toBe('deny');
    expect(readScopedState('global', 'global')).toBeNull();

    const second = enf.processPreToolUse({
      tool_name: 'Bash',
      tool_input: { command: 'printf x >> .claude/helpers/role-enforcement.cjs' },
    });

    expect(second.hookSpecificOutput.permissionDecision).toBe('deny');
    expect(second.hookSpecificOutput.permissionDecisionReason).toContain('Cross-channel repeat');
    expect(readScopedState('global', 'global')?.level).toBe(enf.LEVELS.RESTRICTED);
  });

  it('does not escalate same-channel protected mutation repeats', () => {
    process.env.HIVE_FLOW_AGENT_ID = 'same-channel-agent';

    const first = enf.processPreToolUse({
      tool_name: 'Write',
      tool_input: { file_path: '.claude/helpers/role-enforcement.cjs' },
    });
    const second = enf.processPreToolUse({
      tool_name: 'Edit',
      tool_input: { file_path: '.claude/helpers/role-enforcement.cjs' },
    });

    expect(first.hookSpecificOutput.permissionDecision).toBe('deny');
    expect(second.hookSpecificOutput.permissionDecision).toBe('deny');
    expect(second.hookSpecificOutput.permissionDecisionReason).not.toContain('Escalated');
    expect(readScopedState('agent', 'same-channel-agent')).toBeNull();
    expect(readScopedState('global', 'global')).toBeNull();

    const ledger = readDenialLedgerState();
    const entries = Object.values(ledger.entries as Record<string, { channels: string[] }>);
    expect(entries).toHaveLength(1);
    expect(entries[0].channels).toEqual(['write']);
  });

  it('uses a stable session fallback for protected-mutation ledger keys when agent id is absent', () => {
    process.env.CLAUDE_SESSION_ID = 'ledger-session-fallback';

    const first = enf.processPreToolUse({
      tool_name: 'Write',
      tool_input: { file_path: '.claude/helpers/role-enforcement.cjs' },
    });
    expect(first.hookSpecificOutput.permissionDecision).toBe('deny');
    expect(readScopedState('global', 'global')).toBeNull();

    const ledger = readDenialLedgerState();
    expect(Object.keys(ledger.entries as Record<string, unknown>)[0]).toContain('session:ledger-session-fallback');

    const second = enf.processPreToolUse({
      tool_name: 'Bash',
      tool_input: { command: 'printf x >> .claude/helpers/role-enforcement.cjs' },
    });

    expect(second.hookSpecificOutput.permissionDecision).toBe('deny');
    expect(second.hookSpecificOutput.permissionDecisionReason).toContain('Cross-channel repeat');
    expect(readScopedState('global', 'global')?.level).toBe(enf.LEVELS.RESTRICTED);
  });

  it('denies secret exposure without escalating any scope', () => {
    const projectId = enf.resolveScopeContext().projectId;

    const result = enf.processPreToolUse({
      tool_name: 'Bash',
      tool_input: { command: 'echo "$OPENAI_API_KEY"' },
    });

    expect(result.hookSpecificOutput.permissionDecision).toBe('deny');
    expect(result.hookSpecificOutput.permissionDecisionReason).toContain('secret environment variable');
    expect(result.hookSpecificOutput.permissionDecisionReason).not.toContain('Escalated');
    expect(readScopedState('project', projectId)).toBeNull();
    expect(readScopedState('global', 'global')).toBeNull();
  });

  it('still escalates coordinator enforcement-file attacks globally', () => {
    enf.processPreToolUse({
      tool_name: 'Write',
      tool_input: { file_path: '.claude/helpers/enforcement.cjs' },
    });
    const result = enf.processPreToolUse({
      tool_name: 'Bash',
      tool_input: { command: 'printf x >> .claude/helpers/enforcement.cjs' },
    });

    expect(result.hookSpecificOutput.hookEventName).toBe('PreToolUse');
    expect(result.hookSpecificOutput.permissionDecision).toBe('deny');
    expect(readScopedState('global', 'global')?.level).toBe(enf.LEVELS.RESTRICTED);
  });

  it('keeps substrate attacks global even for trusted subagents', () => {
    process.env.HIVE_FLOW_AGENT_ID = 'agent-b';

    enf.processPreToolUse({
      tool_name: 'Write',
      tool_input: { file_path: '.claude/helpers/enforcement.cjs' },
    });
    const result = enf.processPreToolUse({
      tool_name: 'Bash',
      tool_input: { command: 'printf x >> .claude/helpers/enforcement.cjs' },
    });

    expect(result.hookSpecificOutput.hookEventName).toBe('PreToolUse');
    expect(result.hookSpecificOutput.permissionDecision).toBe('deny');
    expect(readScopedState('agent', 'agent-b')).toBeNull();
    expect(readScopedState('global', 'global')?.level).toBe(enf.LEVELS.RESTRICTED);
  });

  it('denies coordinator protected configuration reads without escalating any scope', () => {
    for (const [toolName, filePath] of [
      ['Read', '.claude/settings.json'],
      ['Read', '.env'],
      ['mcp__filesystem__read_text_file', '.claude/settings.local.json'],
    ]) {
      clearAgentEnv();
      resetModule();
      resetEnforcementStoresForTest();
      const projectId = enf.resolveScopeContext().projectId;

      const result = enf.processPreToolUse({
        tool_name: toolName,
        tool_input: { file_path: filePath, path: filePath },
      });

      expect(result.hookSpecificOutput.permissionDecision, `${toolName} ${filePath}`).toBe('deny');
      expect(result.hookSpecificOutput.permissionDecisionReason, `${toolName} ${filePath}`).toContain('Reading protected configuration is denied');
      expect(readScopedState('global', 'global'), `${toolName} ${filePath}`).toBeNull();
      expect(readScopedState('project', projectId), `${toolName} ${filePath}`).toBeNull();
    }
  });

  it('still escalates coordinator key and signed-state reads globally', () => {
    for (const [toolName, filePath] of [
      ['Read', '.hive-flow/enforcement/.hmac-key'],
      ['Read', '.hive-flow/enforcement/state.json'],
      ['mcp__filesystem__read_multiple_files', '.hive-flow/enforcement/verification-gate.json'],
    ]) {
      clearAgentEnv();
      resetModule();
      resetEnforcementStoresForTest();

      const toolInput = toolName === 'mcp__filesystem__read_multiple_files'
        ? { paths: ['src/index.ts', filePath] }
        : { file_path: filePath, path: filePath };
      const result = enf.processPreToolUse({
        tool_name: toolName,
        tool_input: toolInput,
      });

      expect(result.hookSpecificOutput.permissionDecision, `${toolName} ${filePath}`).toBe('deny');
      expect(readScopedState('global', 'global')?.level, `${toolName} ${filePath}`).toBe(enf.LEVELS.RESTRICTED);
    }
  });

  it('keeps coordinator gate-bypass environment variables scoped to the session in any form', () => {
    for (const [index, command] of [
      'export HIVE_FLOW_ENFORCEMENT_DISABLED=1',
      'HIVE_FLOW_PIPELINE_OVERRIDE=1 node .claude/helpers/hook-handler.cjs permission-guard',
      'CF_WF_7D=1 pnpm --dir v3 --filter @hive-flow/cli test:enforcement',
    ].entries()) {
      const sessionId = `gate-bypass-session-${index}`;
      clearAgentEnv();
      process.env.HIVE_FLOW_HOME = hiveHomeForTest();
      process.env.CLAUDE_SESSION_ID = sessionId;
      resetModule();
      resetEnforcementStoresForTest();

      const result = enf.processPreToolUse({
        tool_name: 'Bash',
        tool_input: { command },
      });

      expect(result.hookSpecificOutput.permissionDecision, command).toBe('deny');
      expect(readScopedState('session', sessionId)?.level, command).toBe(enf.LEVELS.RESTRICTED);
      expect(readScopedState('global', 'global'), command).toBeNull();
    }
  });

  it('allows the committed compact-now helper while write-restricted without escalating', () => {
    writeScopedState('project', enf.resolveScopeContext().projectId, {
      level: enf.LEVELS.RESTRICTED,
      violations: 1,
      restrictedGroups: ['write'],
    });

    const result = enf.processPreToolUse({
      tool_name: 'Bash',
      tool_input: {
        command: `node ${join(root, '.claude', 'helpers', 'compact-now.cjs')} --reason "manual handoff" --mode inplace`,
      },
    });

    expect(result.hookSpecificOutput?.permissionDecision ?? 'allow').toBe('allow');
    expect(readScopedState('global', 'global')).toBeNull();
  });

  it('redirects mistaken compact-now checkout activation without escalating global state', () => {
    const result = enf.processPreToolUse({
      tool_name: 'Bash',
      tool_input: {
        command: 'git checkout feat/self-compaction -- .claude/helpers/compact-now.cjs',
      },
    });

    expect(result.hookSpecificOutput.permissionDecision).toBe('deny');
    expect(result.hookSpecificOutput.permissionDecisionReason).toContain('compact-now is not activated by checking out protected hook files');
    expect(result.hookSpecificOutput.permissionDecisionReason).toContain('node .claude/helpers/compact-now.cjs --mode headless');
    expect(result.hookSpecificOutput.permissionDecisionReason).toContain('--resume "$CLAUDE_SESSION_ID"');
    expect(readScopedState('global', 'global')).toBeNull();
  });

  it('does not escalate trusted-root branch-only git checkout', () => {
    const sessionId = 'trusted-root-checkout-session';
    process.env.CLAUDE_SESSION_ID = sessionId;

    const result = enf.processPreToolUse({
      session_id: sessionId,
      tool_name: 'Bash',
      tool_input: {
        command: 'git checkout feat/self-compaction',
      },
    });

    expect(result.hookSpecificOutput?.permissionDecision ?? 'allow').toBe('allow');
    expect(readScopedState('session', sessionId)).toMatchObject({
      level: enf.LEVELS.NORMAL,
      violations: 0,
      restrictedGroups: [],
    });
    expect(readScopedState('project', enf.resolveScopeContext().projectId)).toBeNull();
    expect(readScopedState('global', 'global')).toBeNull();
  });

  it('blocks protected git restore/checkout targets even when git flags precede the subcommand', () => {
    const state = {
      level: 0,
      violations: 0,
      restrictedGroups: [],
      history: [],
      integrityCompromised: false,
    };

    expect(enf.detectCircumvention(
      'Bash',
      { command: 'git -C "$CLAUDE_PROJECT_DIR" restore -- .claude/helpers/hook-handler.cjs' },
      state,
    ).circumvention).toBe(true);

    expect(enf.detectCircumvention(
      'Bash',
      { command: 'git --work-tree=. --git-dir=.git checkout HEAD -- .hive-flow/enforcement/state.json' },
      state,
    ).circumvention).toBe(true);

    expect(enf.detectCircumvention(
      'Bash',
      { command: 'git --exec-path checkout HEAD -- .claude/helpers/enforcement.cjs' },
      state,
    ).circumvention).toBe(true);

    expect(enf.detectCircumvention(
      'Bash',
      { command: 'git --super-prefix checkout HEAD -- .hive-flow/enforcement/state.json' },
      state,
    ).circumvention).toBe(true);

    expect(enf.detectCircumvention(
      'Bash',
      { command: 'git -C "$CLAUDE_PROJECT_DIR" checkout feat/self-compaction' },
      state,
    ).circumvention).toBe(false);
  });

  it('dry-runs hostile verifier probes without persisting live escalation state', () => {
    resetModule();
    resetEnforcementStoresForTest();

    const probeInput = {
      session_id: 'audit-probe',
      tool_name: 'Bash',
      tool_input: {
        command: 'git checkout HEAD -- .claude/helpers/enforcement.cjs',
      },
    };

    const dryRun = enf.processPreToolUseDryRun(probeInput);

    expect(dryRun.hookSpecificOutput.permissionDecision).toBe('deny');
    expect(dryRun.hookSpecificOutput.permissionDecisionReason).toContain('CIRCUMVENTION: Git operation targeting enforcement/hook files');
    expect(dryRun.hookSpecificOutput.permissionDecisionReason).toContain('DRY RUN');
    expect(readScopedState('global', 'global')).toBeNull();
    expect(readScopedState('session', 'audit-probe')).toBeNull();
    expect(readViolationRows()).toEqual([]);

    const live = enf.processPreToolUse(probeInput);
    expect(live.hookSpecificOutput.permissionDecision).toBe('deny');
    expect(live.hookSpecificOutput.permissionDecisionReason).toContain('Escalated global to level');
    expect(readScopedState('global', 'global')?.level).toBe(enf.LEVELS.RESTRICTED);
    expect(readViolationRows()).toEqual([
      expect.objectContaining({
        type: 'escalation',
        reason: 'CIRCUMVENTION: Git operation targeting enforcement/hook files',
        scopeType: 'global',
        sessionId: 'audit-probe',
      }),
    ]);
  });

  it('dry-runs allowed verifier probes without updating activity state', () => {
    resetModule();
    resetEnforcementStoresForTest();

    const allowedInputs = [
      { tool_name: 'Read', tool_input: { file_path: join(root, 'README.md') } },
      { tool_name: 'Bash', tool_input: { command: 'git status --short --branch' } },
      { tool_name: 'Bash', tool_input: { command: 'claude -p "status"' } },
    ];

    for (const input of allowedInputs) {
      const result = enf.processPreToolUseDryRun(input);
      expect(result.hookSpecificOutput?.permissionDecision).not.toBe('deny');
      expect(readScopedState('global', 'global')).toBeNull();
      expect(readViolationRows()).toEqual([]);
    }
  });

  it('blocks mutating work after compact until recovery is acknowledged', () => {
    const recoveryPath = join(root, '.hive-flow', 'data', 'compaction-recovery-required.json');
    mkdirSync(dirname(recoveryPath), { recursive: true });
    writeFileSync(recoveryPath, JSON.stringify({
      type: 'hive-flow.compaction-recovery-required',
      sessionId: 'compact-session-1',
      recoveryNonce: 'nonce-one',
      source: 'compact',
      requiredActions: ['read-compaction-handoff', 'inspect-live-git-state', 'acknowledge-recovery'],
      createdAt: new Date().toISOString(),
    }));

    const result = enf.processPreToolUse({
      session_id: 'compact-session-1',
      tool_name: 'Write',
      tool_input: { file_path: join(root, 'v3', 'docs', 'design', 'safe.md'), content: 'safe' },
    });

    expect(result.hookSpecificOutput.permissionDecision).toBe('deny');
    expect(result.hookSpecificOutput.permissionDecisionReason).toContain('POST-COMPACT RECOVERY REQUIRED');
    expect(result.hookSpecificOutput.permissionDecisionReason).toContain('compaction-recovery.cjs ack');
    expect(readScopedState('global', 'global')).toBeNull();
  });

  it('matches compaction recovery requirements against CODEX_SESSION_ID before Claude env ids', () => {
    const recoveryPath = join(root, '.hive-flow', 'data', 'compaction-recovery-required.json');
    mkdirSync(dirname(recoveryPath), { recursive: true });
    writeFileSync(recoveryPath, JSON.stringify({
      type: 'hive-flow.compaction-recovery-required',
      sessionId: 'codex-compact-session',
      recoveryNonce: 'nonce-codex',
      source: 'compact',
      requiredActions: ['read-compaction-handoff', 'inspect-live-git-state', 'acknowledge-recovery'],
      createdAt: new Date().toISOString(),
    }));
    process.env.CODEX_SESSION_ID = 'codex-compact-session';
    process.env.CLAUDE_SESSION_ID = 'claude-compact-session-wrong';

    const flag = enf.loadCompactionRecoveryRequirement({});
    expect(flag?.sessionId).toBe('codex-compact-session');
  });

  it('allows post-compact reorientation commands while recovery is required', () => {
    const recoveryPath = join(root, '.hive-flow', 'data', 'compaction-recovery-required.json');
    mkdirSync(dirname(recoveryPath), { recursive: true });
    writeFileSync(recoveryPath, JSON.stringify({
      type: 'hive-flow.compaction-recovery-required',
      sessionId: 'compact-session-2',
      recoveryNonce: 'nonce-two',
      source: 'compact',
      requiredActions: ['read-compaction-handoff', 'inspect-live-git-state', 'acknowledge-recovery'],
      createdAt: new Date().toISOString(),
    }));

    for (const input of [
      { tool_name: 'Read', tool_input: { file_path: join(root, '.hive-flow', 'data', 'compaction-handoff.md') } },
      { tool_name: 'Bash', tool_input: { command: 'git status --short --branch' } },
      { tool_name: 'Bash', tool_input: { command: 'git diff -- .claude/helpers/context-persistence-hook.mjs' } },
      { tool_name: 'Bash', tool_input: { command: 'node .claude/helpers/compaction-recovery.cjs status' } },
      {
        tool_name: 'Bash',
        tool_input: {
          command: 'node .claude/helpers/compaction-recovery.cjs ack --session compact-session-2 --nonce nonce-two --handoff-missing --state-missing --git-status-reviewed --objective null --next-step null --summary "Read the handoff, checked git status, and confirmed the next implementation step."',
        },
      },
    ]) {
      const result = enf.processPreToolUse({
        session_id: 'compact-session-2',
        ...input,
      });
      expect(result.hookSpecificOutput?.permissionDecision ?? 'allow', JSON.stringify(input)).toBe('allow');
    }

    const otherSessionResult = enf.processPreToolUse({
      session_id: 'other-session',
      tool_name: 'Write',
      tool_input: { file_path: join(root, 'src', 'other.ts'), content: 'ok' },
    });
    expect(otherSessionResult.hookSpecificOutput?.permissionDecision ?? 'allow').toBe('allow');
  });

  it('allows post-compact delegation tools without allowing direct mutation', () => {
    const recoveryPath = join(root, '.hive-flow', 'data', 'compaction-recovery-required.json');
    mkdirSync(dirname(recoveryPath), { recursive: true });
    writeFileSync(recoveryPath, JSON.stringify({
      type: 'hive-flow.compaction-recovery-required',
      sessionId: 'compact-delegate-session',
      recoveryNonce: 'nonce-delegate',
      source: 'compact',
      requiredActions: ['read-compaction-handoff', 'inspect-live-git-state', 'acknowledge-recovery'],
      createdAt: new Date().toISOString(),
    }));

    for (const toolName of [
      'Task',
      'mcp__hive-flow__agent_spawn',
      'mcp__hive-flow__queen_mission_assign',
      'mcp__hive-flow__hive_status',
    ]) {
      const result = enf.processPreToolUse({
        session_id: 'compact-delegate-session',
        tool_name: toolName,
        tool_input: {},
      });
      expect(result.hookSpecificOutput?.permissionDecision ?? 'allow', toolName).toBe('allow');
    }

    const write = enf.processPreToolUse({
      session_id: 'compact-delegate-session',
      tool_name: 'Write',
      tool_input: { file_path: join(root, 'src', 'blocked.ts'), content: 'blocked' },
    });
    expect(write.hookSpecificOutput.permissionDecision).toBe('deny');
    expect(write.hookSpecificOutput.permissionDecisionReason).toContain('POST-COMPACT RECOVERY REQUIRED');
  });

  it('keeps token-spoofed unknown actors globally escalated', () => {
    const storePath = join(root, '.hive-flow', 'agents', 'store.json');
    mkdirSync(dirname(storePath), { recursive: true });
    writeFileSync(storePath, JSON.stringify({
      agents: {
        'spoofed-agent': { config: { _spawnToken: 'stored-token' } },
      },
    }));
    process.env.HIVE_FLOW_AGENT_ID = 'spoofed-agent';

    const result = enf.processPreToolUse({
      tool_name: 'Write',
      tool_input: { file_path: '.claude/helpers/enforcement.cjs' },
    });

    expect(result.hookSpecificOutput.permissionDecision).toBe('deny');
    expect(result.hookSpecificOutput.permissionDecisionReason).toContain('Agent token verification failed');
    expect(readScopedState('agent', 'spoofed-agent')).toBeNull();
    expect(readScopedState('global', 'global')?.level).toBe(enf.LEVELS.RESTRICTED);
  });

  it('escalates coordinator non-substrate attacks to project scope without global halt', () => {
    for (const command of [
      'HIVE_FLOW_PROJECT_ROOT=/tmp/spoofed node v3/@hive-flow/cli/bin/cli.js status',
      'export CLAUDE_PROJECT_DIR=/tmp/spoofed',
      'rm -rf /',
    ]) {
      clearAgentEnv();
      resetModule();
      resetEnforcementStoresForTest();
      const projectId = enf.resolveScopeContext().projectId;

      const result = enf.processPreToolUse({
        tool_name: 'Bash',
        tool_input: { command },
      });

      expect(result.hookSpecificOutput.permissionDecision, command).toBe('deny');
      expect(readScopedState('project', projectId)?.level, command).toBe(enf.LEVELS.WARNED);
      expect(readScopedState('global', 'global'), command).toBeNull();
    }
  });

  it('allows value-safe secret set-check expansions without allowing value expansion', () => {
    const safeLiteral = fc.string({ minLength: 0, maxLength: 16 }).filter(value => !/[}$`\\$]/.test(value));
    const secretVar = fc.constantFrom('OPENROUTER_API_KEY', 'OPENAI_API_KEY', 'ANTHROPIC_API_KEY');
    const state = {
      level: 0,
      violations: 0,
      restrictedGroups: [],
      history: [],
      integrityCompromised: false,
    };

    fc.assert(
      fc.property(secretVar, safeLiteral, (name, literal) => {
        expect(enf.detectCircumvention(
          'Bash',
          { command: `echo "\${${name}:+${literal}}"` },
          state,
        ).circumvention).toBe(false);
        expect(enf.detectCircumvention(
          'Bash',
          { command: `printf "%s\\n" "\${${name}+${literal}}"` },
          state,
        ).circumvention).toBe(false);
      }),
      { seed: 20_609, numRuns: PROPERTY_RUNS },
    );

    for (const command of [
      'echo "${OPENROUTER_API_KEY:-}"',
      'echo "${OPENROUTER_API_KEY:?missing}"',
      'echo "${OPENROUTER_API_KEY:+$OPENROUTER_API_KEY}"',
      'printf "%s\\n" "$OPENROUTER_API_KEY"',
    ]) {
      expect(enf.detectCircumvention('Bash', { command }, state).circumvention, command).toBe(true);
    }
  });

  it('denies first non-substrate global protected writes and escalates only on cross-channel repeat', () => {
    const globalProtectedTargets = [
      'v3/@hive-flow/cli/src/permission-guard/gate.ts',
      'v3/@hive-flow/cli/dist/src/mcp-tools/index.js',
      'scripts/install-enforcement.mjs',
      '.env',
    ];

    for (const [index, filePath] of globalProtectedTargets.entries()) {
      clearAgentEnv();
      resetModule();
      resetEnforcementStoresForTest();
      const agentId = `global-protected-agent-${index}`;
      process.env.HIVE_FLOW_AGENT_ID = agentId;

      const result = enf.processPreToolUse({
        tool_name: 'Write',
        tool_input: { file_path: filePath },
      });

      expect(result.hookSpecificOutput.permissionDecision, filePath).toBe('deny');
      expect(result.hookSpecificOutput.permissionDecisionReason, filePath).not.toContain('Escalated');
      expect(readScopedState('agent', agentId), filePath).toBeNull();
      expect(readScopedState('global', 'global'), filePath).toBeNull();
    }

    clearAgentEnv();
    resetModule();
    resetEnforcementStoresForTest();
    process.env.HIVE_FLOW_AGENT_ID = 'global-protected-repeat-agent';

    enf.processPreToolUse({
      tool_name: 'Write',
      tool_input: { file_path: 'v3/@hive-flow/cli/src/permission-guard/gate.ts' },
    });
    const repeat = enf.processPreToolUse({
      tool_name: 'Bash',
      tool_input: { command: 'printf x >> v3/@hive-flow/cli/src/permission-guard/gate.ts' },
    });

    expect(repeat.hookSpecificOutput.permissionDecision).toBe('deny');
    expect(repeat.hookSpecificOutput.permissionDecisionReason).toContain('Cross-channel repeat');
    expect(readScopedState('agent', 'global-protected-repeat-agent')?.level).toBe(enf.LEVELS.RESTRICTED);
    expect(readScopedState('global', 'global')).toBeNull();

    clearAgentEnv();
    resetModule();
    resetEnforcementStoresForTest();
    process.env.HIVE_FLOW_AGENT_ID = 'project-workflow-agent';

    const workflowResult = enf.processPreToolUse({
      tool_name: 'Write',
      tool_input: { file_path: '.hive-flow/workflows/state.json' },
    });

    expect(workflowResult.hookSpecificOutput.permissionDecision).toBe('deny');
    expect(readScopedState('agent', 'project-workflow-agent')).toBeNull();
    expect(readScopedState('global', 'global')).toBeNull();
  });

  it('E2E: RESTRICTED scoped state blocks write tools before execution', () => {
    process.env.HIVE_FLOW_AGENT_ID = 'restricted-agent';
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
    process.env.HIVE_FLOW_AGENT_ID = 'grep-worker';

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
    process.env.HIVE_FLOW_AGENT_ID = 'restricted-writer';
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
    )).toMatchObject({ circumvention: true });
    expect(enf.detectCircumvention(
      'Bash',
      { command: 'node ./random-script.js' },
      restricted,
    ).denyOnly).toBe(true);

    expect(enf.detectCircumvention(
      'Bash',
      { command: 'node "$CLAUDE_PROJECT_DIR"/.claude/helpers/hook-handler.cjs permission-guard; node ./random-script.js' },
      restricted,
    )).toMatchObject({ circumvention: true });
    expect(enf.detectCircumvention(
      'Bash',
      { command: 'node "$CLAUDE_PROJECT_DIR"/.claude/helpers/hook-handler.cjs permission-guard; node ./random-script.js' },
      restricted,
    ).denyOnly).toBe(true);

    expect(enf.detectCircumvention(
      'Bash',
      { command: 'timeout 25 .audit/scripts/hf-tmux-control.sh send-codex "handoff ready"' },
      restricted,
    ).circumvention).toBe(false);

    process.env.HIVE_FLOW_AGENT_ID = 'restricted-script-agent';
    writeScopedState('agent', 'restricted-script-agent', {
      level: enf.LEVELS.RESTRICTED,
      violations: 2,
      restrictedGroups: ['write'],
    });

    const result = enf.processPreToolUse({
      tool_name: 'Bash',
      tool_input: { command: 'node ./random-script.js' },
    });

    expect(result.hookSpecificOutput.permissionDecision).toBe('deny');
    expect(readScopedState('agent', 'restricted-script-agent')?.level).toBe(enf.LEVELS.RESTRICTED);
    expect(readScopedState('agent', 'restricted-script-agent')?.violations).toBe(2);
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

  it('blocks direct clear-role hook invocation from Bash even with forged hook input', () => {
    const state = {
      level: 0,
      violations: 0,
      restrictedGroups: [],
      history: [],
      integrityCompromised: false,
    };

    expect(enf.detectCircumvention(
      'Bash',
      { command: 'node .claude/helpers/hook-handler.cjs clear-role' },
      state,
    ).circumvention).toBe(true);

    expect(enf.detectCircumvention(
      'Bash',
      { command: 'printf \'{"hook_event_name":"UserPromptSubmit","user_prompt":"/clear-role"}\' | node .claude/helpers/hook-handler.cjs clear-role' },
      state,
    ).circumvention).toBe(true);
  });

  it('counts compaction recovery gate denials toward hang detection', () => {
    const projectId = enf.getProjectScopeId();
    writeScopedState('global', 'global', {
      level: 0,
      violations: 0,
      restrictedGroups: [],
      consecutiveDenials: 4,
    });
    writeScopedState('project', projectId, {
      level: 0,
      violations: 0,
      restrictedGroups: [],
      consecutiveDenials: 4,
    });
    writeScopedState('session', 'session-a', {
      level: 0,
      violations: 0,
      restrictedGroups: [],
      consecutiveDenials: 4,
    });
    const recoveryPath = join(root, '.hive-flow', 'data', 'compaction-recovery-required.json');
    mkdirSync(dirname(recoveryPath), { recursive: true });
    writeFileSync(recoveryPath, JSON.stringify({
      type: 'hive-flow.compaction-recovery-required',
      sessionId: 'session-a',
      recoveryNonce: 'nonce-a',
    }));

    const result = enf.processPreToolUse({
      hook_event_name: 'PreToolUse',
      session_id: 'session-a',
      tool_name: 'Write',
      tool_input: { file_path: 'src/after-compact.ts' },
    });

    expect(result.hookSpecificOutput.permissionDecision).toBe('deny');
    expect(result.hookSpecificOutput.permissionDecisionReason).toContain('Agent appears hung');
    expect(readScopedState('session', 'session-a')?.consecutiveDenials).toBe(5);
    const projectDenials = Number(readScopedState('project', projectId)?.consecutiveDenials || 0);
    const globalDenials = Number(readScopedState('global', 'global')?.consecutiveDenials || 0);
    expect(Math.max(projectDenials, globalDenials)).toBe(4);
  });

  it('counts verification gate denials toward hang detection', () => {
    const projectId = enf.getProjectScopeId();
    writeScopedState('project', projectId, {
      level: 0,
      violations: 0,
      restrictedGroups: [],
      consecutiveDenials: 4,
    });
    const swarmDir = join(root, '.hive-flow', 'swarm');
    mkdirSync(swarmDir, { recursive: true });

    const result = enf.processPreToolUse({
      hook_event_name: 'PreToolUse',
      tool_name: 'Bash',
      tool_input: { command: 'git commit -m "needs verification"' },
    });

    expect(result.hookSpecificOutput.permissionDecision).toBe('deny');
    expect(result.hookSpecificOutput.permissionDecisionReason).toContain('Agent appears hung');
    expect(readScopedState('project', projectId)?.consecutiveDenials).toBe(5);
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
    process.env.HIVE_FLOW_AGENT_ID = 'worker-agent';
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
        resetEnforcementStoresForTest();
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

  it('logs signed root dev-override use when the carve-out allows a guarded settings write', () => {
    prepareSignedOverrideSettings('.claude/settings.json');

    const result = enf.processPreToolUse({
      tool_name: 'Write',
      tool_input: { file_path: '.claude/settings.json', content: settingsContent('valid') },
    });

    expect(result).toEqual({});
    const violations = readFileSync(join(enforcementStateRoot(), 'global', 'violations.jsonl'), 'utf8')
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as Record<string, unknown>);
    expect(violations.some((row) => row.type === 'dev-override-used')).toBe(true);
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
        resetEnforcementStoresForTest();
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
      fc.constantFrom('HIVE_FLOW_AGENT_ID', 'CLAUDE_AGENT_ID', 'CLAUDE_PARENT_AGENT_ID'),
      { nil: null },
    );
    const hookField = fc.option(fc.constantFrom('agent_id', 'agentId'), { nil: null });

    fc.assert(
      fc.property(envField, hookField, (envName, hookName) => {
        clearAgentEnv();
        resetModule();
        resetEnforcementStoresForTest();
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
        resetEnforcementStoresForTest();
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
        resetEnforcementStoresForTest();
        process.env.HIVE_FLOW_AGENT_ID = agentId;
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

  it('classifies root-spoof env vars separately from gate-bypass env vars', () => {
    const state = {
      level: 0,
      violations: 0,
      restrictedGroups: [],
      history: [],
      integrityCompromised: false,
    };

    const rootSpoofInline = enf.detectCircumvention(
      'Bash',
      { command: 'HIVE_FLOW_PROJECT_ROOT=/tmp/spoofed node v3/@hive-flow/cli/bin/cli.js status' },
      state,
    );
    expect(rootSpoofInline).toMatchObject({ circumvention: true });
    expect(rootSpoofInline).not.toHaveProperty('systemic');
    expect(rootSpoofInline).not.toHaveProperty('protectedEnforcementAttack');

    const rootSpoofExport = enf.detectCircumvention(
      'Bash',
      { command: 'export HIVE_FLOW_PROJECT_ROOT=/tmp/spoofed' },
      state,
    );
    expect(rootSpoofExport).toMatchObject({ circumvention: true });
    expect(rootSpoofExport).not.toHaveProperty('systemic');
    expect(rootSpoofExport).not.toHaveProperty('protectedEnforcementAttack');

    expect(enf.detectCircumvention(
      'Bash',
      { command: 'HIVE_FLOW_ENFORCEMENT_DISABLED=1 node .claude/helpers/hook-handler.cjs permission-guard' },
      state,
    )).toMatchObject({ circumvention: true, systemic: true });
    expect(enf.detectCircumvention(
      'Bash',
      { command: 'HIVE_FLOW_ENFORCEMENT_DISABLED=1 node .claude/helpers/hook-handler.cjs permission-guard' },
      state,
    )).not.toMatchObject({ substrateAttack: true, protectedEnforcementAttack: true });
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

  it('scoped reset output states child scopes are not implicitly reset', () => {
    process.env.CLAUDE_SESSION_ID = 'reset-session';
    writeScopedState('session', 'reset-session', {
      level: enf.LEVELS.RESTRICTED,
      violations: 2,
      restrictedGroups: ['write'],
    });
    writeScopedState('agent', 'agent-child', {
      level: enf.LEVELS.RESTRICTED,
      violations: 2,
      restrictedGroups: ['write'],
    });
    const timestamp = String(Date.now());
    const signature = createHmac('sha256', enf.getOrCreateHmacKey())
      .update(`enforcement-reset:${timestamp}`)
      .digest('hex');

    const result = enf.processResetCheck({
      user_prompt: '/reset-enforcement --session reset-session',
      _hmac_timestamp: timestamp,
      _hmac_signature: signature,
    });

    expect(result.hookSpecificOutput.additionalContext).toContain('Reset complete for session/reset-session');
    expect(result.hookSpecificOutput.additionalContext).toContain('Child scopes');
    expect(readScopedState('session', 'reset-session')?.level).toBe(enf.LEVELS.NORMAL);
    expect(readScopedState('agent', 'agent-child')?.level).toBe(enf.LEVELS.RESTRICTED);
  });

  it('does not flag inert eval text but still blocks shell eval execution', () => {
    expect(enf.isObfuscated(`node -e "console.log('eval(')"`)).toBe(false);
    expect(enf.isObfuscated("bash -c 'eval $(echo echo hi)'")).toBe(true);
  });

  it('does not treat unicode grep literals as obfuscation', () => {
    const cross = String.fromCharCode(0x2716);
    const command = `rg -n '${cross}|Escalated|permissionDecisionReason' .claude/helpers/enforcement.cjs`;

    expect(enf.detectCircumvention('Bash', { command }, {
      level: 0,
      violations: 0,
      restrictedGroups: [],
      history: [],
      integrityCompromised: false,
    }).circumvention).toBe(false);
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
    process.env.HIVE_FLOW_AGENT_ID = 'inline-eval-worker';

    for (const command of [
      'bash -c "node --eval \\"console.log(1)\\""',
      'npx node -e "console.log(1)"',
      'pnpm --dir v3 --filter @hive-flow/cli exec node -e "console.log(1)"',
      'npm exec -- node -e "console.log(1)"',
      'yarn node -e "console.log(1)"',
      'nice node -e "console.log(1)"',
      'nohup node --eval=console.log(1)',
      'timeout 1 node -p "1"',
      'xargs node -e "console.log(1)"',
      'find . -exec node -e "console.log(1)" {} \\;',
      'osascript -e "do shell script \\"touch src/generated.ts\\""',
      'tsx -e "console.log(1)"',
      'deno run -',
      'python -m runpy src/generated.py',
      'echo "console.log(1)" | node',
      'node /dev/stdin',
      'node -r ./loader.js src/app.js',
      'NODE_OPTIONS="--require ./loader.js" node src/app.js',
      'fish -c "node -e \\"console.log(1)\\""',
      'busybox sh -c "node -e \\"console.log(1)\\""',
      'yarn dlx node -e "console.log(1)"',
      'bunx node -e "console.log(1)"',
      'n"o"de -e "console.log(1)"',
      'node <(echo "console.log(1)")',
      'node <<EOF\nconsole.log(1)\nEOF',
      '( node -e "console.log(1)" )',
      '{ node -e "console.log(1)"; }',
      '( ( node -e "console.log(1)" ) )',
      'true && ( node -e "console.log(1)" )',
      'if true; then node -e "console.log(1)"; fi',
      'for i in 1; do node -e "console.log(1)"; done',
      'while false; do python3 -c "import os"; done',
      'until true; do node -e "console.log(1)"; done',
      'case x in y) node -e "console.log(1)";; esac',
      '( python3 -c "import os" )',
      'echo a\nnode -e "console.log(1)"',
      'echo a\r\nnode -e "console.log(1)"',
      'cd /tmp\n\nnode -e "console.log(1)"',
      `echo a ${'\\'}\n node -e "console.log(1)"`,
      '$(node -e "console.log(1)")',
      'x=$(node -e "console.log(1)")',
      'echo $(node -e "console.log(1)")',
      '`node -e "console.log(1)"`',
      'python2 -c "1"',
      'nodejs -e "1"',
      'node22 -e "1"',
      'pypy3 -c "1"',
      'exec -a fakebin node -e "console.log(1)"',
      'coproc node -e "1"',
      'coproc node -p "1"',
      'coproc python3 -c "1"',
      'coproc COPROC node -e "1"',
      'coproc MYPROC { node -e "1"; }',
      'ruby -rfileutils -e "1"',
      'python -m runpy mod',
      'python -m',
    ]) {
      const result = enf.processPreToolUse({
        tool_name: 'Bash',
        tool_input: { command },
      });

      expect(result.hookSpecificOutput, command).toBeDefined();
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
      'timeout 30 node scripts/check-project.js',
      'nice node scripts/check-project.js',
      'find . -name "*.ts" -exec echo {} \\;',
      'printf "%s\\n" src/index.ts | xargs echo',
      '( node scripts/check-project.js )',
      '{ node scripts/check-project.js; }',
      'echo done\nnode build.js',
      'tag=$(git rev-parse HEAD)',
      'files=$(ls *.ts)',
      'node22 scripts/x.js',
      'exec node scripts/x.js',
      'coproc node scripts/x.js',
      'coproc tail -f app.log',
      'coproc { echo hi; }',
      'ruby -rubygems app.rb',
      'ruby -run -e httpd',
      'cat data.json | node process.js',
      'curl -s https://example.test/x | node ingest.js',
      'git log | node report.js arg1',
      'cat input.txt | python3 myscript.py',
      'seq 1 100 | node sum.js',
      'cat fixture.json | python3 -m mypkg.cli',
      'cat log | ruby filter.rb',
      'node process.js < input.txt',
      "grep 'node -e' README.md",
      "grep '| node' README.md",
      "awk '/pipe/ { print }' README.md",
      'cat <<EOF\nthis is data mentioning | node and node -e, not a command\nEOF',
      'python -m pytest',
      'python3 -m pip install flask',
      'python3 -m venv env',
      'python3 -m http.server',
    ]) {
      expect(enf.detectCircumvention('Bash', { command }, state).circumvention, command).toBe(false);
    }
  });

  it('continues denying bare interpreter program stdin through the .cjs gate', () => {
    process.env.HIVE_FLOW_AGENT_ID = 'bare-stdin-inline-worker';

    for (const command of [
      'echo "console.log(1)" | node',
      'node /dev/stdin',
      'node -',
      'cat prog.js | node',
      'node <<EOF\nconsole.log(1)\nEOF',
    ]) {
      const result = enf.processPreToolUse({
        tool_name: 'Bash',
        tool_input: { command },
      });

      expect(result.hookSpecificOutput?.permissionDecision, command).toBe('deny');
      expect(result.hookSpecificOutput?.permissionDecisionReason, command).toContain('Inline code execution is blocked');
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

  it('isolates the denial ledger per actor (one actor cannot escalate another)', () => {
    const first = enf.evaluateProtectedMutationDenial(
      { agentId: 'ledger-actor-a' },
      '.claude/helpers/role-enforcement.cjs',
      'write',
      1_000,
    );
    expect(first.escalate).toBe(false);

    // A DIFFERENT actor writing the same target via a different channel must NOT be a
    // cross-channel repeat — the ledger is keyed per (actor,target), so one agent's denial
    // cannot escalate another (prevents cross-actor escalation DoS).
    const other = enf.evaluateProtectedMutationDenial(
      { agentId: 'ledger-actor-b' },
      '.claude/helpers/role-enforcement.cjs',
      'bash',
      2_000,
    );
    expect(other.escalate).toBe(false);
  });

  it('prunes denial-ledger entries older than the 30-minute window', () => {
    const stale = { agentId: 'ledger-window-stale' };
    enf.evaluateProtectedMutationDenial(stale, '.claude/helpers/role-enforcement.cjs', 'write', 1_000);
    const afterWindow = enf.evaluateProtectedMutationDenial(
      stale,
      '.claude/helpers/role-enforcement.cjs',
      'bash',
      1_000 + 31 * 60 * 1_000,
    );
    // The prior 'write' aged out of the 30-minute window → not a cross-channel repeat.
    expect(afterWindow.escalate).toBe(false);

    const fresh = { agentId: 'ledger-window-fresh' };
    enf.evaluateProtectedMutationDenial(fresh, '.claude/helpers/role-enforcement.cjs', 'write', 1_000);
    const withinWindow = enf.evaluateProtectedMutationDenial(
      fresh,
      '.claude/helpers/role-enforcement.cjs',
      'bash',
      1_000 + 10 * 60 * 1_000,
    );
    // Within the window → genuine cross-channel repeat escalates.
    expect(withinWindow.escalate).toBe(true);
  });

  it('normalizes equivalent relative denial targets to the same ledger key', () => {
    const ctx = { agentId: 'ledger-normalize' };
    enf.evaluateProtectedMutationDenial(ctx, '.claude/helpers/role-enforcement.cjs', 'write', 1_000);
    const variant = enf.evaluateProtectedMutationDenial(
      ctx,
      './.claude/helpers/role-enforcement.cjs',
      'bash',
      2_000,
    );
    // './x' and 'x' normalize to the same target → recognized as a cross-channel repeat.
    expect(variant.escalate).toBe(true);
  });

  it('preserves cross-channel ledger memory after the file grows past the legacy 10KB read cap', () => {
    const ctx = { agentId: 'ledger-bigfile-actor' };
    const target = '.claude/helpers/role-enforcement.cjs';
    // Record a first-channel ('write') denial for our actor+target.
    enf.evaluateProtectedMutationDenial(ctx, target, 'write', 1_000);
    // Grow the signed ledger well past the shared 10KB readJson cap with other actors' entries.
    // A signed ~60-entry ledger far exceeds 10KB; the legacy cap silently rebuilt it empty,
    // dropping the original 'write' and breaking Tier-2 cross-channel memory under churn.
    for (let i = 0; i < 60; i++) {
      enf.evaluateProtectedMutationDenial(
        { agentId: `ledger-filler-${i}` },
        `.claude/helpers/filler-${i}.cjs`,
        'write',
        1_100 + i,
      );
    }
    // A cross-channel ('bash') repeat for the ORIGINAL actor+target must STILL escalate — the
    // ledger must not have silently reset and forgotten the original 'write'.
    const repeat = enf.evaluateProtectedMutationDenial(ctx, target, 'bash', 5_000);
    expect(repeat.escalate).toBe(true);
  });

  it('keeps sequential write-to-bash denial ledger escalation and channel union intact', () => {
    const ctx = { agentId: 'ledger-locked-sequential' };
    const target = '.claude/helpers/hook-handler.cjs';

    const first = enf.evaluateProtectedMutationDenial(ctx, target, 'write', 1_000);
    const second = enf.evaluateProtectedMutationDenial(ctx, target, 'bash', 2_000);

    expect(first.escalate).toBe(false);
    expect(second.escalate).toBe(true);
    expect(second.channels).toEqual(['write', 'bash']);

    const ledger = readDenialLedgerState();
    const entries = Object.values(ledger.entries as Record<string, { channels: string[] }>);
    expect(entries).toHaveLength(1);
    expect(entries[0].channels).toEqual(['write', 'bash']);
  });

  it('caps denial ledger entries per actor with oldest eviction while preserving under-cap escalation', () => {
    const ctx = { agentId: 'ledger-cap-actor' };
    const target = (i: number) => `.claude/helpers/cap-${String(i).padStart(2, '0')}.cjs`;

    for (let i = 0; i < 32; i++) {
      const result = enf.evaluateProtectedMutationDenial(ctx, target(i), 'write', 1_000 + i);
      expect(result.escalate).toBe(false);
    }

    const underCapRepeat = enf.evaluateProtectedMutationDenial(ctx, target(0), 'bash', 2_000);
    expect(underCapRepeat.escalate).toBe(true);

    enf.evaluateProtectedMutationDenial(ctx, target(32), 'write', 3_000);

    const ledger = readDenialLedgerState();
    const entries = Object.values(ledger.entries as Record<string, { actor: string; target: string }>)
      .filter(entry => entry.actor === 'agent:ledger-cap-actor');
    expect(entries).toHaveLength(32);
    expect(entries.some(entry => entry.target.endsWith(join('.claude', 'helpers', 'cap-00.cjs')))).toBe(true);
    expect(entries.some(entry => entry.target.endsWith(join('.claude', 'helpers', 'cap-01.cjs')))).toBe(false);
    expect(entries.some(entry => entry.target.endsWith(join('.claude', 'helpers', 'cap-32.cjs')))).toBe(true);
  });

  it('makes denial ledger re-escalation idempotent for the same offense while distinct targets still escalate', () => {
    const ctx = { agentId: 'ledger-idempotent-actor' };
    const firstTarget = '.claude/helpers/hook-handler.cjs';
    const secondTarget = '.claude/helpers/role-enforcement.cjs';

    expect(enf.evaluateProtectedMutationDenial(ctx, firstTarget, 'write', 1_000).escalate).toBe(false);
    expect(enf.evaluateProtectedMutationDenial(ctx, firstTarget, 'bash', 2_000).escalate).toBe(true);
    expect(enf.evaluateProtectedMutationDenial(ctx, firstTarget, 'bash', 3_000).escalate).toBe(false);
    expect(enf.evaluateProtectedMutationDenial(ctx, firstTarget, 'write', 4_000).escalate).toBe(false);

    expect(enf.evaluateProtectedMutationDenial(ctx, secondTarget, 'write', 5_000).escalate).toBe(false);
    expect(enf.evaluateProtectedMutationDenial(ctx, secondTarget, 'bash', 6_000).escalate).toBe(true);

    const ledger = readDenialLedgerState();
    const first = Object.values(ledger.entries as Record<string, { target: string; escalated?: boolean }>)
      .find(entry => entry.target.endsWith(join('.claude', 'helpers', 'hook-handler.cjs')));
    expect(first?.escalated).toBe(true);

    rmSync(denialLedgerPath(), { force: true });
    expect(enf.evaluateProtectedMutationDenial(ctx, firstTarget, 'write', 7_000).escalate).toBe(false);
    expect(enf.evaluateProtectedMutationDenial(ctx, firstTarget, 'bash', 8_000).escalate).toBe(true);
  });

  it('serializes denial ledger read-modify-write through an exclusive lock file', () => {
    const openedLocks: string[] = [];
    const unlinkedLocks: string[] = [];
    const originalOpenSync = fsForLockSpy.openSync;
    const originalUnlinkSync = fsForLockSpy.unlinkSync;

    (fsForLockSpy as any).openSync = (file: string, flags: string, ...rest: unknown[]) => {
      if (String(file).endsWith('denial-ledger.lock') && flags === 'wx') {
        openedLocks.push(String(file));
      }
      return (originalOpenSync as any).call(fsForLockSpy, file, flags, ...rest);
    };
    (fsForLockSpy as any).unlinkSync = (file: string, ...rest: unknown[]) => {
      if (String(file).endsWith('denial-ledger.lock')) {
        unlinkedLocks.push(String(file));
      }
      return (originalUnlinkSync as any).call(fsForLockSpy, file, ...rest);
    };

    try {
      const result = enf.evaluateProtectedMutationDenial(
        { agentId: 'ledger-lock-observed' },
        '.claude/helpers/hook-handler.cjs',
        'write',
        1_000,
      );

      expect(result.escalate).toBe(false);
      expect(openedLocks).toContain(denialLedgerLockPath());
      expect(unlinkedLocks).toContain(denialLedgerLockPath());
      expect(existsSync(denialLedgerLockPath())).toBe(false);
    } finally {
      (fsForLockSpy as any).openSync = originalOpenSync;
      (fsForLockSpy as any).unlinkSync = originalUnlinkSync;
    }
  });

  it('breaks stale denial ledger locks before updating the ledger', () => {
    const lockPath = denialLedgerLockPath();
    mkdirSync(dirname(lockPath), { recursive: true });
    writeFileSync(lockPath, 'stale');
    utimesSync(lockPath, new Date(0), new Date(0));

    const result = enf.evaluateProtectedMutationDenial(
      { agentId: 'ledger-stale-lock' },
      '.claude/helpers/hook-handler.cjs',
      'write',
      1_000,
    );

    expect(result.escalate).toBe(false);
    expect(existsSync(lockPath)).toBe(false);
    const ledger = readDenialLedgerState();
    const entries = Object.values(ledger.entries as Record<string, { actor: string }>);
    expect(entries.some(entry => entry.actor === 'agent:ledger-stale-lock')).toBe(true);
  });

  it('times out on fresh held denial ledger locks without throwing or losing ledger memory', () => {
    const ctx = { agentId: 'ledger-held-lock' };
    const target = '.claude/helpers/hook-handler.cjs';
    enf.evaluateProtectedMutationDenial(ctx, target, 'write', 1_000);

    const lockPath = denialLedgerLockPath();
    mkdirSync(dirname(lockPath), { recursive: true });
    writeFileSync(lockPath, 'held');

    const result = enf.evaluateProtectedMutationDenial(ctx, target, 'bash', 2_000);

    expect(result.escalate).toBe(true);
    expect(result.channels).toEqual(['write', 'bash']);
    const ledger = readDenialLedgerState();
    const entries = Object.values(ledger.entries as Record<string, { channels: string[] }>);
    expect(entries.some(entry => entry.channels.includes('write') && entry.channels.includes('bash'))).toBe(true);
    expect(readViolationRows().some(row => row.type === 'denial-ledger-lock-timeout')).toBe(true);
    expect(existsSync(lockPath)).toBe(true);
  });
});
