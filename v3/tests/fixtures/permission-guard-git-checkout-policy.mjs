#!/usr/bin/env node
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const repoRoot = process.argv[2] || process.cwd();
const fixturePath = join(
  repoRoot,
  'v3',
  '@hive-flow',
  'cli',
  'src',
  'permission-guard',
  '__tests__',
  'fixtures',
  'git-checkout-branch-policy.golden.json',
);

const gateModule = await import(pathToFileURL(join(
  repoRoot,
  'v3',
  '@hive-flow',
  'cli',
  'dist',
  'src',
  'permission-guard',
  'gate.js',
)).href);
const configModule = await import(pathToFileURL(join(
  repoRoot,
  'v3',
  '@hive-flow',
  'cli',
  'dist',
  'src',
  'permission-guard',
  'default-config.js',
)).href);

const { evaluate } = gateModule;
const { mergeWithDefaults } = configModule;
const golden = JSON.parse(readFileSync(fixturePath, 'utf8'));

function hookInput(command, sessionId = 'trusted-root-checkout-simulation') {
  return {
    tool_name: 'Bash',
    tool_input: { command },
    cwd: repoRoot,
    session_id: sessionId,
  };
}

function readAuditEntries(logFile) {
  try {
    const text = readFileSync(logFile, 'utf8').trim();
    if (!text) return [];
    return text.split('\n').filter(Boolean).map(line => JSON.parse(line));
  } catch {
    return [];
  }
}

async function runGate(command, options = {}) {
  const tmp = mkdtempSync(join(tmpdir(), 'permission-guard-checkout-sim-'));
  const logFile = join(tmp, 'permission-log.jsonl');
  const previousAgentId = process.env.HIVE_FLOW_AGENT_ID;
  const previousSessionId = process.env.CLAUDE_SESSION_ID;
  try {
    if (options.subagent) {
      process.env.HIVE_FLOW_AGENT_ID = 'checkout-sim-worker';
    } else {
      delete process.env.HIVE_FLOW_AGENT_ID;
    }
    process.env.CLAUDE_SESSION_ID = options.sessionId || 'trusted-root-checkout-simulation';

    const result = await evaluate(hookInput(command, process.env.CLAUDE_SESSION_ID), mergeWithDefaults({
      disable_vote_learner: true,
      llm_jury_budget_dir: join(tmp, 'budget'),
      log_file: logFile,
    }));
    const entries = readAuditEntries(logFile);
    return {
      command,
      decision: result.decision,
      reason: result.reason || '',
      lastLayer: entries.at(-1)?.layer || null,
      autoDeny: entries.some(entry => entry.layer === 'auto-deny'),
    };
  } finally {
    if (previousAgentId === undefined) {
      delete process.env.HIVE_FLOW_AGENT_ID;
    } else {
      process.env.HIVE_FLOW_AGENT_ID = previousAgentId;
    }
    if (previousSessionId === undefined) {
      delete process.env.CLAUDE_SESSION_ID;
    } else {
      process.env.CLAUDE_SESSION_ID = previousSessionId;
    }
    rmSync(tmp, { recursive: true, force: true });
  }
}

function blankCounts(total) {
  return {
    total,
    allow: 0,
    deny: 0,
    inlineJury: 0,
    autoDeny: 0,
  };
}

const summary = {
  ok: true,
  counts: {
    trustedRootBranchSwitches: blankCounts(golden.trustedRootBranchSwitches.length),
    pathRestores: blankCounts(golden.pathRestores.length),
    dangerousOrAmbiguous: blankCounts(golden.dangerousOrAmbiguous.length),
    subagentBranchSwitch: blankCounts(1),
  },
  failures: [],
};

function record(category, gateRun, expectation) {
  const counts = summary.counts[category];
  if (gateRun.decision === 'allow') counts.allow += 1;
  if (gateRun.decision === 'deny') counts.deny += 1;
  if (gateRun.lastLayer === 'inline-jury') counts.inlineJury += 1;
  if (gateRun.autoDeny) counts.autoDeny += 1;

  const errors = [];
  if (gateRun.decision !== expectation.decision) {
    errors.push(`decision=${gateRun.decision}, expected ${expectation.decision}`);
  }
  if (expectation.lastLayer && gateRun.lastLayer !== expectation.lastLayer) {
    errors.push(`lastLayer=${gateRun.lastLayer}, expected ${expectation.lastLayer}`);
  }
  if (typeof expectation.autoDeny === 'boolean' && gateRun.autoDeny !== expectation.autoDeny) {
    errors.push(`autoDeny=${gateRun.autoDeny}, expected ${expectation.autoDeny}`);
  }
  if (errors.length > 0) {
    summary.ok = false;
    summary.failures.push({ category, command: gateRun.command, errors });
  }
}

for (const command of golden.trustedRootBranchSwitches) {
  record('trustedRootBranchSwitches', await runGate(command), {
    decision: 'allow',
    lastLayer: 'inline-jury',
    autoDeny: false,
  });
}

for (const command of golden.pathRestores) {
  record('pathRestores', await runGate(command), {
    decision: 'deny',
    lastLayer: 'auto-deny',
    autoDeny: true,
  });
}

for (const command of golden.dangerousOrAmbiguous) {
  record('dangerousOrAmbiguous', await runGate(command), {
    decision: 'deny',
    lastLayer: 'auto-deny',
    autoDeny: true,
  });
}

record('subagentBranchSwitch', await runGate('git checkout feat/self-compaction', { subagent: true }), {
  decision: 'deny',
  lastLayer: 'auto-deny',
  autoDeny: true,
});

console.log(JSON.stringify(summary, null, 2));
if (!summary.ok) process.exitCode = 1;
