#!/usr/bin/env node
/**
 * Lightweight Claude Code activity-tracker hook entrypoint (hive-flow-f16a).
 *
 * Invoked as: claude-activity-hook <event>   with the hook payload on stdin.
 *
 * Keep this intentionally small. Do not import src/index.js, commands/index.js,
 * update checks, MCP startup code, or the CLI parser here — this runs on EVERY
 * hook event and must stay fast.
 *
 * FAIL-OPEN CONTRACT: this process exits 0 unconditionally. A tracker hook must
 * never block, delay, or fail a Claude Code turn; a lost activity record simply
 * means the statusline omits activity rather than fabricating it.
 */
import { readFileSync } from 'node:fs';

function readStdin() {
  try {
    return readFileSync(0, 'utf8');
  } catch {
    return '';
  }
}

try {
  const event = process.argv[2] ?? '';
  let payload = {};
  try {
    // Accept an optional UTF-8 BOM before the JSON payload.
    const parsed = JSON.parse((readStdin() || '{}').replace(/^﻿/, ''));
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) payload = parsed;
  } catch {
    // Malformed payload: the tracker validates and will write nothing.
  }
  const { recordHookEvent } = await import('../dist/src/statusline/claude-activity-state.js');
  recordHookEvent(event, payload);
} catch {
  // Never surface an error to Claude Code.
}

process.exit(0);
