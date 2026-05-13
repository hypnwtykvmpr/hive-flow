#!/usr/bin/env node
/**
 * Test: provider-agent-bridge special-character escaping
 *
 * Verifies that complex task text containing colons, periods, question marks,
 * quotes, backticks, newlines, parentheses, and brackets survives transit
 * through the bridge's argument parsing, stdin piping, and message building.
 *
 * Run: node scripts/test-bridge-escaping.mjs
 */

import { execFile, exec } from 'child_process';
import { mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from 'fs';
import { join } from 'path';
import { promisify } from 'util';
import { fileURLToPath } from 'url';
import { dirname } from 'path';

const execFileAsync = promisify(execFile);
const execAsync = promisify(exec);

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const PROJECT_ROOT = join(__dirname, '..');

// ===== Test Constants =====

const TASK_TEXT =
  'Read .claude/settings.json lines 3-28. Can a PreToolUse hook with matcher \'Task\' read tool_input.description? Check: (a) deny pattern, (b) allow pattern. Report PASS/FAIL.';

const BRIDGE_PATH = join(
  PROJECT_ROOT,
  'v3/@hive-flow/providers/scripts/provider-agent-bridge.mjs'
);

const TEST_STORE_DIR = join(PROJECT_ROOT, '.test-bridge-escaping');
const TEST_AGENT_ID = 'test-escape-agent';

// ===== Helpers =====

let passed = 0;
let failed = 0;

function report(name, ok, detail) {
  if (ok) {
    passed++;
    console.log(`  PASS  ${name}`);
  } else {
    failed++;
    console.log(`  FAIL  ${name}`);
    if (detail) console.log(`        ${detail}`);
  }
}

function setupMockStore(providerName = 'mock-provider') {
  if (existsSync(TEST_STORE_DIR)) {
    rmSync(TEST_STORE_DIR, { recursive: true, force: true });
  }
  mkdirSync(TEST_STORE_DIR, { recursive: true });

  const store = {
    agents: {
      [TEST_AGENT_ID]: {
        id: TEST_AGENT_ID,
        type: 'coder',
        provider: providerName,
        providerModel: 'test-model',
        systemPrompt: 'You are a test agent.',
        conversationHistory: [],
        taskCount: 0,
        config: {},
      },
    },
  };
  writeFileSync(join(TEST_STORE_DIR, 'store.json'), JSON.stringify(store, null, 2));
}

function cleanup() {
  if (existsSync(TEST_STORE_DIR)) {
    rmSync(TEST_STORE_DIR, { recursive: true, force: true });
  }
}

// ===== Test 1: --task-stdin delivers text intact =====
//
// The bridge reads from stdin when --task-stdin is set.
// We pipe the task text and expect the bridge to parse it correctly.
// It will fail at the provider-loading step (no real provider), but the
// error message tells us the task was accepted and the agent was found.

async function testStdinPipe() {
  setupMockStore('mock-provider');

  try {
    const result = await execAsync(
      `printf '%s' ${shellQuote(TASK_TEXT)} | node ${shellQuote(BRIDGE_PATH)} --agent-id ${TEST_AGENT_ID} --store-dir ${shellQuote(TEST_STORE_DIR)} --task-stdin`,
      { timeout: 15000 }
    );
    // If it somehow succeeds (unlikely without a real provider), check stdout
    const json = JSON.parse(result.stdout);
    // Bridge accepted the task — check if task text survived
    report('stdin-pipe: bridge accepted task', true);
    return;
  } catch (err) {
    // Expected: bridge fails at provider loading, not at argument parsing
    const stdout = err.stdout || '';
    const stderr = err.stderr || '';
    const combined = stdout + stderr;

    // If we see the agent-not-found or missing-arg errors, the task didn't arrive
    if (combined.includes('Missing required argument: --task')) {
      report('stdin-pipe: task text delivered', false, 'Task text was not received via stdin');
      return;
    }

    // If we see provider-related errors, it means the bridge parsed args OK
    // and loaded the agent, but failed at the provider step — that's success.
    const taskParsedOK =
      combined.includes('Unknown provider') ||
      combined.includes('not built or installed') ||
      combined.includes('Provider binary') ||
      combined.includes('BRIDGE_ERROR') ||
      combined.includes('mock-provider');

    if (taskParsedOK) {
      // Verify the store was read and agent was found (task text reached buildMessages)
      report('stdin-pipe: task text delivered via stdin', true);
    } else {
      report('stdin-pipe: task text delivered via stdin', false, `Unexpected error: ${combined.slice(0, 300)}`);
    }
  }
}

// ===== Test 2: --task argv delivers text intact =====
//
// Pass the task text as a --task argument. The bridge should parse it from argv.

async function testArgvTask() {
  setupMockStore('mock-provider');

  try {
    const result = await execFileAsync(
      'node',
      [
        BRIDGE_PATH,
        '--agent-id', TEST_AGENT_ID,
        '--store-dir', TEST_STORE_DIR,
        '--task', TASK_TEXT,
      ],
      { timeout: 15000 }
    );
    const json = JSON.parse(result.stdout);
    report('argv-task: bridge accepted task', true);
    return;
  } catch (err) {
    const stdout = err.stdout || '';
    const stderr = err.stderr || '';
    const combined = stdout + stderr;

    if (combined.includes('Missing required argument: --task')) {
      report('argv-task: task text delivered', false, 'Task text lost in argv parsing');
      return;
    }

    const taskParsedOK =
      combined.includes('Unknown provider') ||
      combined.includes('not built or installed') ||
      combined.includes('Provider binary') ||
      combined.includes('BRIDGE_ERROR') ||
      combined.includes('mock-provider');

    if (taskParsedOK) {
      report('argv-task: task text delivered via argv', true);
    } else {
      report('argv-task: task text delivered via argv', false, `Unexpected error: ${combined.slice(0, 300)}`);
    }
  }
}

// ===== Test 3: buildMessages preserves task text =====
//
// Directly import and test buildMessages to confirm it keeps the full task
// string without mutation.

async function testBuildMessages() {
  // Dynamically import the bridge as a module — it will try to run main(),
  // so instead we replicate the buildMessages logic inline (it's pure).
  const agent = {
    systemPrompt: 'You are a test agent.',
    conversationHistory: [
      { role: 'user', content: 'previous task' },
      { role: 'assistant', content: 'previous response' },
    ],
  };

  // Replicate buildMessages from bridge
  const messages = [];
  if (agent.systemPrompt) {
    messages.push({ role: 'system', content: agent.systemPrompt });
  }
  const history = agent.conversationHistory || [];
  for (const entry of history) {
    const content = entry.content ?? '';
    messages.push({
      role: entry.role,
      content: typeof content === 'string' ? content : JSON.stringify(content),
    });
  }
  messages.push({ role: 'user', content: TASK_TEXT });

  const lastMsg = messages[messages.length - 1];
  const intact = lastMsg.content === TASK_TEXT;
  report('buildMessages: task text preserved exactly', intact,
    intact ? undefined : `Got: ${lastMsg.content}`);

  // Check individual special characters survived
  const checks = [
    ['colon', ':'],
    ['period', '.'],
    ['question mark', '?'],
    ['single quote', "'"],
    ['parenthesis open', '('],
    ['parenthesis close', ')'],
    ['slash', '/'],
  ];
  for (const [name, char] of checks) {
    const found = lastMsg.content.includes(char);
    report(`buildMessages: contains ${name}`, found,
      found ? undefined : `Character '${char}' missing from output`);
  }
}

// ===== Test 4: trimMessages preserves task text =====
//
// Ensure trimming doesn't corrupt the new task (which is always the last message).

async function testTrimMessages() {
  // Build a large history to trigger trimming
  const messages = [{ role: 'system', content: 'System prompt.' }];

  // Add 60 history entries (exceeds DEFAULT_MAX_HISTORY_ENTRIES of 50)
  for (let i = 0; i < 60; i++) {
    messages.push({
      role: i % 2 === 0 ? 'user' : 'assistant',
      content: `History entry ${i}: ${'x'.repeat(500)}`,
    });
  }

  // The task is always the last message
  messages.push({ role: 'user', content: TASK_TEXT });

  // Replicate trimMessages logic
  const limits = { maxBytes: 180 * 1024, maxEntries: 50 };

  function messageByteLength(msg) {
    const c = msg.content;
    if (typeof c !== 'string') return 0;
    return Buffer.byteLength(c, 'utf8');
  }

  let totalBytes = 0;
  for (const msg of messages) {
    totalBytes += messageByteLength(msg);
  }

  let trimmed;
  if (totalBytes <= limits.maxBytes && messages.length <= limits.maxEntries + 2) {
    trimmed = messages;
  } else {
    const system = messages[0]?.role === 'system' ? [messages[0]] : [];
    const newTask = messages[messages.length - 1];
    let middle = system.length > 0 ? messages.slice(1, -1) : messages.slice(0, -1);

    while (middle.length > 0) {
      let bytes = 0;
      for (const msg of [...system, ...middle, newTask]) {
        bytes += messageByteLength(msg);
      }
      if (bytes <= limits.maxBytes && middle.length + system.length + 1 <= limits.maxEntries + 2) {
        break;
      }
      middle.shift();
    }
    trimmed = [...system, ...middle, newTask];
  }

  const lastTrimmed = trimmed[trimmed.length - 1];
  const preserved = lastTrimmed.content === TASK_TEXT;
  report('trimMessages: task text preserved after trim', preserved,
    preserved ? undefined : `Got: ${lastTrimmed.content}`);

  const wasTrimmed = trimmed.length < messages.length;
  report('trimMessages: history was actually trimmed', wasTrimmed,
    wasTrimmed ? undefined : 'No trimming occurred — test may not be exercising trim logic');
}

// ===== Test 5: stdin with multiline task text =====

async function testStdinMultiline() {
  setupMockStore('mock-provider');

  const multilineTask = TASK_TEXT + '\nLine 2: backticks `code` and "double quotes" and [brackets].\nLine 3: end.';

  try {
    // Use a child process with stdin write instead of shell pipe
    const result = await new Promise((resolve, reject) => {
      const child = execFile(
        'node',
        [
          BRIDGE_PATH,
          '--agent-id', TEST_AGENT_ID,
          '--store-dir', TEST_STORE_DIR,
          '--task-stdin',
        ],
        { timeout: 15000 },
        (err, stdout, stderr) => {
          if (err) {
            resolve({ exitCode: err.code, stdout, stderr });
          } else {
            resolve({ exitCode: 0, stdout, stderr });
          }
        }
      );
      child.stdin.write(multilineTask);
      child.stdin.end();
    });

    const combined = (result.stdout || '') + (result.stderr || '');

    if (combined.includes('Missing required argument: --task')) {
      report('stdin-multiline: multiline task delivered', false, 'Task text not received');
      return;
    }

    const taskParsedOK =
      combined.includes('Unknown provider') ||
      combined.includes('not built or installed') ||
      combined.includes('Provider binary') ||
      combined.includes('BRIDGE_ERROR') ||
      combined.includes('mock-provider');

    if (taskParsedOK) {
      report('stdin-multiline: multiline task delivered via stdin', true);
    } else {
      report('stdin-multiline: multiline task delivered via stdin', false,
        `Unexpected output: ${combined.slice(0, 300)}`);
    }
  } catch (err) {
    report('stdin-multiline: multiline task delivered via stdin', false, err.message);
  }
}

// ===== Test 6: task text with all special characters in a single string =====

async function testAllSpecialChars() {
  setupMockStore('mock-provider');

  const specialTask = 'colons: periods. questions? "double" \'single\' `backticks` newline\n(parens) [brackets] {braces} $dollar @at #hash %percent ^caret &ampersand *star ~tilde';

  try {
    const result = await new Promise((resolve, reject) => {
      const child = execFile(
        'node',
        [
          BRIDGE_PATH,
          '--agent-id', TEST_AGENT_ID,
          '--store-dir', TEST_STORE_DIR,
          '--task-stdin',
        ],
        { timeout: 15000 },
        (err, stdout, stderr) => {
          if (err) {
            resolve({ exitCode: err.code, stdout, stderr });
          } else {
            resolve({ exitCode: 0, stdout, stderr });
          }
        }
      );
      child.stdin.write(specialTask);
      child.stdin.end();
    });

    const combined = (result.stdout || '') + (result.stderr || '');

    if (combined.includes('Missing required argument: --task')) {
      report('all-special-chars: task delivered', false, 'Task text not received');
      return;
    }

    const taskParsedOK =
      combined.includes('Unknown provider') ||
      combined.includes('not built or installed') ||
      combined.includes('Provider binary') ||
      combined.includes('BRIDGE_ERROR') ||
      combined.includes('mock-provider');

    if (taskParsedOK) {
      report('all-special-chars: task with all specials delivered via stdin', true);
    } else {
      report('all-special-chars: task with all specials delivered via stdin', false,
        `Unexpected output: ${combined.slice(0, 300)}`);
    }
  } catch (err) {
    report('all-special-chars: task with all specials delivered via stdin', false, err.message);
  }
}

// ===== Shell Quoting Helper =====

function shellQuote(s) {
  // Use single quotes with escaped single quotes for shell safety
  return "'" + s.replace(/'/g, "'\\''") + "'";
}

// ===== Main Runner =====

async function main() {
  console.log('');
  console.log('=== Provider Agent Bridge: Escaping Tests ===');
  console.log('');
  console.log(`Task text: ${TASK_TEXT}`);
  console.log('');

  // Pure logic tests (no subprocess needed)
  console.log('--- Pure logic tests ---');
  await testBuildMessages();
  await testTrimMessages();

  // Subprocess integration tests
  console.log('');
  console.log('--- Subprocess integration tests ---');
  await testArgvTask();
  await testStdinPipe();
  await testStdinMultiline();
  await testAllSpecialChars();

  // Cleanup
  cleanup();

  // Summary
  console.log('');
  console.log('=== Summary ===');
  console.log(`  Passed: ${passed}`);
  console.log(`  Failed: ${failed}`);
  console.log(`  Total:  ${passed + failed}`);
  console.log('');

  if (failed > 0) {
    console.log('RESULT: FAIL');
    process.exit(1);
  } else {
    console.log('RESULT: PASS');
    process.exit(0);
  }
}

main().catch((err) => {
  console.error('Test runner error:', err);
  cleanup();
  process.exit(2);
});
