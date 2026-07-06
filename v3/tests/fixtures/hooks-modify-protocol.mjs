#!/usr/bin/env node
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const here = dirname(fileURLToPath(import.meta.url));
const v3Root = resolve(here, '..', '..');
const repoRoot = resolve(v3Root, '..');
const cliBin = process.env.HIVE_FLOW_HOOK_PROTOCOL_CLI
  || join(repoRoot, 'cli', 'bin', 'cli.js');
const goldenPath = join(here, 'hooks-modify-protocol.golden.json');
const golden = JSON.parse(readFileSync(goldenPath, 'utf8'));

function fail(message, details = {}) {
  const error = new Error(message);
  error.details = details;
  throw error;
}

function parseSingleJsonLine(stdout, caseName) {
  if (!stdout.endsWith('\n')) fail(`${caseName}: stdout must end with newline`, { stdout });
  const lines = stdout.trimEnd().split('\n');
  if (lines.length !== 1) fail(`${caseName}: stdout must contain exactly one line`, { stdout });
  try {
    return JSON.parse(lines[0]);
  } catch (error) {
    fail(`${caseName}: stdout line is not parseable JSON`, { stdout, error: error.message });
  }
}

function inputFor(testCase) {
  if (typeof testCase.stdinRaw === 'string') return testCase.stdinRaw;
  if (testCase.stdin !== undefined) return `${JSON.stringify(testCase.stdin)}\n`;
  return '';
}

function runCase(testCase) {
  const projectRoot = mkdtempSync(join(tmpdir(), 'hf-hook-protocol-'));
  const enforcementDir = join(projectRoot, '.hive-flow', 'enforcement');
  const statePath = join(enforcementDir, 'state.json');
  const sentinelState = '{"sentinel":"unchanged"}\n';
  try {
    mkdirSync(enforcementDir, { recursive: true });
    writeFileSync(statePath, sentinelState, 'utf8');

    const globalArgs = testCase.globalArgs || ['--no-update'];
    const args = [...globalArgs, 'hooks', testCase.hook, ...(testCase.args || [])];
    const child = spawnSync(process.execPath, [cliBin, ...args], {
      cwd: projectRoot,
      input: inputFor(testCase),
      encoding: 'utf8',
      env: {
        ...process.env,
        HIVE_FLOW_PROJECT_ROOT: projectRoot,
        CLAUDE_PROJECT_DIR: projectRoot,
        NO_COLOR: '1',
        CI: '1',
        ...(testCase.env || {}),
      },
    });

    if (child.status !== testCase.expectedStatus) {
      fail(`${testCase.name}: unexpected exit status`, {
        expected: testCase.expectedStatus,
        actual: child.status,
        stdout: child.stdout,
        stderr: child.stderr,
      });
    }

    const payload = parseSingleJsonLine(child.stdout, testCase.name);
    const hookOutput = payload.hookSpecificOutput || {};

    if (payload.decision !== testCase.expectedDecision) {
      fail(`${testCase.name}: unexpected legacy decision`, { payload });
    }
    if (hookOutput.hookEventName !== 'PreToolUse') {
      fail(`${testCase.name}: missing PreToolUse hookSpecificOutput`, { payload });
    }
    if (hookOutput.permissionDecision !== testCase.expectedDecision) {
      fail(`${testCase.name}: unexpected hookSpecificOutput decision`, { payload });
    }
    if (!String(payload.reason || '').includes(testCase.expectedReasonIncludes)) {
      fail(`${testCase.name}: reason did not include expected text`, { payload });
    }
    if (testCase.expectedToolInputFile && payload.tool_input?.file_path !== testCase.expectedToolInputFile) {
      fail(`${testCase.name}: tool_input.file_path was not preserved`, { payload });
    }
    if (testCase.expectedStderrIncludes) {
      if (!child.stderr.includes(testCase.expectedStderrIncludes)) {
        fail(`${testCase.name}: stderr did not include expected diagnostic`, { stderr: child.stderr });
      }
    } else if (child.stderr !== '') {
      fail(`${testCase.name}: stderr must be empty for non-error case`, { stderr: child.stderr });
    }
    const currentState = readFileSync(statePath, 'utf8');
    if (currentState !== sentinelState) {
      fail(`${testCase.name}: modify hook must not mutate enforcement state`, { currentState });
    }

    return {
      name: testCase.name,
      status: child.status,
      decision: payload.decision,
    };
  } finally {
    rmSync(projectRoot, { recursive: true, force: true });
  }
}

const records = [];
try {
  for (const testCase of golden.cases) {
    records.push(runCase(testCase));
  }
  process.stdout.write(JSON.stringify({ ok: true, cases: records }, null, 2));
  process.stdout.write('\n');
} catch (error) {
  process.stderr.write(JSON.stringify({
    ok: false,
    error: error.message,
    details: error.details || {},
  }, null, 2));
  process.stderr.write('\n');
  process.exit(1);
}
