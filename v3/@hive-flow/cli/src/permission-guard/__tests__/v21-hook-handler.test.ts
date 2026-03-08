/**
 * Permission Guard v2.1 — Hook Handler + Settings Tests (Steps 1-2)
 *
 * Tests for the CJS/ESM fix (Bug A), async IIFE fix (Bug B),
 * and timeout configuration change.
 *
 * These are integration-style tests that verify the hook-handler.cjs
 * file structure and settings.json configuration, since the hook-handler
 * runs as a subprocess (not a library import).
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve, join } from 'node:path';

// ---------------------------------------------------------------------------
// Paths to the actual files under test
// ---------------------------------------------------------------------------

const ROOT = resolve(__dirname, '..', '..', '..', '..', '..', '..');
const HOOK_HANDLER_PATH = join(ROOT, '.claude', 'helpers', 'hook-handler.cjs');
const SETTINGS_PATH = join(ROOT, '.claude', 'settings.json');

// ---------------------------------------------------------------------------
// Read files once for all tests
// ---------------------------------------------------------------------------

let hookHandlerSource: string;
let settingsJson: Record<string, unknown>;

try {
  hookHandlerSource = readFileSync(HOOK_HANDLER_PATH, 'utf-8');
} catch {
  hookHandlerSource = '';
}

try {
  settingsJson = JSON.parse(readFileSync(SETTINGS_PATH, 'utf-8'));
} catch {
  settingsJson = {};
}

// ---------------------------------------------------------------------------
// Step 1, Test 1: ESM import fix (Bug A)
// ---------------------------------------------------------------------------

describe('Step 1: hook-handler.cjs Bug A fix (CJS/ESM)', () => {
  it('hook-handler.cjs exists and is non-empty', () => {
    expect(hookHandlerSource.length).toBeGreaterThan(0);
  });

  it('permission-guard handler uses import() for ESM loading', () => {
    // The fix: use dynamic import() instead of require() for ESM gate module
    expect(hookHandlerSource).toContain('await import(');
  });

  it('permission-guard handler uses pathToFileURL for cross-platform ESM import', () => {
    // The fix: pathToFileURL() ensures proper file:// URL on all platforms
    expect(hookHandlerSource).toContain('pathToFileURL');
  });

  it('permission-guard handler does NOT use require() to load gate module', () => {
    // Bug A: require() cannot load ESM modules. The permission-guard handler
    // must NOT use require() for the gate module.
    // We check that the permission-guard handler section uses import(), not require(),
    // for the gate path specifically.
    const pgStart = hookHandlerSource.indexOf("'permission-guard':");
    expect(pgStart).toBeGreaterThan(-1);
    // Extract a large enough section to cover the full handler body
    const handlerBody = hookHandlerSource.slice(pgStart, pgStart + 6000);
    // Should NOT have: const gate = require(gatePath)
    expect(handlerBody).not.toMatch(/const\s+gate\s*=\s*require\s*\(/);
    // Should have: await import(...)
    expect(handlerBody).toContain('await import(');
  });

  it('pathToFileURL is imported from url module', () => {
    // The fix requires: const { pathToFileURL } = require('url');
    expect(hookHandlerSource).toMatch(/require\s*\(\s*['"]url['"]\s*\)/);
  });

  it('gate path resolves to permission-guard/gate.js', () => {
    // The gate module path should point to the compiled gate.js
    expect(hookHandlerSource).toContain('gate.js');
    expect(hookHandlerSource).toContain('permission-guard');
  });
});

// ---------------------------------------------------------------------------
// Step 1, Test 2-3: Async IIFE fix (Bug B)
// ---------------------------------------------------------------------------

describe('Step 1: hook-handler.cjs Bug B fix (async IIFE)', () => {
  it('execution block is wrapped in async IIFE', () => {
    // The fix: wrap execution in (async () => { ... })() to properly await
    // async handlers like permission-guard
    expect(hookHandlerSource).toMatch(/\(\s*async\s*\(\s*\)\s*=>\s*\{/);
  });

  it('handler execution uses await', () => {
    // The fix: await handlers[command]() instead of just handlers[command]()
    expect(hookHandlerSource).toMatch(/await\s+handlers\[command\]\(\)/);
  });

  it('permission-guard handler is async', () => {
    // The permission-guard handler must be async (reads stdin, loads ESM)
    expect(hookHandlerSource).toMatch(/'permission-guard':\s*async/);
  });

  it('sync handlers still work inside async IIFE (await undefined is safe)', () => {
    // Verify that non-async handlers are still defined (not converted to async)
    // await on their return value (undefined) resolves immediately
    const syncHandlers = ['route', 'pre-bash', 'post-edit', 'session-restore', 'session-end', 'pre-task', 'post-task'];
    for (const handler of syncHandlers) {
      // These handlers should exist and NOT be marked async
      const pattern = new RegExp(`'${handler}':\\s*(?:async\\s*)?\\(`);
      expect(hookHandlerSource).toMatch(pattern);
    }

    // Specifically, route/pre-bash/post-edit should NOT be async
    for (const handler of ['route', 'pre-bash', 'post-edit']) {
      const asyncPattern = new RegExp(`'${handler}':\\s*async\\s*\\(`);
      expect(hookHandlerSource).not.toMatch(asyncPattern);
    }
  });

  it('error handling catches errors from both sync and async handlers', () => {
    // The async IIFE should have try/catch for error handling
    // Check that the execution block has a catch
    const asyncIife = hookHandlerSource.match(/\(\s*async\s*\(\s*\)\s*=>\s*\{([\s\S]*?)\}\s*\)\s*\(\s*\)/);
    expect(asyncIife).not.toBeNull();
    if (asyncIife) {
      expect(asyncIife[1]).toContain('catch');
    }
  });
});

// ---------------------------------------------------------------------------
// Step 1, Test 4: Gate not compiled fallback
// ---------------------------------------------------------------------------

describe('Step 1: Gate not compiled fallback', () => {
  it('permission-guard handler has catch block for gate load failure', () => {
    // When gate.js cannot be loaded, the catch block should fall through
    // to a default allow decision. Check the full source since the handler
    // has deeply nested braces.
    const pgStart = hookHandlerSource.indexOf("'permission-guard':");
    expect(pgStart).toBeGreaterThan(-1);

    // The handler body (after the start marker) should contain catch blocks
    const handlerSection = hookHandlerSource.slice(pgStart, pgStart + 2000);
    expect(handlerSection).toContain('catch');
    // Should have a fallback JSON output with permissionDecision allow
    expect(handlerSection).toContain("permissionDecision: 'allow'");
  });

  it('fallback outputs valid JSON with permissionDecision allow', () => {
    // The fallback must produce JSON that Claude Code can parse
    // Look for the fallback console.log(JSON.stringify(...)) pattern
    expect(hookHandlerSource).toMatch(/console\.log\(JSON\.stringify\(\{[\s\S]*?permissionDecision:\s*'allow'/);
  });
});

// ---------------------------------------------------------------------------
// Step 2: Settings.json timeout
// ---------------------------------------------------------------------------

describe('Step 2: settings.json permission-guard timeout', () => {
  it('settings.json exists and is valid JSON', () => {
    expect(Object.keys(settingsJson).length).toBeGreaterThan(0);
  });

  it('permission-guard hook has timeout of 15000ms', () => {
    const hooks = settingsJson.hooks as Record<string, unknown[]>;
    expect(hooks).toBeDefined();
    expect(hooks.PreToolUse).toBeDefined();

    // Find the permission-guard hook entry
    const preToolUseEntries = hooks.PreToolUse as Array<{
      matcher?: string;
      hooks?: Array<{ command?: string; timeout?: number }>;
    }>;

    let permGuardTimeout: number | undefined;
    for (const entry of preToolUseEntries) {
      if (!entry.hooks) continue;
      for (const hook of entry.hooks) {
        if (hook.command && hook.command.includes('permission-guard')) {
          permGuardTimeout = hook.timeout;
        }
      }
    }

    expect(permGuardTimeout).toBe(15000);
  });

  it('other hooks retain their original timeouts (not affected by permission-guard change)', () => {
    const hooks = settingsJson.hooks as Record<string, unknown[]>;

    // Pre-bash hook should NOT have 15000 timeout
    const preToolUseEntries = hooks.PreToolUse as Array<{
      matcher?: string;
      hooks?: Array<{ command?: string; timeout?: number }>;
    }>;

    for (const entry of preToolUseEntries) {
      if (!entry.hooks) continue;
      for (const hook of entry.hooks) {
        if (hook.command && hook.command.includes('pre-bash')) {
          // pre-bash should have its original timeout (5000)
          expect(hook.timeout).toBe(5000);
          expect(hook.timeout).not.toBe(15000);
        }
      }
    }
  });

  it('permission-guard hook matches Bash, Write, Edit, MultiEdit, and WebFetch tools', () => {
    const hooks = settingsJson.hooks as Record<string, unknown[]>;
    const preToolUseEntries = hooks.PreToolUse as Array<{
      matcher?: string;
      hooks?: Array<{ command?: string; timeout?: number }>;
    }>;

    let permGuardMatcher: string | undefined;
    for (const entry of preToolUseEntries) {
      if (!entry.hooks) continue;
      for (const hook of entry.hooks) {
        if (hook.command && hook.command.includes('permission-guard')) {
          permGuardMatcher = entry.matcher;
        }
      }
    }

    expect(permGuardMatcher).toBeDefined();
    // Should match Bash at minimum
    expect(permGuardMatcher).toContain('Bash');
  });
});

// ---------------------------------------------------------------------------
// Step 1+2 combined: Permission-guard handler structure
// ---------------------------------------------------------------------------

describe('Permission-guard handler structure', () => {
  it('handler reads stdin for hook input', () => {
    // The permission-guard handler must read JSON from stdin
    expect(hookHandlerSource).toContain('process.stdin');
  });

  it('handler parses JSON from stdin', () => {
    expect(hookHandlerSource).toContain('JSON.parse');
  });

  it('handler calls evaluateHookInput when gate module loads', () => {
    expect(hookHandlerSource).toContain('evaluateHookInput');
  });

  it('handler outputs deny decision with reason', () => {
    const pgStart = hookHandlerSource.indexOf("'permission-guard':");
    expect(pgStart).toBeGreaterThan(-1);
    const handlerSection = hookHandlerSource.slice(pgStart, pgStart + 6000);
    expect(handlerSection).toContain("permissionDecision: 'deny'");
    expect(handlerSection).toContain('permissionDecisionReason');
  });

  it('handler outputs allow decision for approved commands', () => {
    const pgStart = hookHandlerSource.indexOf("'permission-guard':");
    expect(pgStart).toBeGreaterThan(-1);
    const handlerSection = hookHandlerSource.slice(pgStart, pgStart + 6000);
    expect(handlerSection).toContain("permissionDecision: 'allow'");
  });
});
