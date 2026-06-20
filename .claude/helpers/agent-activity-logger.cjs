#!/usr/bin/env node
/**
 * PostToolUse — append one JSONL row to .hive-flow/logs/activity.jsonl
 * Fields: ts, agentId, hiveId, role, tool, target, durationMs: 0
 * Stdin: Claude Code PostToolUse JSON. Stdout: always {}
 */
const fs = require('fs');
const path = require('path');

const { loadRole } = require('./role-enforcement.cjs');

const PROJECT_DIR = path.resolve(__dirname, '..', '..'); // BUG-10: __dirname-derived, not env-poisonable
const LOG_DIR = path.join(PROJECT_DIR, '.hive-flow', 'logs');
const ACTIVITY_FILE = path.join(LOG_DIR, 'activity.jsonl');

/** Fast role peek via role-enforcement's HMAC-verified loader. */
function peekRole(agentId) {
  try {
    const state = loadRole(agentId);
    if (!state) return { hiveId: null, role: null };
    return {
      hiveId: state.hiveId ?? null,
      role: state.type ?? null,
    };
  } catch {
    return { hiveId: null, role: null };
  }
}

function extractTarget(toolName, input) {
  const ti = input.tool_input || input.toolInput || input.input || {};
  if (toolName === 'Bash') return String(ti.command ?? '').slice(0, 200);
  if (['Write', 'Edit', 'MultiEdit', 'NotebookEdit'].includes(toolName)) {
    return String(ti.file_path ?? ti.filePath ?? ti.path ?? '');
  }
  if (/^mcp__filesystem__(write_file|edit_file|move_file|create_directory)$/.test(toolName)) {
    return String(ti.path ?? ti.file_path ?? ti.target_path ?? ti.destination ?? '');
  }
  if (toolName === 'Task') return String(ti.description ?? ti.prompt ?? '').slice(0, 200);
  try {
    return JSON.stringify(ti).slice(0, 200);
  } catch {
    return '';
  }
}

function readStdin() {
  try {
    return fs.readFileSync(0, 'utf8');
  } catch {
    return '';
  }
}

function main() {
  const agentId =
    process.env.HIVE_FLOW_AGENT_ID || process.env.CLAUDE_SESSION_ID || process.env.CLAUDE_AGENT_ID || '';
  let input = {};
  try {
    input = JSON.parse(readStdin() || '{}');
  } catch {
    input = {};
  }
  const toolName = input.tool_name || input.toolName || '';
  if (!toolName || !agentId) {
    process.stdout.write(JSON.stringify({}));
    return;
  }

  const { hiveId, role } = peekRole(agentId);
  const target = extractTarget(toolName, input);
  const row = {
    ts: new Date().toISOString(),
    agentId,
    hiveId,
    role,
    tool: toolName,
    target,
    durationMs: 0,
  };
  const safeLine = JSON.stringify(row) + '\n';

  try {
    fs.mkdirSync(LOG_DIR, { recursive: true });
    fs.appendFileSync(ACTIVITY_FILE, safeLine, 'utf8');
  } catch { /* non-fatal */ }

  process.stdout.write(JSON.stringify({}));
}

main();
