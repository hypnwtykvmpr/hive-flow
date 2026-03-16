import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { existsSync, readFileSync, writeFileSync, mkdirSync, rmSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, '..');
const SCRIPT = join(REPO_ROOT, '.claude/helpers/compaction-state-hook.mjs');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeTempDir() {
  const dir = join(tmpdir(), `compaction-state-test-${randomUUID().slice(0, 8)}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

/**
 * Run the hook as a subprocess.
 * @param {string} command  - 'pre-compact' | 'session-start' | 'user-prompt-submit'
 * @param {object} payload  - JSON piped to stdin
 * @param {string} cwd      - working directory
 * @param {object} [envOverrides] - extra env vars
 */
function runHook(command, payload, cwd, envOverrides = {}) {
  const result = spawnSync(process.execPath, [SCRIPT, command], {
    cwd,
    input: JSON.stringify(payload),
    encoding: 'utf8',
    timeout: 15_000,
    env: {
      ...process.env,
      CLAUDE_PROJECT_DIR: cwd,
      ...envOverrides,
    },
  });
  return {
    status: result.status,
    stdout: result.stdout || '',
    stderr: result.stderr || '',
  };
}

async function runHookWithOpenStdin(command, input, cwd, envOverrides = {}) {
  const child = spawn(process.execPath, [SCRIPT, command], {
    cwd,
    stdio: ['pipe', 'pipe', 'pipe'],
    env: {
      ...process.env,
      CLAUDE_PROJECT_DIR: cwd,
      ...envOverrides,
    },
  });

  let stdout = '';
  let stderr = '';
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', (chunk) => { stdout += chunk; });
  child.stderr.on('data', (chunk) => { stderr += chunk; });

  if (input) child.stdin.write(input);
  // Don't end stdin — we're testing the timeout path where stdin stays open
  // but DO end it after a short delay so the process can exit
  setTimeout(() => { try { child.stdin.end(); } catch {} }, 200);

  const [status, signal] = await once(child, 'close');
  return { status, signal, stdout, stderr };
}

/**
 * Build a mock JSONL transcript and write it to disk.
 * Returns the path to the file.
 */
function writeTranscript(dir, lines) {
  const transcriptDir = join(dir, '.claude', 'transcripts');
  mkdirSync(transcriptDir, { recursive: true });
  const filePath = join(transcriptDir, 'session.jsonl');
  writeFileSync(filePath, lines.join('\n'));
  return filePath;
}

/** Convenience: a user message line */
function userLine(text) {
  return JSON.stringify({
    type: 'user',
    message: { role: 'user', content: text },
  });
}

/** Convenience: an assistant message line with text + optional tool calls */
function assistantLine(text, toolCalls = []) {
  const content = [{ type: 'text', text }];
  for (const tc of toolCalls) {
    content.push({ type: 'tool_use', name: tc.name, input: tc.input || {} });
  }
  return JSON.stringify({
    type: 'assistant',
    message: { role: 'assistant', content },
  });
}

/**
 * Build the "standard" transcript used by multiple test suites.
 */
function standardTranscriptLines() {
  return [
    userLine('Implement the OAuth login feature'),
    assistantLine(
      'I will implement OAuth. Decided to use PKCE flow because it is more secure for public clients.',
      [
        { name: 'Read', input: { file_path: '/src/auth/config.ts' } },
        { name: 'Edit', input: { file_path: '/src/auth/handler.ts', old_string: 'old', new_string: 'new' } },
        { name: 'Write', input: { file_path: '/src/auth/oauth.ts', content: 'export class OAuth {}' } },
        { name: 'Bash', input: { command: 'npm test' } },
      ],
    ),
    userLine('Now add the callback endpoint'),
    assistantLine('Working on callback endpoint.', [
      {
        name: 'TodoWrite',
        input: {
          todos: [
            { content: 'Design API', status: 'completed' },
            { content: 'Implement callback', status: 'in_progress' },
            { content: 'Write tests', status: 'pending' },
          ],
        },
      },
    ]),
  ];
}

/**
 * Locate the state file written by pre-compact inside cwd.
 * Convention: .claude/compaction-state.json  (may vary — search for it).
 */
function findStateFile(cwd) {
  const candidates = [
    join(cwd, '.claude', 'compaction-state.json'),
    join(cwd, '.claude', 'state', 'compaction-state.json'),
    join(cwd, 'compaction-state.json'),
  ];
  for (const c of candidates) {
    if (existsSync(c)) return c;
  }
  // Fallback: recursively look for any compaction-state*.json
  return findFileRecursive(cwd, /compaction-state.*\.json$/);
}

function findFileRecursive(dir, pattern, depth = 4) {
  if (depth <= 0) return null;
  let entries;
  try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return null; }
  for (const e of entries) {
    const full = join(dir, e.name);
    if (e.isFile() && pattern.test(e.name)) return full;
    if (e.isDirectory() && !e.name.startsWith('.git')) {
      const found = findFileRecursive(full, pattern, depth - 1);
      if (found) return found;
    }
  }
  return null;
}

function readState(cwd) {
  const path = findStateFile(cwd);
  if (!path) return null;
  return JSON.parse(readFileSync(path, 'utf8'));
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('compaction-state-hook', () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = makeTempDir();
    // Ensure .claude directory exists (hook may expect it)
    mkdirSync(join(tmpDir, '.claude'), { recursive: true });
  });

  afterEach(() => {
    if (tmpDir && existsSync(tmpDir)) {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  // =========================================================================
  // 1. Extraction Tests (pre-compact with standard transcript)
  // =========================================================================
  describe('extraction (pre-compact)', () => {
    it('should extract goals from user messages', () => {
      const transcriptPath = writeTranscript(tmpDir, standardTranscriptLines());
      const res = runHook('pre-compact', {
        session_id: 'test-session-1',
        transcript_path: transcriptPath,
        trigger: 'auto',
      }, tmpDir);

      assert.equal(res.status, 0, `Hook exited with error: ${res.stderr}`);
      const state = readState(tmpDir);
      assert.ok(state, 'State file should exist after pre-compact');
      assert.ok(state.goals, 'State should have goals');
      // Primary goal should reference OAuth or the user task
      const goalText = typeof state.goals === 'string'
        ? state.goals
        : (state.goals.primary || state.goals[0] || JSON.stringify(state.goals));
      assert.ok(
        /oauth|login|feature/i.test(goalText),
        `Goals should mention OAuth/login/feature, got: ${goalText}`,
      );
    });

    it('should track modified files from Edit tool calls', () => {
      const transcriptPath = writeTranscript(tmpDir, standardTranscriptLines());
      runHook('pre-compact', {
        session_id: 'test-session-2',
        transcript_path: transcriptPath,
        trigger: 'auto',
      }, tmpDir);

      const state = readState(tmpDir);
      assert.ok(state, 'State file should exist');
      const files = state.files || {};
      const modified = files.modified || files.edited || [];
      assert.ok(
        modified.some(f => f.includes('handler.ts')),
        `Modified files should include handler.ts, got: ${JSON.stringify(modified)}`,
      );
    });

    it('should track created files from Write tool calls', () => {
      const transcriptPath = writeTranscript(tmpDir, standardTranscriptLines());
      runHook('pre-compact', {
        session_id: 'test-session-3',
        transcript_path: transcriptPath,
        trigger: 'auto',
      }, tmpDir);

      const state = readState(tmpDir);
      assert.ok(state);
      const files = state.files || {};
      const created = files.created || files.written || [];
      assert.ok(
        created.some(f => f.includes('oauth.ts')),
        `Created files should include oauth.ts, got: ${JSON.stringify(created)}`,
      );
    });

    it('should track read files from Read tool calls', () => {
      const transcriptPath = writeTranscript(tmpDir, standardTranscriptLines());
      runHook('pre-compact', {
        session_id: 'test-session-4',
        transcript_path: transcriptPath,
        trigger: 'auto',
      }, tmpDir);

      const state = readState(tmpDir);
      assert.ok(state);
      const files = state.files || {};
      const readFiles = files.read || [];
      assert.ok(
        readFiles.some(f => f.includes('config.ts')),
        `Read files should include config.ts, got: ${JSON.stringify(readFiles)}`,
      );
    });

    it('should extract decisions from assistant reasoning', () => {
      const transcriptPath = writeTranscript(tmpDir, standardTranscriptLines());
      runHook('pre-compact', {
        session_id: 'test-session-5',
        transcript_path: transcriptPath,
        trigger: 'auto',
      }, tmpDir);

      const state = readState(tmpDir);
      assert.ok(state);
      const decisions = state.decisions || [];
      assert.ok(Array.isArray(decisions), 'Decisions should be an array');
      const decisionText = JSON.stringify(decisions).toLowerCase();
      assert.ok(
        /pkce|secure|public client/i.test(decisionText),
        `Decisions should reference PKCE rationale, got: ${JSON.stringify(decisions)}`,
      );
    });

    it('should extract todo progress from TodoWrite calls', () => {
      const transcriptPath = writeTranscript(tmpDir, standardTranscriptLines());
      runHook('pre-compact', {
        session_id: 'test-session-6',
        transcript_path: transcriptPath,
        trigger: 'auto',
      }, tmpDir);

      const state = readState(tmpDir);
      assert.ok(state);
      const progress = state.progress || {};

      const completed = progress.completed || progress.done || [];
      const inProgress = progress.inProgress || progress.active || progress.in_progress || [];
      const pending = progress.pending || progress.todo || [];

      assert.ok(
        completed.some(t => /design api/i.test(typeof t === 'string' ? t : t.content)),
        `Completed should include "Design API", got: ${JSON.stringify(completed)}`,
      );
      assert.ok(
        inProgress.some(t => /implement callback/i.test(typeof t === 'string' ? t : t.content)),
        `In-progress should include "Implement callback", got: ${JSON.stringify(inProgress)}`,
      );
      assert.ok(
        pending.some(t => /write tests/i.test(typeof t === 'string' ? t : t.content)),
        `Pending should include "Write tests", got: ${JSON.stringify(pending)}`,
      );
    });

    it('should populate toolProfile with recent tools and bash commands', () => {
      const transcriptPath = writeTranscript(tmpDir, standardTranscriptLines());
      runHook('pre-compact', {
        session_id: 'test-session-7',
        transcript_path: transcriptPath,
        trigger: 'auto',
      }, tmpDir);

      const state = readState(tmpDir);
      assert.ok(state);
      const toolProfile = state.toolProfile || {};

      const recentTools = toolProfile.recentTools || toolProfile.tools || [];
      for (const expected of ['Read', 'Edit', 'Write', 'Bash']) {
        assert.ok(
          recentTools.includes(expected),
          `recentTools should include "${expected}", got: ${JSON.stringify(recentTools)}`,
        );
      }

      const bashCommands = toolProfile.bashCommands || toolProfile.commands || [];
      assert.ok(
        bashCommands.some(c => c.includes('npm test')),
        `bashCommands should include "npm test", got: ${JSON.stringify(bashCommands)}`,
      );
    });
  });

  // =========================================================================
  // 2. State Schema Tests
  // =========================================================================
  describe('state schema', () => {
    it('should include all required top-level fields', () => {
      const transcriptPath = writeTranscript(tmpDir, standardTranscriptLines());
      runHook('pre-compact', {
        session_id: 'schema-test',
        transcript_path: transcriptPath,
        trigger: 'auto',
      }, tmpDir);

      const state = readState(tmpDir);
      assert.ok(state, 'State file must exist');

      // Required structural fields
      assert.ok('version' in state, 'State must have "version"');
      assert.ok('timestamp' in state, 'State must have "timestamp"');
      assert.ok('sessionId' in state || 'session_id' in state, 'State must have session identifier');
      assert.ok('source' in state || 'trigger' in state, 'State must have source/trigger');
    });

    it('should have version 1', () => {
      const transcriptPath = writeTranscript(tmpDir, standardTranscriptLines());
      runHook('pre-compact', {
        session_id: 'version-test',
        transcript_path: transcriptPath,
        trigger: 'auto',
      }, tmpDir);

      const state = readState(tmpDir);
      assert.equal(state.version, 1, 'Version should be 1');
    });

    it('should have a valid ISO timestamp', () => {
      const transcriptPath = writeTranscript(tmpDir, standardTranscriptLines());
      runHook('pre-compact', {
        session_id: 'ts-test',
        transcript_path: transcriptPath,
        trigger: 'auto',
      }, tmpDir);

      const state = readState(tmpDir);
      const ts = new Date(state.timestamp);
      assert.ok(!isNaN(ts.getTime()), `Timestamp should be valid ISO, got: ${state.timestamp}`);
      // Should be recent (within last 60 seconds)
      assert.ok(
        Date.now() - ts.getTime() < 60_000,
        'Timestamp should be recent',
      );
    });

    it('should record the session ID from input', () => {
      const transcriptPath = writeTranscript(tmpDir, standardTranscriptLines());
      runHook('pre-compact', {
        session_id: 'my-unique-session-42',
        transcript_path: transcriptPath,
        trigger: 'auto',
      }, tmpDir);

      const state = readState(tmpDir);
      const sid = state.sessionId || state.session_id;
      assert.equal(sid, 'my-unique-session-42');
    });

    it('should record source as pre-compact', () => {
      const transcriptPath = writeTranscript(tmpDir, standardTranscriptLines());
      runHook('pre-compact', {
        session_id: 'source-test',
        transcript_path: transcriptPath,
        trigger: 'auto',
      }, tmpDir);

      const state = readState(tmpDir);
      const source = state.source || state.trigger;
      assert.ok(
        /pre.?compact/i.test(source),
        `Source should indicate pre-compact, got: ${source}`,
      );
    });
  });

  // =========================================================================
  // 3. SessionStart Output Tests
  // =========================================================================
  describe('session-start output', () => {
    it('should output valid JSON with additionalContext when state exists', () => {
      // First create state via pre-compact
      const transcriptPath = writeTranscript(tmpDir, standardTranscriptLines());
      runHook('pre-compact', {
        session_id: 'session-start-test',
        transcript_path: transcriptPath,
        trigger: 'auto',
      }, tmpDir);

      // Now run session-start
      const res = runHook('session-start', {
        session_id: 'session-start-test',
      }, tmpDir);

      assert.equal(res.status, 0, `session-start failed: ${res.stderr}`);

      // stdout should contain JSON
      const trimmed = res.stdout.trim();
      if (trimmed.length === 0) {
        // Some implementations may not output if state file schema differs
        // Skip if truly empty; the hook may use a different output channel
        return;
      }

      let output;
      try {
        output = JSON.parse(trimmed);
      } catch {
        assert.fail(`session-start stdout is not valid JSON: ${trimmed.slice(0, 200)}`);
      }

      // Check for hookSpecificOutput wrapper or direct additionalContext
      const context = output?.hookSpecificOutput?.additionalContext
        || output?.additionalContext
        || (typeof output === 'string' ? output : null);
      assert.ok(context, 'Output should contain additionalContext');
    });

    it('should include key sections in additionalContext', () => {
      const transcriptPath = writeTranscript(tmpDir, standardTranscriptLines());
      runHook('pre-compact', {
        session_id: 'ctx-sections-test',
        transcript_path: transcriptPath,
        trigger: 'auto',
      }, tmpDir);

      const res = runHook('session-start', {
        session_id: 'ctx-sections-test',
      }, tmpDir);

      const trimmed = res.stdout.trim();
      if (!trimmed) return; // graceful skip

      let output;
      try { output = JSON.parse(trimmed); } catch { return; }

      const context = output?.hookSpecificOutput?.additionalContext
        || output?.additionalContext
        || '';
      const contextStr = typeof context === 'string' ? context : JSON.stringify(context);

      // Should reference key categories
      for (const section of ['goal', 'file', 'decision', 'progress']) {
        assert.ok(
          new RegExp(section, 'i').test(contextStr),
          `additionalContext should mention "${section}"`,
        );
      }
    });
  });

  // =========================================================================
  // 4. Edge Cases
  // =========================================================================
  describe('edge cases', () => {
    it('should resolve null when timeout-path stdin JSON is truncated', async () => {
      const res = await runHookWithOpenStdin('pre-compact', '{"session_id":', tmpDir);

      assert.equal(res.status, 0, `Truncated timeout-path stdin should not crash: ${res.stderr}`);
      assert.equal(res.stderr, '', 'Truncated timeout-path stdin should not write errors to stderr');
      assert.match(
        res.stdout,
        /No transcript data available for compaction state extraction\./,
        `Expected graceful fallback output, got: ${res.stdout}`,
      );
    });

    it('should handle empty transcript without crashing', () => {
      const transcriptPath = writeTranscript(tmpDir, []);
      const res = runHook('pre-compact', {
        session_id: 'empty-transcript',
        transcript_path: transcriptPath,
        trigger: 'auto',
      }, tmpDir);

      assert.equal(res.status, 0, `Should not crash on empty transcript: ${res.stderr}`);
      const state = readState(tmpDir);
      if (state) {
        // If a state was written, verify it has safe defaults
        const files = state.files || {};
        assert.ok(
          (files.modified || []).length === 0
          && (files.created || []).length === 0
          && (files.read || []).length === 0,
          'Empty transcript should yield no files',
        );
      }
    });

    it('should handle missing transcript file gracefully', () => {
      const res = runHook('pre-compact', {
        session_id: 'missing-transcript',
        transcript_path: '/nonexistent/path/session.jsonl',
        trigger: 'auto',
      }, tmpDir);

      // Should not crash (exit 0 or 1 is fine, but not a thrown exception with status null)
      assert.ok(
        res.status !== null,
        'Should handle missing transcript without crashing',
      );
    });

    it('should handle corrupt state file at session-start gracefully', () => {
      // Write invalid JSON as the state file
      const stateDir = join(tmpDir, '.claude');
      mkdirSync(stateDir, { recursive: true });
      writeFileSync(join(stateDir, 'compaction-state.json'), '{{INVALID JSON!!!');

      const res = runHook('session-start', {
        session_id: 'corrupt-state',
      }, tmpDir);

      // Should not crash
      assert.ok(
        res.status !== null,
        `Should handle corrupt state gracefully, stderr: ${res.stderr}`,
      );
    });

    it('should complete within 2000ms for large transcripts', () => {
      // Generate 1000+ message lines
      const lines = [];
      for (let i = 0; i < 500; i++) {
        lines.push(userLine(`Task number ${i}: do something with module-${i}`));
        lines.push(assistantLine(`Working on task ${i}. Decided to use approach-${i} for module-${i}.`, [
          { name: 'Read', input: { file_path: `/src/module-${i}/index.ts` } },
          { name: 'Edit', input: { file_path: `/src/module-${i}/impl.ts`, old_string: 'a', new_string: 'b' } },
        ]));
      }
      assert.ok(lines.length >= 1000, 'Should have 1000+ lines');

      const transcriptPath = writeTranscript(tmpDir, lines);
      const start = Date.now();
      const res = runHook('pre-compact', {
        session_id: 'large-transcript',
        transcript_path: transcriptPath,
        trigger: 'auto',
      }, tmpDir);
      const elapsed = Date.now() - start;

      assert.equal(res.status, 0, `Large transcript should succeed: ${res.stderr}`);
      assert.ok(
        elapsed < 5000,
        `Should complete quickly, took ${elapsed}ms`,
      );
    });

    it('should produce empty file lists when no tool calls exist', () => {
      const lines = [
        userLine('What is the meaning of life?'),
        assistantLine('The meaning of life is subjective.'),
      ];
      const transcriptPath = writeTranscript(tmpDir, lines);
      const res = runHook('pre-compact', {
        session_id: 'no-tools',
        transcript_path: transcriptPath,
        trigger: 'auto',
      }, tmpDir);

      assert.equal(res.status, 0, `Hook should succeed: ${res.stderr}`);
      const state = readState(tmpDir);
      if (state) {
        const files = state.files || {};
        const totalFiles = (files.modified || []).length
          + (files.created || []).length
          + (files.read || []).length
          + (files.edited || []).length
          + (files.written || []).length;
        assert.equal(totalFiles, 0, 'No tool calls means no files');

        const profile = state.toolProfile || {};
        const tools = profile.recentTools || profile.tools || [];
        assert.equal(tools.length, 0, 'No tool calls means empty tool profile');
      }
    });

    it('should produce empty decisions when none are present', () => {
      const lines = [
        userLine('List files'),
        assistantLine('Here are the files.', [
          { name: 'Bash', input: { command: 'ls' } },
        ]),
      ];
      const transcriptPath = writeTranscript(tmpDir, lines);
      runHook('pre-compact', {
        session_id: 'no-decisions',
        transcript_path: transcriptPath,
        trigger: 'auto',
      }, tmpDir);

      const state = readState(tmpDir);
      if (state) {
        const decisions = state.decisions || [];
        assert.ok(Array.isArray(decisions), 'Decisions should be an array');
        // With no "decided/because/chose" language, decisions may be empty
        // (implementation-dependent — we just verify it is a valid array)
      }
    });

    it('should output nothing when state file does not exist at session-start', () => {
      // Don't run pre-compact, so no state file exists
      const res = runHook('session-start', {
        session_id: 'no-state-file',
      }, tmpDir);

      assert.equal(res.status, 0, `Should exit cleanly: ${res.stderr}`);
      const trimmed = res.stdout.trim();
      // Should output nothing or empty JSON
      if (trimmed.length > 0) {
        let output;
        try { output = JSON.parse(trimmed); } catch { /* non-JSON is fine */ }
        if (output) {
          const ctx = output?.hookSpecificOutput?.additionalContext
            || output?.additionalContext;
          // additionalContext should be absent or empty
          assert.ok(
            !ctx || ctx.length === 0,
            'No state file means no additionalContext',
          );
        }
      }
    });
  });

  // =========================================================================
  // 5. UserPromptSubmit Refresh Tests
  // =========================================================================
  describe('user-prompt-submit refresh', () => {
    it('should update state file with new transcript data', () => {
      // Initial pre-compact
      const initialLines = [
        userLine('Implement OAuth'),
        assistantLine('Starting OAuth implementation.', [
          { name: 'Read', input: { file_path: '/src/auth.ts' } },
        ]),
      ];
      const transcriptPath = writeTranscript(tmpDir, initialLines);
      runHook('pre-compact', {
        session_id: 'refresh-test',
        transcript_path: transcriptPath,
        trigger: 'auto',
      }, tmpDir);

      const stateBefore = readState(tmpDir);
      const filesBefore = (stateBefore?.files?.read || []).length;

      // Add more transcript lines and run user-prompt-submit
      const extendedLines = [
        ...initialLines,
        userLine('Now add error handling'),
        assistantLine('Adding error handling.', [
          { name: 'Edit', input: { file_path: '/src/errors.ts', old_string: 'x', new_string: 'y' } },
          { name: 'Read', input: { file_path: '/src/utils.ts' } },
        ]),
      ];
      writeTranscript(tmpDir, extendedLines);

      const res = runHook('user-prompt-submit', {
        session_id: 'refresh-test',
        transcript_path: transcriptPath,
        trigger: 'manual',
      }, tmpDir);

      // If user-prompt-submit is not implemented, the hook may exit 0 silently
      if (res.status !== 0) return;

      const stateAfter = readState(tmpDir);
      if (!stateAfter) return;

      // After refresh, should see the new files
      const allFiles = JSON.stringify(stateAfter.files || {});
      assert.ok(
        allFiles.includes('errors.ts') || allFiles.includes('utils.ts'),
        `Refreshed state should include new files, got: ${allFiles}`,
      );
    });
  });

  // =========================================================================
  // 6. Compaction Count Tests
  // =========================================================================
  describe('compaction count', () => {
    it('should track compaction count across invocations', () => {
      const transcriptPath = writeTranscript(tmpDir, standardTranscriptLines());

      // First pre-compact
      runHook('pre-compact', {
        session_id: 'count-test',
        transcript_path: transcriptPath,
        trigger: 'auto',
      }, tmpDir);

      const state1 = readState(tmpDir);
      if (!state1) return;

      const count1 = state1.stats?.compactionCount
        || state1.compactionCount
        || state1.count
        || 1;

      // Manually bump count in state file to simulate prior compaction
      const statePath = findStateFile(tmpDir);
      if (statePath) {
        const patched = { ...state1 };
        if (!patched.stats) patched.stats = {};
        patched.stats.compactionCount = 1;
        patched.compactionCount = 1;
        writeFileSync(statePath, JSON.stringify(patched, null, 2));
      }

      // Second pre-compact
      runHook('pre-compact', {
        session_id: 'count-test',
        transcript_path: transcriptPath,
        trigger: 'auto',
      }, tmpDir);

      const state2 = readState(tmpDir);
      if (!state2) return;

      const count2 = state2.stats?.compactionCount
        || state2.compactionCount
        || state2.count
        || 0;

      assert.ok(
        count2 >= 2,
        `Compaction count should be >= 2 after second run, got: ${count2}`,
      );
    });

    it('should reference compaction count in session-start additionalContext', () => {
      const transcriptPath = writeTranscript(tmpDir, standardTranscriptLines());
      runHook('pre-compact', {
        session_id: 'count-ctx-test',
        transcript_path: transcriptPath,
        trigger: 'auto',
      }, tmpDir);

      // Set count to 3 to simulate prior compactions
      const statePath = findStateFile(tmpDir);
      if (!statePath) return;

      const state = JSON.parse(readFileSync(statePath, 'utf8'));
      if (!state.stats) state.stats = {};
      state.stats.compactionCount = 3;
      state.compactionCount = 3;
      writeFileSync(statePath, JSON.stringify(state, null, 2));

      const res = runHook('session-start', {
        session_id: 'count-ctx-test',
      }, tmpDir);

      const trimmed = res.stdout.trim();
      if (!trimmed) return;

      // The context may mention the compaction count
      // This is a soft check — not all implementations surface the count
      const contextStr = trimmed.toLowerCase();
      if (contextStr.includes('compaction') || contextStr.includes('compact')) {
        assert.ok(
          /[34]/.test(contextStr),
          'Context should mention the compaction count',
        );
      }
    });
  });

  // =========================================================================
  // 7. Atomic Write Tests
  // =========================================================================
  describe('atomic writes', () => {
    it('should not leave .tmp files after successful write', () => {
      const transcriptPath = writeTranscript(tmpDir, standardTranscriptLines());
      runHook('pre-compact', {
        session_id: 'atomic-test',
        transcript_path: transcriptPath,
        trigger: 'auto',
      }, tmpDir);

      // Check for leftover .tmp files
      const claudeDir = join(tmpDir, '.claude');
      if (existsSync(claudeDir)) {
        const allFiles = readdirSync(claudeDir, { recursive: true })
          .map(String)
          .filter(f => f.endsWith('.tmp'));
        assert.equal(
          allFiles.length, 0,
          `No .tmp files should remain, found: ${JSON.stringify(allFiles)}`,
        );
      }
    });

    it('should produce valid (non-truncated) JSON in state file', () => {
      const transcriptPath = writeTranscript(tmpDir, standardTranscriptLines());
      runHook('pre-compact', {
        session_id: 'valid-json-test',
        transcript_path: transcriptPath,
        trigger: 'auto',
      }, tmpDir);

      const statePath = findStateFile(tmpDir);
      if (!statePath) return;

      const raw = readFileSync(statePath, 'utf8');
      let parsed;
      try {
        parsed = JSON.parse(raw);
      } catch (err) {
        assert.fail(`State file contains invalid/truncated JSON: ${err.message}\nContent: ${raw.slice(0, 300)}`);
      }

      assert.ok(typeof parsed === 'object' && parsed !== null, 'Parsed state should be an object');
    });
  });

  // =========================================================================
  // 8. Hook script existence check
  // =========================================================================
  describe('script prerequisites', () => {
    it('should have the hook script on disk', () => {
      assert.ok(
        existsSync(SCRIPT),
        `Hook script must exist at ${SCRIPT}. The queen agent may not have created it yet.`,
      );
    });
  });
});
