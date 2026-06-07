import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { mergeWithDefaults } from '../default-config.js';
import { evaluate } from '../gate.js';
import type { AuditLogEntry, GateResult, HookInput, PermissionConfig } from '../types.js';

interface GateRun {
  result: GateResult;
  entries: AuditLogEntry[];
}

function bashInput(command: string): HookInput {
  return {
    tool_name: 'Bash',
    tool_input: { command },
    cwd: '/project',
  };
}

async function evaluateWithLog(command: string, config: Partial<PermissionConfig> = {}): Promise<GateRun> {
  const root = mkdtempSync(join(tmpdir(), 'known-good-boundary-'));
  const logFile = join(root, 'permission-log.jsonl');
  try {
    const result = await evaluate(bashInput(command), mergeWithDefaults({
      ...config,
      log_file: logFile,
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

function lastLayer(run: GateRun): string | undefined {
  return run.entries.at(-1)?.layer;
}

describe('known-good Bash boundary', () => {
  it.each([
    'git push origin main',
    'git commit -m x',
    'git switch main',
    'git stash',
    'git pull origin main',
    'git fetch --all',
    'git cherry-pick abc123',
    'npm install',
    'npm ci',
    'npm init -y',
    'pip install foo',
    'pip3 install foo',
    'mkdir build',
    'touch generated.txt',
    'cp a b',
    'mv a b',
    'curl https://x',
    'wget https://x',
  ])('demotes state-changing or egress command to inline jury: %s', async (command) => {
    const run = await evaluateWithLog(command);

    expect(run.result.decision).toBe('allow');
    expect(lastLayer(run)).toBe('inline-jury');
  });

  it.each([
    'git status',
    'git log --oneline',
    'ls -la',
    'cat file',
    'grep x f',
    'npm run test',
    'npm test',
    'rg foo',
  ])('keeps read-only or conventional test command deterministic: %s', async (command) => {
    const run = await evaluateWithLog(command);

    expect(run.result.decision).toBe('allow');
    expect(lastLayer(run)).toBe('deterministic');
  });

  it.each([
    'find . -delete',
    "sed -i 's/a/b/' f",
    'cat file > generated.txt',
    'git status > status.txt',
    'npm test > test.log',
    'grep x f | tee matches.txt',
  ])('does not treat write-capable boundary command as deterministic known-good: %s', async (command) => {
    const run = await evaluateWithLog(command);

    expect(run.result.decision).toBe('allow');
    expect(lastLayer(run)).toBe('inline-jury');
  });

  it('keeps read-only find deterministic', async () => {
    const run = await evaluateWithLog("find . -name '*.ts'");

    expect(run.result.decision).toBe('allow');
    expect(lastLayer(run)).toBe('deterministic');
  });
});
