import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';

const repoRoot = path.resolve(import.meta.dirname, '..');

function loadSettings() {
  return JSON.parse(readFileSync(path.join(repoRoot, '.claude/settings.json'), 'utf8'));
}

test('SubagentStop hook has an explicit teardown timeout', () => {
  const settings = loadSettings();
  const hooks = settings.hooks?.SubagentStop?.[0]?.hooks ?? [];
  assert.equal(hooks.length, 1);
  assert.equal(hooks[0].command, 'bash .claude/hooks/subagent-wrapup.sh');
  assert.equal(typeof hooks[0].timeout, 'number');
  assert.ok(hooks[0].timeout > 0);
  assert.ok(hooks[0].timeout <= 5000);
});

test('subagent-wrapup prompts when BEAD_ID is present', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'hf-subagent-wrapup-'));
  try {
    const transcript = path.join(dir, 'transcript.jsonl');
    writeFileSync(transcript, 'message\nBEAD_ID: bd-123\n');
    const input = JSON.stringify({
      agent_id: 'agent-1',
      agent_type: 'tester',
      agent_transcript_path: transcript,
    });
    const result = spawnSync('bash', ['.claude/hooks/subagent-wrapup.sh'], {
      cwd: repoRoot,
      input,
      encoding: 'utf8',
      timeout: 2000,
    });
    assert.equal(result.status, 0, result.stderr);
    const payload = JSON.parse(result.stdout);
    assert.equal(payload.decision, 'block');
    assert.match(payload.reason, /bd comments add bd-123 "LEARNED:/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('subagent-wrapup fails open quickly for large transcripts without a BEAD_ID', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'hf-subagent-wrapup-large-'));
  try {
    const transcript = path.join(dir, 'large-transcript.jsonl');
    writeFileSync(transcript, 'x'.repeat(2_000_000));
    const input = JSON.stringify({
      agent_id: 'agent-1',
      agent_type: 'tester',
      agent_transcript_path: transcript,
    });
    const result = spawnSync('bash', ['.claude/hooks/subagent-wrapup.sh'], {
      cwd: repoRoot,
      input,
      encoding: 'utf8',
      timeout: 2000,
    });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout, '');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
