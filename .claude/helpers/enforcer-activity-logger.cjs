#!/usr/bin/env node
/**
 * PostToolUse — queen delegation telemetry for enforcer-monitor.
 * Appends to .hive-flow/enforcement/enforcer-activity.jsonl
 */
const fs = require('fs');
const path = require('path');
const os = require('os');

const { getRoleFilePath } = require('./role-enforcement.cjs');

const PROJECT_DIR = path.resolve(__dirname, '..', '..');
// Control-plane telemetry is global (mirrors enforcement.cjs / role-enforcement.cjs). Activity is
// WRITTEN to the global enforcement home; the monitor reads global-first with a legacy fallback
// during migration. Role peek uses role-enforcement's getRoleFilePath, already global post-slice-1.
function resolveHiveHome() {
  const configured = String(process.env.HIVE_FLOW_HOME || '').trim();
  if (configured && path.isAbsolute(configured)) return path.resolve(configured);
  return path.join(os.homedir(), '.hive-flow');
}
const HIVE_HOME = resolveHiveHome();
const DEST = path.join(HIVE_HOME, 'enforcement', 'enforcer-activity.jsonl');
const MAX_BYTES = 5 * 1024 * 1024;

/** Fast role peek — no HMAC verify (hook speed). */
function peekRoleContext(agentId) {
  try {
    const roleFile = getRoleFilePath(agentId);
    if (!roleFile || !fs.existsSync(roleFile)) return { roleType: null, hiveId: null };
    const raw = JSON.parse(fs.readFileSync(roleFile, 'utf8'));
    const state = raw.state || raw;
    return { roleType: state.type ?? null, hiveId: state.hiveId ?? null };
  } catch {
    return { roleType: null, hiveId: null };
  }
}

const WORKish = new Set([
  'Bash', 'Write', 'Edit', 'MultiEdit', 'NotebookEdit', 'WebFetch',
  'mcp__filesystem__write_file', 'mcp__filesystem__edit_file',
  'mcp__filesystem__move_file', 'mcp__filesystem__create_directory',
]);

const QUEEN_TOOLS = new Set([
  'mcp__hive-flow__queen_task_worker',
  'mcp__hive-flow__queen_mission_assign',
  'mcp__hive-flow__queen_spawn_worker',
  'mcp__hive-flow__queen_collect_results',
  'mcp__hive-flow__queen_report',
]);

function classifyEvent(toolName, roleType) {
  if (QUEEN_TOOLS.has(toolName)) {
    if (toolName === 'mcp__hive-flow__queen_task_worker') return 'delegation';
    return 'coordination';
  }
  if (roleType === 'queen' && WORKish.has(toolName)) return 'direct-work';
  return null;
}

function rotateIfHuge() {
  try {
    if (!fs.existsSync(DEST)) return;
    const st = fs.statSync(DEST);
    if (st.size < MAX_BYTES) return;
    const bak = DEST.replace(/\.jsonl$/, '.1.jsonl');
    try {
      if (fs.existsSync(bak)) fs.unlinkSync(bak);
    } catch { /* ignore */ }
    fs.renameSync(DEST, bak);
  } catch { /* ignore */ }
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
    process.env.AGENTIC_FLOW_AGENT_ID || process.env.CLAUDE_SESSION_ID || process.env.CLAUDE_AGENT_ID || '';
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

  const { roleType, hiveId } = peekRoleContext(agentId);
  const event = classifyEvent(toolName, roleType);
  if (!event) {
    process.stdout.write(JSON.stringify({}));
    return;
  }

  rotateIfHuge();
  try {
    fs.mkdirSync(path.dirname(DEST), { recursive: true });
    const now = new Date().toISOString();
    const row = {
      ts: now,
      timestamp: now,
      event,
      tool: toolName,
      agentId,
      hiveId: hiveId ?? null,
    };
    fs.appendFileSync(DEST, JSON.stringify(row) + '\n', 'utf8');
  } catch { /* ignore */ }

  process.stdout.write(JSON.stringify({}));
}

main();
