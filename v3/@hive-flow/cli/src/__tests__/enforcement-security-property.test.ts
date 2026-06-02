import { describe, expect, it, afterAll, beforeEach } from 'vitest';
import fc from 'fast-check';
import { createRequire } from 'node:module';
import { copyFileSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdtempSync } from 'node:fs';
import { propertyRunsFromEnv } from './property-runs.js';

const PROPERTY_RUNS = propertyRunsFromEnv(100);

const require = createRequire(import.meta.url);
const here = dirname(fileURLToPath(import.meta.url));
const source = resolve(here, '../../../../../.claude/helpers/enforcement.cjs');
const settingsSource = resolve(here, '../../../../../.claude/settings.json');
const root = mkdtempSync(join(tmpdir(), 'hive-flow-enforcement-security-'));
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

function statePath(): string {
  return enf.getStateFile();
}

function scopedStatePath(scopeType: string, scopeId: string): string {
  return join(root, '.hive-flow', 'enforcement', `${scopeType}s`, scopeId, 'state.json');
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
      '.claude/helpers/enforcement.cjs',
      '.claude/helpers/role-enforcement.cjs',
      '.hive-flow/enforcement/state.json',
      'v3/@hive-flow/cli/dist/src/mcp-tools/index.js',
    );
    const toolName = fc.constantFrom('Write', 'Edit', 'MultiEdit', 'mcp__filesystem__write_file', 'mcp__filesystem__move_file');

    fc.assert(
      fc.property(protectedLeaves, toolName, (leaf, tool) => {
        const input = tool === 'mcp__filesystem__move_file'
          ? { source: 'tmp.txt', destination: leaf }
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

  it('does not classify normal hive data writes as protected path circumvention', () => {
    expect(enf.isProtectedPath(join(root, '.hive-flow', 'data', 'watcher-hive.json'))).toBe(false);
    expect(enf.isProtectedPath(join(root, '.hive-flow', 'data', 'hive.done'))).toBe(false);
    expect(enf.isGlobalProtectedPath(join(root, '.claude', 'helpers', 'enforcement.cjs'))).toBe(true);
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

  it('scopes unknown ordinary violations to project state instead of global', () => {
    const result = enf.processPreToolUse({
      tool_name: 'Bash',
      tool_input: { command: "bash -c 'eval $(echo echo hi)'" },
    });

    const projectId = enf.resolveScopeContext().projectId;
    expect(result.hookSpecificOutput.hookEventName).toBe('PreToolUse');
    expect(result.hookSpecificOutput.permissionDecision).toBe('deny');
    expect(readScopedState('project', projectId)?.level).toBe(enf.LEVELS.WARNED);
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

  it('does not flag inert eval text but still blocks shell eval execution', () => {
    expect(enf.isObfuscated(`node -e "console.log('eval(')"`)).toBe(false);
    expect(enf.isObfuscated("bash -c 'eval $(echo echo hi)'")).toBe(true);
  });
});
