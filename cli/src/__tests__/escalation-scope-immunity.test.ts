import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import fc from 'fast-check';
import { copyFileSync, mkdirSync, realpathSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdtempSync } from 'node:fs';
import { propertyRunsFromEnv } from './property-runs.js';

const PROPERTY_RUNS = propertyRunsFromEnv(100);

const require = createRequire(import.meta.url);
const here = dirname(fileURLToPath(import.meta.url));
const source = resolve(here, '../../../.claude/helpers/enforcement.cjs');
const layoutPathsSource = resolve(here, '../../../.claude/helpers/layout-paths.cjs');
const policySource = resolve(here, '../permission-guard/protected-paths.cjs');
const policyJsonSource = resolve(here, '../permission-guard/protected-paths.policy.json');
const root = realpathSync(mkdtempSync(join(tmpdir(), 'hive-flow-escalation-scope-')));
const previousHiveFlowHome = process.env.HIVE_FLOW_HOME;
const helperPath = join(root, '.claude', 'helpers', 'enforcement.cjs');
mkdirSync(dirname(helperPath), { recursive: true });
copyFileSync(source, helperPath);
copyFileSync(layoutPathsSource, join(dirname(helperPath), 'layout-paths.cjs'));
const policyPath = join(root, 'cli', 'src', 'permission-guard', 'protected-paths.cjs');
mkdirSync(dirname(policyPath), { recursive: true });
copyFileSync(policySource, policyPath);
copyFileSync(policyJsonSource, join(dirname(policyPath), 'protected-paths.policy.json'));

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let enf: any;

function hiveHomeForTest(): string {
  return join(root, 'global-hive-home');
}

function resetModule(): void {
  process.env.HIVE_FLOW_HOME = hiveHomeForTest();
  rmSync(join(root, '.hive-flow', 'enforcement'), { recursive: true, force: true });
  rmSync(hiveHomeForTest(), { recursive: true, force: true });
  delete require.cache[require.resolve(helperPath)];
  enf = require(helperPath);
}

function ctx(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    actorKind: 'coordinator',
    identityTrusted: false,
    agentId: null,
    hiveId: null,
    projectId: 'scope-test-project',
    ...overrides,
  };
}

function violation(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    reason: 'scope-test violation',
    severity: 'critical',
    restrictionGroups: ['exec', 'write'],
    ...overrides,
  };
}

describe('C5 escalation scope immunity', () => {
  beforeEach(() => {
    resetModule();
  });

  afterAll(() => {
    if (previousHiveFlowHome === undefined) delete process.env.HIVE_FLOW_HOME;
    else process.env.HIVE_FLOW_HOME = previousHiveFlowHome;
    rmSync(root, { recursive: true, force: true });
  });

  it('routes coordinator systemic violations to project scope unless substrate floor applies', () => {
    const result = enf.escalateScoped(
      ctx(),
      violation({ systemic: true }),
    );

    expect(result.scopeType).toBe('project');
    expect(result.scopeId).toBe('scope-test-project');
  });

  it('does not grant coordinator immunity when identity is trusted but agent id is absent', () => {
    const result = enf.escalateScoped(
      ctx({ identityTrusted: true, hiveId: 'trusted-hive' }),
      violation(),
    );

    expect(result.scopeType).toBe('hive');
    expect(result.scopeId).toBe('trusted-hive');
  });

  it('keeps trusted-agent systemic violations agent-scoped instead of global', () => {
    const result = enf.escalateScoped(
      ctx({ actorKind: 'agent', identityTrusted: true, agentId: 'trusted-agent', hiveId: 'trusted-hive' }),
      violation({ systemic: true }),
    );

    expect(result.scopeType).toBe('agent');
    expect(result.scopeId).toBe('trusted-agent');
  });

  it('keeps substrate attacks global even for trusted agents', () => {
    const result = enf.escalateScoped(
      ctx({ actorKind: 'agent', identityTrusted: true, agentId: 'trusted-agent', hiveId: 'trusted-hive' }),
      violation({ substrateAttack: true, protectedEnforcementAttack: true, systemic: true }),
    );

    expect(result.scopeType).toBe('global');
    expect(result.scopeId).toBe('global');
  });

  it('routes arbitrary coordinator systemic violations to the current project', () => {
    fc.assert(
      fc.property(
        fc.string({ minLength: 1, maxLength: 24 }).filter((s) => !s.includes('/')),
        fc.boolean(),
        (projectId, identityTrusted) => {
          resetModule();
          const result = enf.escalateScoped(
            ctx({ projectId, identityTrusted }),
            violation({ systemic: true }),
          );

          expect(result.scopeType).toBe('project');
          expect(result.scopeId).toBe(projectId);
        },
      ),
      { seed: 20_606_06, numRuns: PROPERTY_RUNS },
    );
  });
});
