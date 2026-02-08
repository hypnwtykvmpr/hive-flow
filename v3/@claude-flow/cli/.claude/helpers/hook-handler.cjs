#!/usr/bin/env node
/**
 * Claude Flow Hook Handler
 * Cross-platform CommonJS dispatcher for Claude Code hooks.
 * Delegates to router.js, session.js, memory.js helpers with
 * console suppression during require() to prevent noisy output.
 *
 * Usage: node .claude/helpers/hook-handler.cjs <command> [args...]
 *
 * Commands:
 *   route              - Route task to optimal agent (UserPromptSubmit)
 *   pre-bash           - Pre-command safety check (PreToolUse:Bash)
 *   post-edit          - Post-edit learning (PostToolUse:Write|Edit)
 *   session-start      - Start new session (SessionStart)
 *   session-restore    - Restore previous session (SessionStart:resume)
 *   session-end        - End session, persist state (SessionEnd)
 *   memory-import      - Import auto memory entries (SessionStart)
 *   memory-sync        - Sync memory to files (SessionEnd/Stop)
 *   status             - Show hook handler status
 */
'use strict';

const path = require('path');

// ── Helpers ──────────────────────────────────────────────────────────

/**
 * Require a helper module with console suppressed to prevent
 * CLI output from the module's top-level code.
 */
function quietRequire(modulePath) {
  const origLog = console.log;
  const origErr = console.error;
  const origWarn = console.warn;
  try {
    console.log = () => {};
    console.error = () => {};
    console.warn = () => {};
    return require(modulePath);
  } catch {
    return null;
  } finally {
    console.log = origLog;
    console.error = origErr;
    console.warn = origWarn;
  }
}

/**
 * Try to load auto-memory-hook.mjs (ESM) via dynamic import.
 * Falls back gracefully if unavailable.
 */
async function runAutoMemory(command) {
  try {
    const hookPath = path.join(__dirname, 'auto-memory-hook.mjs');
    // Dynamic import for ESM module
    const mod = await import('file://' + hookPath.replace(/\\/g, '/'));
    if (typeof mod.default === 'function') {
      await mod.default(command);
    }
  } catch {
    // auto-memory-hook not available — non-critical
  }
}

// ── Command handlers ─────────────────────────────────────────────────

const commands = {
  'route': () => {
    const router = quietRequire(path.join(__dirname, 'router.js'));
    if (!router) return;
    // Read task from stdin env or use a generic route
    const task = process.env.USER_PROMPT || process.argv.slice(3).join(' ') || '';
    if (task && router.routeTask) {
      const result = router.routeTask(task);
      if (result) {
        console.log(`Routed to: ${result.agent} (confidence: ${result.confidence})`);
      }
    }
  },

  'pre-bash': () => {
    // Lightweight safety check — just validates the command isn't destructive
    const cmd = process.env.TOOL_INPUT || process.argv[3] || '';
    const dangerous = /rm\s+-rf\s+[\/~]|mkfs|dd\s+if=|>\s*\/dev\/sd|shutdown|reboot/i;
    if (dangerous.test(cmd)) {
      console.error('BLOCKED: Potentially destructive command detected');
      process.exit(2);
    }
    // Pass — no output means approved
  },

  'post-edit': () => {
    const session = quietRequire(path.join(__dirname, 'session.js'));
    if (session && session.metric) {
      session.metric('edits');
    }
  },

  'session-start': () => {
    const session = quietRequire(path.join(__dirname, 'session.js'));
    if (session && session.start) {
      session.start();
    }
  },

  'session-restore': () => {
    const session = quietRequire(path.join(__dirname, 'session.js'));
    if (!session) return;
    // Try restore first, fall back to start
    if (session.restore) {
      const restored = session.restore();
      if (restored) {
        console.log(`Session restored: ${restored.id}`);
        return;
      }
    }
    if (session.start) {
      const s = session.start();
      if (s) console.log(`Session started: ${s.id}`);
    }
  },

  'session-end': async () => {
    const session = quietRequire(path.join(__dirname, 'session.js'));
    if (session && session.end) {
      session.end();
    }
    // Also sync auto-memory
    await runAutoMemory('sync');
  },

  'memory-import': async () => {
    await runAutoMemory('import');
  },

  'memory-sync': async () => {
    await runAutoMemory('sync');
  },

  'status': () => {
    const helpers = ['router.js', 'session.js', 'memory.js', 'auto-memory-hook.mjs', 'statusline.cjs'];
    const fs = require('fs');

    console.log('Hook Handler Status');
    console.log('-------------------');
    for (const h of helpers) {
      const exists = fs.existsSync(path.join(__dirname, h));
      console.log(`  ${exists ? 'OK' : 'MISSING'}  ${h}`);
    }
    console.log(`  Platform: ${process.platform}`);
    console.log(`  Node: ${process.version}`);
    console.log(`  CWD: ${process.cwd()}`);
  },
};

// ── Main ─────────────────────────────────────────────────────────────

const command = process.argv[2];

if (command && commands[command]) {
  const result = commands[command]();
  // Handle async commands
  if (result && typeof result.then === 'function') {
    result.catch(() => {});
  }
} else if (command) {
  // Unknown command — silent pass (don't break hooks)
  process.exit(0);
} else {
  console.log('Usage: hook-handler.cjs <command> [args...]');
  console.log('Commands: ' + Object.keys(commands).join(', '));
}
