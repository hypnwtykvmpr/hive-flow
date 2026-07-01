import { describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { evaluate } from '../gate.js';
import { mergeWithDefaults } from '../default-config.js';
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

function toolInput(toolName: string, toolInput: Record<string, unknown>): HookInput {
  return {
    tool_name: toolName,
    tool_input: toolInput,
    cwd: '/project',
  };
}

async function evaluateWithLog(input: HookInput, config: Partial<PermissionConfig> = {}): Promise<GateRun> {
  const root = mkdtempSync(join(tmpdir(), 'secret-read-gate-'));
  const logFile = join(root, 'permission-log.jsonl');
  try {
    const result = await evaluate(input, mergeWithDefaults({
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

function expectLastLayer(run: GateRun, layer: string): void {
  expect(run.entries.at(-1)?.layer).toBe(layer);
}

describe('secret-read gate wiring', () => {
  describe('Bash secret file-read path args', () => {
    it.each([
      ['cat ~/.ssh/id_rsa'],
      ['grep AWS_SECRET ~/.aws/credentials'],
      ['grep -c AWS_SECRET ~/.aws/credentials'],
      ['grep -e AWS_SECRET ~/.aws/credentials'],
      ['rg --type ts AWS_SECRET ~/.aws/credentials'],
      ['xxd id_ed25519'],
      ['sha256sum id_rsa'],
      ['cat "$HOME/.aws/credentials"'],
      ['head -n5 deploy.pem'],
      ['head -n 5 deploy.pem'],
    ])('denies secret reads before Bash allow patterns: %s', async (command) => {
      const run = await evaluateWithLog(bashInput(command));

      expect(run.result.decision).toBe('deny');
      expect(run.result.reason).toContain('secret/credential path');
      expectLastLayer(run, 'secret-read-bash');
    });

    it.each([
      ['env'],
      ['printenv AWS_SECRET_ACCESS_KEY'],
      ['echo "$AWS_SECRET_ACCESS_KEY"'],
      ['printf "%s\\n" "$OPENROUTER_API_KEY"'],
    ])('denies clear environment secret dumps: %s', async (command) => {
      const run = await evaluateWithLog(bashInput(command));

      expect(run.result.decision).toBe('deny');
      expect(run.result.reason).toContain('secret/credential');
      expectLastLayer(run, 'secret-read-bash');
    });

    it.each([
      ['cat README.md'],
      ['grep TODO src/index.ts'],
      ['head -n5 package.json'],
      ['env NODE_ENV=test node x.js'],
    ])('does not over-block benign Bash reads or env prefixes: %s', async (command) => {
      const run = await evaluateWithLog(bashInput(command));

      expect(run.entries.at(-1)?.layer).not.toBe('secret-read-bash');
      expect(run.result.decision).toBe('allow');
    });
  });

  describe('Read-family secret paths', () => {
    it('denies native Read of a secret path before always_allow_tools', async () => {
      const run = await evaluateWithLog(toolInput('Read', { file_path: '~/.ssh/id_rsa' }));

      expect(run.result.decision).toBe('deny');
      expect(run.result.reason).toContain('secret/credential class');
      expectLastLayer(run, 'secret-read');
    });

    it('keeps existing protected-read deny for .env', async () => {
      const run = await evaluateWithLog(toolInput('Read', { file_path: '.env' }));

      expect(run.result.decision).toBe('deny');
      expectLastLayer(run, 'sensitive-read');
    });

    it('denies MCP filesystem read_file of a secret extension', async () => {
      const run = await evaluateWithLog(toolInput('mcp__filesystem__read_file', { path: 'deploy.pem' }));

      expect(run.result.decision).toBe('deny');
      expect(run.result.reason).toContain('secret/credential class');
      expectLastLayer(run, 'secret-read');
    });

    it.each([
      ['src/index.ts'],
      ['id_rsa.pub'],
    ])('allows non-secret native Read paths: %s', async (filePath) => {
      const run = await evaluateWithLog(toolInput('Read', { file_path: filePath }));

      expect(run.entries.at(-1)?.layer).not.toBe('secret-read');
      expect(run.result.decision).toBe('allow');
    });
  });
});
