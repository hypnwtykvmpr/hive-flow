import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import { mergeWithDefaults } from '../default-config.js';
import { evaluate } from '../gate.js';
import type { AuditLogEntry, GateResult, HookInput, PermissionConfig } from '../types.js';

interface GateRun {
  result: GateResult;
  entries: AuditLogEntry[];
}

interface GoldenFixture {
  trustedRootBranchSwitches: string[];
  pathRestores: string[];
  dangerousOrAmbiguous: string[];
}

const here = dirname(fileURLToPath(import.meta.url));
const golden = JSON.parse(readFileSync(
  join(here, 'fixtures', 'git-checkout-branch-policy.golden.json'),
  'utf8',
)) as GoldenFixture;

function bashInput(command: string, sessionId = 'trusted-root-checkout-session'): HookInput {
  return {
    tool_name: 'Bash',
    tool_input: { command },
    cwd: '/project',
    session_id: sessionId,
  };
}

function bashInputWithoutSession(command: string): HookInput {
  return {
    tool_name: 'Bash',
    tool_input: { command },
    cwd: '/project',
  };
}

async function evaluateWithLog(
  input: HookInput,
  config: Partial<PermissionConfig> = {},
): Promise<GateRun> {
  const root = mkdtempSync(join(tmpdir(), 'git-checkout-branch-policy-'));
  const logFile = join(root, 'permission-log.jsonl');
  try {
    const result = await evaluate(input, mergeWithDefaults({
      disable_vote_learner: true,
      llm_jury_budget_dir: join(root, 'budget'),
      log_file: logFile,
      ...config,
    }));
    const entries = readFileSync(logFile, 'utf8')
      .trim()
      .split('\n')
      .filter(Boolean)
      .map(line => JSON.parse(line) as AuditLogEntry);
    return { result, entries };
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

async function evaluateAsSubagent(input: HookInput): Promise<GateRun> {
  const previousAgentId = process.env.HIVE_FLOW_AGENT_ID;
  process.env.HIVE_FLOW_AGENT_ID = 'worker-checkout';
  try {
    return await evaluateWithLog(input);
  } finally {
    if (previousAgentId === undefined) {
      delete process.env.HIVE_FLOW_AGENT_ID;
    } else {
      process.env.HIVE_FLOW_AGENT_ID = previousAgentId;
    }
  }
}

function lastLayer(run: GateRun): string | undefined {
  return run.entries.at(-1)?.layer;
}

function autoDenyEntry(run: GateRun): AuditLogEntry | undefined {
  return run.entries.find(entry => entry.layer === 'auto-deny');
}

const branchChar = fc.constantFrom(...'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789._-');

const branchSegment = fc
  .array(branchChar, { minLength: 1, maxLength: 18 })
  .map(chars => chars.join(''))
  .filter(segment => (
    segment !== '.' &&
    segment !== '..' &&
    !segment.startsWith('.') &&
    !segment.endsWith('.') &&
    !segment.endsWith('.lock')
  ));

const branchName = fc
  .array(branchSegment, { minLength: 1, maxLength: 4 })
  .map(segments => segments.join('/'))
  .filter(isGitBranchRefnameCandidate);

function isGitBranchRefnameCandidate(name: string): boolean {
  return (
    name.length > 0 &&
    name !== 'HEAD' &&
    !/^[0-9a-f]{7,40}$/i.test(name) &&
    /^[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(name) &&
    !name.startsWith('-') &&
    !name.startsWith('.') &&
    !name.endsWith('.') &&
    !name.endsWith('.lock') &&
    !name.includes('..') &&
    !name.includes('@{') &&
    !name.includes('//') &&
    name.split('/').every(segment => (
      segment.length > 0 &&
      segment !== '.' &&
      segment !== '..' &&
      !segment.startsWith('.') &&
      !segment.endsWith('.') &&
      !segment.endsWith('.lock')
    ))
  );
}

const checkoutWrapper = fc.constantFrom(
  'command git checkout',
  'env git checkout',
  'git -C /tmp/repo checkout',
  '/usr/bin/git -C /tmp/repo checkout',
  'GIT_WORK_TREE=/tmp git checkout',
  'git checkout -b',
  'git checkout -B',
);

describe('trusted-root git checkout branch policy', () => {
  it.each(golden.trustedRootBranchSwitches)('lets trusted-root branch checkout reach the inline jury: %s', async (command) => {
    const run = await evaluateWithLog(bashInput(command));

    expect(run.result.decision).toBe('allow');
    expect(lastLayer(run)).toBe('inline-jury');
    expect(autoDenyEntry(run)).toBeUndefined();
  });

  it('treats a Codex env session as a trusted-root permission session', async () => {
    const previousCodex = process.env.CODEX_SESSION_ID;
    const previousClaude = process.env.CLAUDE_SESSION_ID;
    const previousHive = process.env.HIVE_FLOW_SESSION_ID;
    process.env.CODEX_SESSION_ID = 'codex-trusted-root';
    delete process.env.CLAUDE_SESSION_ID;
    delete process.env.HIVE_FLOW_SESSION_ID;
    try {
      const run = await evaluateWithLog(bashInputWithoutSession('git checkout feat/codex-session'));

      expect(run.result.decision).toBe('allow');
      expect(lastLayer(run)).toBe('inline-jury');
      expect(autoDenyEntry(run)).toBeUndefined();
    } finally {
      if (previousCodex === undefined) delete process.env.CODEX_SESSION_ID;
      else process.env.CODEX_SESSION_ID = previousCodex;
      if (previousClaude === undefined) delete process.env.CLAUDE_SESSION_ID;
      else process.env.CLAUDE_SESSION_ID = previousClaude;
      if (previousHive === undefined) delete process.env.HIVE_FLOW_SESSION_ID;
      else process.env.HIVE_FLOW_SESSION_ID = previousHive;
    }
  });

  it.each(golden.pathRestores)('keeps path-restoring checkout auto-denied: %s', async (command) => {
    const run = await evaluateWithLog(bashInput(command));

    expect(run.result.decision).toBe('deny');
    expect(lastLayer(run)).toBe('auto-deny');
    expect(run.result.reason).toMatch(/discard|restore|stash|jury|evaluate/i);
  });

  it.each(golden.dangerousOrAmbiguous)('keeps dangerous or ambiguous checkout auto-denied: %s', async (command) => {
    const run = await evaluateWithLog(bashInput(command));

    expect(run.result.decision).toBe('deny');
    expect(lastLayer(run)).toBe('auto-deny');
  });

  it('does not bypass the checkout guard for subagent branch switches', async () => {
    const run = await evaluateAsSubagent(bashInput('git checkout feat/self-compaction'));

    expect(run.result.decision).toBe('deny');
    expect(lastLayer(run)).toBe('auto-deny');
  });

  it('keeps invalid double-dot refnames auto-denied', async () => {
    const run = await evaluateWithLog(bashInput('git checkout a..a'));

    expect(run.result.decision).toBe('deny');
    expect(lastLayer(run)).toBe('auto-deny');
  });

  it('generator emits only git branch refname candidates', () => {
    const generated = fc.sample(branchName, { seed: 1, numRuns: 200 });

    expect(generated.filter(name => !isGitBranchRefnameCandidate(name))).toEqual([]);
  });

  it('property: branch-only checkout by trusted root is never a policy auto-deny', async () => {
    await fc.assert(
      fc.asyncProperty(branchName, async (branch) => {
        const run = await evaluateWithLog(bashInput(`git checkout ${branch}`));

        expect(run.result.decision, branch).toBe('allow');
        expect(lastLayer(run), branch).toBe('inline-jury');
        expect(autoDenyEntry(run), branch).toBeUndefined();
      }),
      { numRuns: 100 },
    );
  });

  it('property: subagent branch-only checkout is always a policy auto-deny', async () => {
    await fc.assert(
      fc.asyncProperty(branchName, async (branch) => {
        const run = await evaluateAsSubagent(bashInput(`git checkout ${branch}`));

        expect(run.result.decision, branch).toBe('deny');
        expect(lastLayer(run), branch).toBe('auto-deny');
      }),
      { numRuns: 100 },
    );
  });

  it('property: wrapper and branch-creation checkout forms remain policy auto-denied', async () => {
    await fc.assert(
      fc.asyncProperty(branchName, checkoutWrapper, async (branch, wrapper) => {
        const run = await evaluateWithLog(bashInput(`${wrapper} ${branch}`));

        expect(run.result.decision, `${wrapper} ${branch}`).toBe('deny');
        expect(lastLayer(run), `${wrapper} ${branch}`).toBe('auto-deny');
      }),
      { numRuns: 100 },
    );
  });
});
