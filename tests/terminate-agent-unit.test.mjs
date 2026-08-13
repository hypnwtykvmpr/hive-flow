import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const require = createRequire(import.meta.url);
const SCRIPT = join(process.cwd(), '.claude', 'helpers', 'terminate-agent.cjs');

function withTempDir() {
  return mkdtempSync(join(tmpdir(), 'terminate-agent-unit-'));
}

function loadModule(projectDir) {
  const old = process.env.CLAUDE_PROJECT_DIR;
  process.env.CLAUDE_PROJECT_DIR = projectDir;
  delete require.cache[require.resolve(SCRIPT)];
  const mod = require(SCRIPT);
  process.env.CLAUDE_PROJECT_DIR = old;
  return mod;
}

function captureStdout(fn) {
  const oldWrite = process.stdout.write;
  let out = '';
  process.stdout.write = (chunk) => {
    out += String(chunk);
    return true;
  };
  try {
    const result = fn();
    return { out, result };
  } finally {
    process.stdout.write = oldWrite;
  }
}

describe('terminate-agent internals', () => {
  it('switches only between current Anthropic models', () => {
    const cwd = withTempDir();
    try {
      const mod = loadModule(cwd);
      assert.deepEqual(mod.MODEL_IDS, {
        opus: 'claude-opus-5',
        sonnet: 'claude-sonnet-5',
        haiku: 'claude-sonnet-5',
      });
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it('parseHookInput handles JSON and raw payloads', () => {
    const cwd = withTempDir();
    try {
      const mod = loadModule(cwd);
      const parsed = mod.parseHookInput('{"prompt":"/terminate-agent","session_id":"s1","transcript_path":"/tmp/a.jsonl"}');
      assert.equal(parsed.prompt, '/terminate-agent');
      assert.equal(parsed.sessionId, 's1');
      assert.equal(parsed.transcriptPath, '/tmp/a.jsonl');

      const raw = mod.parseHookInput('/terminate-agent');
      assert.equal(raw.prompt, '/terminate-agent');
      assert.equal(raw.parsed, null);
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it('resolveTranscriptPath validates scope, extension, existence, and session id', () => {
    const cwd = withTempDir();
    try {
      const mod = loadModule(cwd);
      const jsonlDir = join(cwd, 'jsonl-dir');
      mkdirSync(jsonlDir, { recursive: true });
      const goodPath = join(jsonlDir, 'session-a.jsonl');
      writeFileSync(goodPath, '');
      const oldJsonlDir = process.env.HIVE_FLOW_JSONL_DIR;
      process.env.HIVE_FLOW_JSONL_DIR = jsonlDir;

      const ok = mod.resolveTranscriptPath({ transcriptPath: goodPath, sessionId: 'session-a' });
      assert.equal(ok.ok, true);

      const badExt = mod.resolveTranscriptPath({ transcriptPath: join(jsonlDir, 'session-a.txt'), sessionId: 'session-a' });
      assert.equal(badExt.ok, false);

      const mismatch = mod.resolveTranscriptPath({ transcriptPath: goodPath, sessionId: 'other-session' });
      assert.equal(mismatch.ok, false);

      const outside = mod.resolveTranscriptPath({ transcriptPath: join(tmpdir(), 'outside.jsonl'), sessionId: 'outside' });
      assert.equal(outside.ok, false);

      const badType = mod.resolveTranscriptPath({ transcriptPath: { nope: true } });
      assert.equal(badType.ok, false);
      process.env.HIVE_FLOW_JSONL_DIR = oldJsonlDir;
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it('detectCurrentModel prefers longest matching project path and handles invalid markers', () => {
    const cwd = withTempDir();
    const fakeHome = withTempDir();
    try {
      const cfgPath = join(fakeHome, '.claude.json');
      writeFileSync(cfgPath, JSON.stringify({
        projects: {
          '/Users/jonathan': {
            lastModelUsage: {
              'claude-opus-4-6': { lastUsedAt: '2026-03-01T00:00:00.000Z' },
            },
          },
          [cwd]: {
            lastModelUsage: {
              'claude-sonnet-4-6': { lastUsedAt: '2026-03-09T00:00:00.000Z' },
            },
          },
        },
      }, null, 2));

      const oldHome = process.env.HOME;
      process.env.HOME = fakeHome;
      const mod = loadModule(cwd);
      assert.equal(mod.detectCurrentModel(), 'sonnet');
      process.env.HOME = oldHome;

      const throwingDate = {
        [Symbol.toPrimitive]() {
          throw new Error('bad date');
        },
      };
      assert.equal(mod.isMarkerExpired({ at: throwingDate }), false);
    } finally {
      rmSync(cwd, { recursive: true, force: true });
      rmSync(fakeHome, { recursive: true, force: true });
    }
  });

  it('clearSessionState scrubs only current session volatile fields', () => {
    const cwd = withTempDir();
    const fakeHome = withTempDir();
    try {
      const plansDir = join(fakeHome, '.claude', 'plans');
      mkdirSync(plansDir, { recursive: true });
      const planPath = join(plansDir, 'safe.md');
      writeFileSync(planPath, '# keep');

      const sessionsDir = join(cwd, '.hive-flow', 'sessions');
      mkdirSync(sessionsDir, { recursive: true });
      const sessionPath = join(sessionsDir, 'current.json');
      writeFileSync(sessionPath, JSON.stringify({
        id: 'session-z',
        context: { a: 1 },
        scratchpad: 'x',
        transient: { temp: true },
        metrics: { edits: 1 },
      }, null, 2));

      const oldHome = process.env.HOME;
      process.env.HOME = fakeHome;
      const mod = loadModule(cwd);
      const result = mod.clearSessionState({ sessionId: 'session-z' });
      process.env.HOME = oldHome;

      assert.equal(result.cleared, true);
      const session = JSON.parse(readFileSync(sessionPath, 'utf8'));
      assert.equal(session.context, undefined);
      assert.equal(session.scratchpad, undefined);
      assert.deepEqual(session.transient, {});
      assert.equal(existsSync(planPath), true);
    } finally {
      rmSync(cwd, { recursive: true, force: true });
      rmSync(fakeHome, { recursive: true, force: true });
    }
  });

  it('dumpSessionState returns false when transcript has no user prompts', () => {
    const cwd = withTempDir();
    try {
      const mod = loadModule(cwd);
      const jsonlDir = join(cwd, 'jsonl-dir');
      mkdirSync(jsonlDir, { recursive: true });
      const transcript = join(jsonlDir, 'session-no-user.jsonl');
      writeFileSync(transcript, JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'hi' }] } }));
      const oldJsonlDir = process.env.HIVE_FLOW_JSONL_DIR;
      process.env.HIVE_FLOW_JSONL_DIR = jsonlDir;

      const dump = mod.dumpSessionState({ generation: 1 }, { transcriptPath: transcript, sessionId: 'session-no-user' });
      assert.equal(dump.dumped, false);
      assert.match(dump.reason || '', /No user prompts/i);
      process.env.HIVE_FLOW_JSONL_DIR = oldJsonlDir;
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it('dumpSessionState reports write failure when sessions path is invalid', () => {
    const cwd = withTempDir();
    try {
      const mod = loadModule(cwd);
      const jsonlDir = join(cwd, 'jsonl-dir');
      mkdirSync(jsonlDir, { recursive: true });
      const transcript = join(jsonlDir, 'session-write-fail.jsonl');
      writeFileSync(transcript, JSON.stringify({
        type: 'user',
        message: { content: [{ type: 'text', text: 'prompt' }] },
      }));
      const oldJsonlDir = process.env.HIVE_FLOW_JSONL_DIR;
      process.env.HIVE_FLOW_JSONL_DIR = jsonlDir;

      // Force write failure for session dump by making sessions path a file.
      mkdirSync(join(cwd, '.hive-flow'), { recursive: true });
      writeFileSync(join(cwd, '.hive-flow', 'sessions'), 'not-a-dir');

      const dump = mod.dumpSessionState({ generation: 2 }, { transcriptPath: transcript, sessionId: 'session-write-fail' });
      assert.equal(dump.dumped, false);
      assert.match(dump.reason || '', /Failed to write dump file|dumpSessionState error/i);
      process.env.HIVE_FLOW_JSONL_DIR = oldJsonlDir;
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it('dumpSessionState supports string content and handles thrown generation access', () => {
    const cwd = withTempDir();
    try {
      const mod = loadModule(cwd);
      const jsonlDir = join(cwd, 'jsonl-dir');
      mkdirSync(jsonlDir, { recursive: true });
      const transcript = join(jsonlDir, 'session-string-content.jsonl');
      writeFileSync(transcript, JSON.stringify({
        type: 'user',
        timestamp: '2026-03-09T00:00:00.000Z',
        message: { content: 'plain text content' },
      }));
      const oldJsonlDir = process.env.HIVE_FLOW_JSONL_DIR;
      process.env.HIVE_FLOW_JSONL_DIR = jsonlDir;
      mkdirSync(join(cwd, '.hive-flow', 'sessions'), { recursive: true });

      const ok = mod.dumpSessionState({ generation: 12 }, { transcriptPath: transcript, sessionId: 'session-string-content' });
      assert.equal(ok.dumped, true);

      const marker = {};
      Object.defineProperty(marker, 'generation', {
        get() {
          throw new Error('boom-generation');
        },
      });
      const fail = mod.dumpSessionState(marker, { transcriptPath: transcript, sessionId: 'session-string-content' });
      assert.equal(fail.dumped, false);
      assert.match(fail.reason || '', /dumpSessionState error/i);
      process.env.HIVE_FLOW_JSONL_DIR = oldJsonlDir;
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it('maybeEmitHandoff cleans up consumed markers', () => {
    const cwd = withTempDir();
    try {
      const mod = loadModule(cwd);
      const sessionsDir = join(cwd, '.hive-flow', 'sessions');
      mkdirSync(sessionsDir, { recursive: true });
      const markerPath = join(sessionsDir, 'terminated.json');
      writeFileSync(markerPath, JSON.stringify({
        generation: 3,
        at: new Date().toISOString(),
        pendingUserAck: false,
        pendingPromptInjection: false,
      }));

      const { result } = captureStdout(() => mod.maybeEmitHandoff(new Date().toISOString()));
      assert.equal(result, 'none');
      assert.equal(existsSync(markerPath), false);
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it('main returns deterministic non-exiting result in unit mode', () => {
    const cwd = withTempDir();
    try {
      const mod = loadModule(cwd);
      const { out, result } = captureStdout(() => mod.main({
        exitOnFinish: false,
        hookInput: {
          prompt: '/terminate-agent',
          sessionId: null,
          transcriptPath: null,
        },
      }));
      assert.equal(result.action, 'terminated');
      assert.notEqual(out, '');
      const payload = JSON.parse(out);
      assert.equal(payload.decision, 'block');
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it('clearSessionState reports scoped persistence failures and thrown hook metadata', () => {
    const cwd = withTempDir();
    try {
      const mod = loadModule(cwd);
      const sessionsDir = join(cwd, '.hive-flow', 'sessions');
      mkdirSync(sessionsDir, { recursive: true });
      const sessionPath = join(sessionsDir, 'current.json');
      writeFileSync(sessionPath, JSON.stringify({
        id: 'session-write-fail',
        context: { x: 1 },
      }, null, 2));
      const tempWriteBlocker = join(sessionsDir, 'current.json.tmp');
      mkdirSync(tempWriteBlocker, { recursive: true });

      const writeFail = mod.clearSessionState({ sessionId: 'session-write-fail' });
      assert.equal(writeFail.cleared, false);
      assert.match(writeFail.reason || '', /Failed to persist session scrub/i);

      const badHookInput = {};
      Object.defineProperty(badHookInput, 'sessionId', {
        get() {
          throw new Error('bad-session-id');
        },
      });
      const thrown = mod.clearSessionState(badHookInput);
      assert.equal(thrown.cleared, false);
      assert.match(thrown.reason || '', /bad-session-id/i);
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it('main pass-through path and emitJson write failure remain non-fatal', () => {
    const cwd = withTempDir();
    try {
      const mod = loadModule(cwd);
      const pass = mod.main({
        exitOnFinish: false,
        hookInput: {
          prompt: 'hello',
          sessionId: null,
          transcriptPath: null,
        },
      });
      assert.equal(pass.action, 'pass-through');

      const oldWrite = process.stdout.write;
      process.stdout.write = () => {
        throw new Error('stdout-down');
      };
      assert.doesNotThrow(() => {
        mod.emitTerminateBlock({ generation: 5, sessionDumped: false, modelSwitched: false, sessionCleared: false });
      });
      process.stdout.write = oldWrite;

      // Cover switchModel catch path via marker setter throw.
      const marker = {};
      Object.defineProperty(marker, 'modelSwitched', {
        set() {
          throw new Error('marker-write-fail');
        },
      });
      mkdirSync(join(cwd, '.claude'), { recursive: true });
      writeFileSync(join(cwd, '.claude', 'settings.json'), '{}');
      const switched = mod.switchModel(marker);
      assert.equal(switched.switched, false);
      assert.match(switched.reason || '', /switchModel error/i);
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it('launchPostTerminationSteps writes structured skip log when disabled', () => {
    const cwd = withTempDir();
    const oldDisabled = process.env.HIVE_FLOW_DISABLE_POST_TERMINATION_STEPS;
    try {
      const mod = loadModule(cwd);
      process.env.HIVE_FLOW_DISABLE_POST_TERMINATION_STEPS = '1';
      mod.launchPostTerminationSteps();

      const logPath = join(cwd, '.hive-flow', 'sessions', 'terminate-steps.log.jsonl');
      assert.equal(existsSync(logPath), true);
      const lines = readFileSync(logPath, 'utf8').trim().split('\n');
      const entry = JSON.parse(lines[lines.length - 1]);
      assert.equal(entry.event, 'terminate.steps.launch.skipped');
      assert.equal(entry.reason, 'disabled-via-env');
    } finally {
      process.env.HIVE_FLOW_DISABLE_POST_TERMINATION_STEPS = oldDisabled;
      rmSync(cwd, { recursive: true, force: true });
    }
  });
});
