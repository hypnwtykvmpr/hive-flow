import { describe, expect, it, afterAll, beforeEach } from 'vitest';
import fc from 'fast-check';
import { createRequire } from 'node:module';
import { copyFileSync, existsSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdtempSync } from 'node:fs';
import { createHmac } from 'node:crypto';
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
  mkdirSync(dirname(overridePath), { recursive: true });
  writeFileSync(overridePath, `HIVE_FLOW_DEV_OVERRIDE=on\nHIVE_FLOW_DEV_OVERRIDE_TOKEN=${createRootOverrideToken('enforcement-config-token')}\n`);
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

  it('scopes ordinary agent violations to the agent and leaves global untouched', () => {
    process.env.AGENTIC_FLOW_AGENT_ID = 'agent-a';

    const result = enf.processPreToolUse({
      tool_name: 'Write',
      tool_input: { file_path: '.hive-flow/workflows/state.json' },
    });

    expect(result.hookSpecificOutput.hookEventName).toBe('PreToolUse');
    expect(result.hookSpecificOutput.permissionDecision).toBe('deny');
    expect(readScopedState('agent', 'agent-a')?.level).toBe(enf.LEVELS.RESTRICTED);
    expect(readScopedState('global', 'global')).toBeNull();
  });

  it('scopes native Task hook agent_id violations to the agent and ignores session ids', () => {
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
    expect(readScopedState('agent', 'native-task-agent')?.level).toBe(enf.LEVELS.RESTRICTED);
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

  it('still escalates enforcement-file attacks globally', () => {
    process.env.AGENTIC_FLOW_AGENT_ID = 'agent-b';

    const result = enf.processPreToolUse({
      tool_name: 'Write',
      tool_input: { file_path: '.claude/helpers/enforcement.cjs' },
    });

    expect(result.hookSpecificOutput.hookEventName).toBe('PreToolUse');
    expect(result.hookSpecificOutput.permissionDecision).toBe('deny');
    expect(readScopedState('global', 'global')?.level).toBe(enf.LEVELS.RESTRICTED);
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
    ).circumvention).toBe(true);

    expect(enf.detectCircumvention(
      'Bash',
      { command: 'node "$CLAUDE_PROJECT_DIR"/.claude/helpers/hook-handler.cjs permission-guard; node ./random-script.js' },
      restricted,
    ).circumvention).toBe(true);
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

  it('allows signed-root protected config writes when dev override is active', () => {
    enableDevOverride();
    issueRootOverrideToken();

    const result = enf.processPreToolUse({
      tool_name: 'Write',
      tool_input: { file_path: '.claude/settings.json' },
    });

    expect(result).toEqual({});
  });

  it('allows signed-root protected config writes when the signed token is in the override file', () => {
    writeRootOverrideTokenToConfig();

    const result = enf.processPreToolUse({
      tool_name: 'Write',
      tool_input: { file_path: '.claude/settings.json' },
    });

    expect(result).toEqual({});
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

  it('classifies HIVE_FLOW_PROJECT_ROOT manipulation as enforcement circumvention', () => {
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
    ).circumvention).toBe(true);

    expect(enf.detectCircumvention(
      'Bash',
      { command: 'export HIVE_FLOW_PROJECT_ROOT=/tmp/spoofed' },
      state,
    ).circumvention).toBe(true);
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
  });
});
