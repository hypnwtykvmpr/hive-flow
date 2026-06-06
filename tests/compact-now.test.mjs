import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { tmpdir } from 'os';
import { spawnSync } from 'child_process';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(__dirname, '..');
const helperPath = join(repoRoot, '.claude', 'helpers', 'compact-now.cjs');

describe('compact-now helper', () => {
  it('writes a durable recovery note before arming a valid compact request', () => {
    const projectRoot = mkdtempSync(join(tmpdir(), 'hf-compact-now-'));
    const dataDir = join(projectRoot, '.hive-flow', 'data');
    const handoffPath = join(dataDir, 'compaction-handoff.md');
    const requestPath = join(dataDir, 'compact-request.json');
    mkdirSync(dataDir, { recursive: true });

    try {
      const result = spawnSync(process.execPath, [
        helperPath,
        '--reason', 'human requested compaction',
        '--mode', 'inplace',
        '--resume', 'session-123',
        '--next-step', 'finish the focused tests, then commit',
      ], {
        cwd: projectRoot,
        env: {
          ...process.env,
          CLAUDE_PROJECT_DIR: projectRoot,
          CLAUDE_SESSION_ID: 'session-123',
        },
        encoding: 'utf8',
      });

      assert.equal(result.status, 0, result.stderr || result.stdout);
      assert.equal(existsSync(handoffPath), true);
      assert.equal(existsSync(requestPath), true);

      const handoff = readFileSync(handoffPath, 'utf8');
      const request = JSON.parse(readFileSync(requestPath, 'utf8'));

      assert.match(handoff, /human requested compaction/);
      assert.match(handoff, /finish the focused tests, then commit/);
      assert.match(handoff, /Preserve/);
      assert.equal(request.reason, 'human requested compaction');
      assert.equal(request.mode, 'inplace');
      assert.equal(request.resume, 'session-123');
      assert.equal(request.handoffPath, handoffPath);
      assert.match(request.preservationPrompt, /finish the focused tests, then commit/);
      assert.ok(new Date(request.handoffWrittenAt).getTime() <= new Date(request.requestedAt).getTime());
    } finally {
      rmSync(projectRoot, { recursive: true, force: true });
    }
  });
});
