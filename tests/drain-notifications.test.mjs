import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, '..');
const require = createRequire(import.meta.url);
const drain = require(join(REPO_ROOT, '.claude', 'helpers', 'drain-notifications.cjs'));

const tempDirs = [];

function tempDir(prefix) {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

function sessionKey(rawSession, clientKind = 'claude-code') {
  return `s_${createHash('sha256').update(`${clientKind}\0${rawSession}`).digest('hex').slice(0, 32)}`;
}

function pendingFile(home, rawSession) {
  return join(home, 'wake', 'sessions', sessionKey(rawSession), 'pending-notifications.jsonl');
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe('drain-notifications global wake queues', () => {
  it('drains only the requested global wake session and leaves sibling sessions queued', () => {
    const projectRoot = tempDir('hf-drain-project-');
    const home = tempDir('hf-drain-home-');
    const origHome = process.env.HIVE_FLOW_HOME;
    const origKind = process.env.HIVE_FLOW_CLIENT_KIND;
    process.env.HIVE_FLOW_HOME = home;
    process.env.HIVE_FLOW_CLIENT_KIND = 'claude-code';

    try {
      const sessionAFile = pendingFile(home, 'claude-session-a');
      const sessionBFile = pendingFile(home, 'claude-session-b');
      mkdirSync(dirname(sessionAFile), { recursive: true });
      mkdirSync(dirname(sessionBFile), { recursive: true });
      writeFileSync(
        sessionAFile,
        JSON.stringify({
          kind: 'hive',
          hiveId: 'hive-a',
          summary: '[HIVE COMPLETE: hive-a] session A done',
        }) + '\n',
        'utf8',
      );
      writeFileSync(
        sessionBFile,
        JSON.stringify({
          kind: 'hive',
          hiveId: 'hive-b',
          summary: '[HIVE COMPLETE: hive-b] session B done',
        }) + '\n',
        'utf8',
      );

      const output = drain.drainNotifications(projectRoot, {
        session_id: 'claude-session-a',
        client_kind: 'claude-code',
      });

      const context = output.hookSpecificOutput?.additionalContext ?? '';
      assert.match(context, /session A done/);
      assert.doesNotMatch(context, /session B done/);
      assert.equal(existsSync(sessionAFile), false);
      assert.equal(existsSync(sessionBFile), true);
      assert.match(readFileSync(sessionBFile, 'utf8'), /session B done/);
    } finally {
      if (origHome !== undefined) process.env.HIVE_FLOW_HOME = origHome;
      else delete process.env.HIVE_FLOW_HOME;
      if (origKind !== undefined) process.env.HIVE_FLOW_CLIENT_KIND = origKind;
      else delete process.env.HIVE_FLOW_CLIENT_KIND;
    }
  });
});
