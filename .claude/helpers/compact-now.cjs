#!/usr/bin/env node
/*
 * compact-now.cjs
 *
 * Volitional self-compaction trigger. This helper never auto-decides to compact
 * from context percentage, but it does enforce the human's compaction request
 * floor before writing the recovery handoff and arming a one-shot request.
 */

'use strict';

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const VALID_MODES = new Set(['inplace', 'headless']);
const COMPACT_CONTEXT_FLOOR_PCT = 0.50;
const MAX_CONTEXT_STATE_BYTES = 64 * 1024;
const MAX_STATUSLINE_RECORD_BYTES = 256 * 1024;
const MAX_STATUSLINE_PROJECT_RECORDS = 512;
const STATUSLINE_MAX_AGE_MS = 5 * 60 * 1000;
const CORRECT_SELF_COMPACT_COMMAND = [
  'Correct current-session self-compaction command:',
  'node .claude/helpers/compact-now.cjs --mode inplace --reason "<why compaction is needed>" --next-step "<exact next step after compact>"',
  'This writes .hive-flow/data/compaction-handoff.md first, then submits /compact back into Claude\'s own tmux pane when run from that pane.',
  'If context usage cannot be measured, stop and request human intervention; the context measurement layer must be repaired before compaction can be safely requested.',
  'compact-now.cjs --mode headless launches a separate Claude process and must not be used when the current pane/session needs compaction.',
  'Do not git checkout or edit .claude/helpers to activate compaction from inside a governed Claude session.',
].join('\n');

function parseArgs(argv) {
  const parsed = {
    reason: '',
    mode: 'inplace',
    resume: process.env.CLAUDE_SESSION_ID || '',
    goal: process.env.HIVE_FLOW_CURRENT_GOAL || '',
    nextStep: '',
  };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--reason') parsed.reason = argv[++i] || '';
    else if (arg === '--mode') parsed.mode = argv[++i] || '';
    else if (arg === '--resume') parsed.resume = argv[++i] || '';
    else if (arg === '--goal') parsed.goal = argv[++i] || '';
    else if (arg === '--next-step') parsed.nextStep = argv[++i] || '';
    else if (arg === '--help' || arg === '-h') parsed.help = true;
    else throw new Error(`Unknown argument: ${arg}\n\n${CORRECT_SELF_COMPACT_COMMAND}`);
  }

  parsed.reason = sanitizeLine(parsed.reason || 'manual compaction requested', 500);
  parsed.mode = parsed.mode || 'inplace';
  parsed.resume = sanitizeLine(parsed.resume, 200);
  parsed.goal = sanitizeLine(parsed.goal || 'Continue the active human-requested task after compaction.', 500);
  parsed.nextStep = sanitizeLine(
    parsed.nextStep || 'Read this handoff, inspect git status and diff, then continue from the latest verified step.',
    600
  );

  if (!VALID_MODES.has(parsed.mode)) {
    throw new Error(`Invalid --mode "${parsed.mode}". Expected inplace or headless.\n\n${CORRECT_SELF_COMPACT_COMMAND}`);
  }

  return parsed;
}

function sanitizeLine(value, maxLen) {
  return String(value || '')
    .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, maxLen);
}

function resolveProjectRoot() {
  return path.resolve(
    process.env.CLAUDE_PROJECT_DIR
      || process.env.HIVE_FLOW_PROJECT_ROOT
      || process.cwd()
  );
}

function buildPreservationPrompt({ reason, mode, resume, goal, nextStep, handoffPath }) {
  return [
    'Preserve the active task state for a compacted Claude Code session.',
    `Reason: ${reason}.`,
    `Mode: ${mode}.`,
    resume ? `Resume session: ${resume}.` : 'Resume session: use the current Claude session if available.',
    `Current goal: ${goal}.`,
    `Next step: ${nextStep}.`,
    `Recovery note: ${handoffPath}.`,
    'Keep: human constraints, branch and git state, files changed, verification evidence, blockers, explicit no-push/no-secret/private-doc rules, and exact next command.',
    'Drop: stale tool logs, refuted claims, duplicate debate, and resolved tangents.',
    'After compaction: read the recovery note, verify live source before trusting summaries, then continue the active task without asking to restart.',
  ].join(' ');
}

function appendRecoveryNote(handoffPath, request) {
  const block = [
    '',
    `## Compaction Handoff - ${request.handoffWrittenAt}`,
    '',
    `- Reason: ${request.reason}`,
    `- Mode: ${request.mode}`,
    request.resume ? `- Resume: ${request.resume}` : '- Resume: current session',
    `- Current goal: ${request.goal}`,
    `- Next step: ${request.nextStep}`,
    '',
    'Preservation prompt:',
    '',
    request.preservationPrompt,
    '',
  ].join('\n');

  fs.appendFileSync(handoffPath, block, 'utf8');
}

function writeJsonAtomic(filePath, value) {
  const tmpPath = `${filePath}.tmp.${process.pid}.${Date.now()}`;
  fs.writeFileSync(tmpPath, JSON.stringify(value, null, 2), 'utf8');
  fs.renameSync(tmpPath, filePath);
}

function normalizePercentage(value) {
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0) return null;
  if (n <= 1) return n;
  if (n <= 100) return n / 100;
  return null;
}

function readJsonFileIfPresent(filePath, maxBytes = MAX_CONTEXT_STATE_BYTES) {
  try {
    if (!fs.existsSync(filePath)) return null;
    const stat = fs.lstatSync(filePath);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > maxBytes) return null;
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return null;
  }
}

function latestHistoryPercentage(state) {
  if (!Array.isArray(state?.history)) return null;
  for (let i = state.history.length - 1; i >= 0; i--) {
    const pct = normalizePercentage(state.history[i]?.pct);
    if (pct !== null) return pct;
  }
  return null;
}

function numericAt(value, keys) {
  let cursor = value;
  for (const key of keys) {
    if (!cursor || typeof cursor !== 'object') return null;
    cursor = cursor[key];
  }
  const n = Number(cursor);
  return Number.isFinite(n) ? n : null;
}

function normalizeStatuslinePercent(value) {
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0) return null;
  if (n <= 1) return Math.min(n, 1);
  if (n <= 100) return n / 100;
  return null;
}

function stripAnsi(value) {
  return String(value || '').replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, '');
}

function renderedContextPercentage(rendered) {
  const plain = stripAnsi(rendered);
  const match = plain.match(/\b([0-9]+(?:\.[0-9]+)?)%\s+ctx\b/i);
  return match ? normalizeStatuslinePercent(match[1]) : null;
}

function statuslineRecordContextPercentage(record) {
  const pctFromRendered = renderedContextPercentage(record?.rendered);
  if (pctFromRendered !== null) {
    return { percentage: pctFromRendered, detail: 'rendered.context-percent' };
  }

  const recordContext = record?.context;
  const pctFromRecord = normalizeStatuslinePercent(recordContext?.percentage);
  if (pctFromRecord !== null) {
    return { percentage: pctFromRecord, detail: 'context.percentage' };
  }

  const recordTokenEstimate = numericAt(recordContext, ['tokenEstimate']);
  const recordContextWindow = numericAt(recordContext, ['contextWindow']);
  if (
    recordTokenEstimate !== null
    && recordTokenEstimate >= 0
    && recordContextWindow !== null
    && recordContextWindow > 0
  ) {
    return {
      percentage: Math.min(recordTokenEstimate / recordContextWindow, 1),
      detail: 'context.tokenEstimate/contextWindow',
    };
  }

  const snapshotContext = record?.snapshot?.context;
  const pctFromSnapshot = normalizeStatuslinePercent(snapshotContext?.percentage);
  if (pctFromSnapshot !== null) {
    return { percentage: pctFromSnapshot, detail: 'snapshot.context.percentage' };
  }

  const tokenEstimate = numericAt(snapshotContext, ['tokenEstimate']);
  const contextWindow = numericAt(snapshotContext, ['contextWindow']);
  if (tokenEstimate !== null && tokenEstimate >= 0 && contextWindow !== null && contextWindow > 0) {
    return {
      percentage: Math.min(tokenEstimate / contextWindow, 1),
      detail: 'snapshot.context.tokenEstimate/contextWindow',
    };
  }
  return null;
}

function statuslineHomeRoot() {
  const hiveFlowHome = process.env.HIVE_FLOW_HOME;
  if (hiveFlowHome && path.isAbsolute(hiveFlowHome)) return path.join(hiveFlowHome, '.hive-flow', 'statusline');
  const home = process.env.HOME || process.env.USERPROFILE;
  if (!home || !path.isAbsolute(home)) return '';
  return path.join(home, '.hive-flow', 'statusline');
}

function isFreshStatuslineRecord(record, nowMs = Date.now()) {
  const renderedAt = Date.parse(String(record?.renderedAt || ''));
  if (!Number.isFinite(renderedAt)) return false;
  return nowMs - renderedAt >= 0 && nowMs - renderedAt <= STATUSLINE_MAX_AGE_MS;
}

function collectStatuslineRecordPaths(projectRoot) {
  const root = statuslineHomeRoot();
  if (!root) return [];
  const paths = [];

  const current = readJsonFileIfPresent(path.join(root, 'current.json'), MAX_STATUSLINE_RECORD_BYTES);
  if (
    current?.projectRoot === projectRoot
    && typeof current.lastRender === 'string'
    && isStatuslineRecordPath(root, current.lastRender)
  ) {
    paths.push(current.lastRender);
  }

  const projectsDir = path.join(root, 'projects');
  try {
    const entries = fs.readdirSync(projectsDir, { withFileTypes: true });
    const recordPaths = [];
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      if (!/^[0-9a-f]{16}$/.test(entry.name)) continue;
      const recordPath = path.join(projectsDir, entry.name, 'last-render.json');
      try {
        const stat = fs.lstatSync(recordPath);
        if (!stat.isFile() || stat.isSymbolicLink() || stat.size > MAX_STATUSLINE_RECORD_BYTES) continue;
        recordPaths.push({ path: recordPath, mtimeMs: stat.mtimeMs });
      } catch {
        // Ignore stale project directories without a readable last-render record.
      }
    }
    recordPaths.sort((a, b) => b.mtimeMs - a.mtimeMs);
    for (const record of recordPaths.slice(0, MAX_STATUSLINE_PROJECT_RECORDS)) {
      paths.push(record.path);
    }
  } catch {
    // No global statusline cache is normal in test/headless contexts.
  }

  return [...new Set(paths)];
}

function isStatuslineRecordPath(root, candidate) {
  try {
    const relative = path.relative(path.resolve(root), path.resolve(candidate));
    return /^[0-9a-f]{16}[/\\]last-render[.]json$/.test(
      relative.replace(/^projects[/\\]/, ''),
    ) && !relative.startsWith('..') && !path.isAbsolute(relative);
  } catch {
    return false;
  }
}

function measuredStatuslineContextPercentage(projectRoot) {
  const candidates = [];
  for (const recordPath of collectStatuslineRecordPaths(projectRoot)) {
    const record = readJsonFileIfPresent(recordPath, MAX_STATUSLINE_RECORD_BYTES);
    if (!record || record.projectRoot !== projectRoot || !isFreshStatuslineRecord(record)) continue;
    const context = statuslineRecordContextPercentage(record);
    if (!context) continue;
    candidates.push({
      percentage: context.percentage,
      statePath: recordPath,
      detail: context.detail,
      renderedAt: record.renderedAt,
    });
  }
  candidates.sort((a, b) => String(b.renderedAt).localeCompare(String(a.renderedAt)));
  return candidates[0] || null;
}

function measuredContextPercentage(projectRoot, sessionId) {
  const statuslineMeasurement = measuredStatuslineContextPercentage(projectRoot);
  if (statuslineMeasurement) return statuslineMeasurement;

  const statePath = path.join(projectRoot, '.hive-flow', 'data', 'autopilot-state.json');
  const state = readJsonFileIfPresent(statePath);
  if (!state || typeof state !== 'object') return null;

  const stateSession = sanitizeLine(state.sessionId || '', 200);
  if (stateSession && sessionId && stateSession !== sessionId) return null;

  const tokens = Number(state.lastTokenEstimate);
  const contextWindow = Number(state.contextWindow);
  let pct = null;
  if (Number.isFinite(tokens) && tokens >= 0 && Number.isFinite(contextWindow) && contextWindow > 0) {
    pct = Math.min(tokens / contextWindow, 1);
  }
  if (pct === null) pct = normalizePercentage(state.lastPercentage);
  if (pct === null) pct = latestHistoryPercentage(state);

  return pct === null ? null : { percentage: pct, statePath, detail: 'autopilot-state' };
}

function assertContextFloorAllowsCompaction(projectRoot, sessionId) {
  const measurement = measuredContextPercentage(projectRoot, sessionId);
  if (!measurement) {
    throw new Error(
      `Refusing compaction request: unable to measure current context usage, so the 50% compaction request floor cannot be verified. ` +
      `Continue without compacting until statusline or autopilot context measurement is available. ` +
      `Request human intervention: the context measurement layer must be repaired before compaction can be safely requested.\n\n` +
      `${CORRECT_SELF_COMPACT_COMMAND}`,
    );
  }
  if (measurement.percentage < COMPACT_CONTEXT_FLOOR_PCT) {
    const pct = (measurement.percentage * 100).toFixed(1);
    throw new Error(
      `Refusing compaction request: measured context is ${pct}%, below the 50% compaction request floor. ` +
      `Compaction advice starts at 70%; continue without compacting until context reaches the floor. ` +
      `Source: ${measurement.statePath}${measurement.detail ? ` (${measurement.detail})` : ''}`,
    );
  }
  return measurement;
}

function buildClaudeCompactArgs(prompt, resume) {
  const args = ['--output-format', 'stream-json', '--verbose', '-p', `/compact ${prompt}`];
  if (resume) args.push('--resume', resume);
  return args;
}

function findCompactBoundary(output) {
  for (const line of String(output || '').split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const parsed = JSON.parse(trimmed);
      if (parsed.type === 'system' && parsed.subtype === 'compact_boundary') {
        return parsed;
      }
    } catch {
      // Claude stream-json can include non-JSON diagnostics from wrappers; ignore.
    }
  }
  return null;
}

function launchHeadlessCompact(request) {
  const claudeBin = process.env.CLAUDE_BIN || 'claude';
  const args = buildClaudeCompactArgs(request.preservationPrompt, request.resume);
  const result = spawnSync(claudeBin, args, {
    cwd: request.projectRoot,
    env: process.env,
    encoding: 'utf8',
    maxBuffer: 10 * 1024 * 1024,
  });

  if (result.error) throw result.error;
  if (typeof result.status === 'number' && result.status !== 0) {
    const detail = (result.stderr || result.stdout || '').trim().slice(0, 1000);
    throw new Error(`Headless Claude compact exited with status ${result.status}${detail ? `: ${detail}` : ''}\n\n${CORRECT_SELF_COMPACT_COMMAND}`);
  }

  const compactBoundary = findCompactBoundary(result.stdout);
  if (!compactBoundary) {
    throw new Error(`Headless Claude compact completed without a compact_boundary event. The active context was not proven compacted.\n\n${CORRECT_SELF_COMPACT_COMMAND}`);
  }

  return { launched: true, mode: 'sync', compacted: true, compactBoundary };
}

function readTextFileIfPresent(filePath) {
  try {
    if (!fs.existsSync(filePath)) return '';
    return fs.readFileSync(filePath, 'utf8').trim();
  } catch {
    return '';
  }
}

function currentTmuxPane() {
  const fromEnv = sanitizeLine(process.env.TMUX_PANE || '', 80);
  if (fromEnv) return fromEnv;
  const result = spawnSync('tmux', ['display-message', '-p', '#{pane_id}'], {
    encoding: 'utf8',
    maxBuffer: 1024 * 1024,
  });
  if (result.error || result.status !== 0) return '';
  return sanitizeLine(result.stdout, 80);
}

function resolveInplaceCompactTarget(request) {
  if (!process.env.TMUX && !process.env.TMUX_PANE) {
    throw new Error(`In-place compaction requires a tmux session.\n\n${CORRECT_SELF_COMPACT_COMMAND}`);
  }

  const currentPane = currentTmuxPane();
  if (!currentPane) {
    throw new Error(`Could not identify current tmux pane for in-place compaction.\n\n${CORRECT_SELF_COMPACT_COMMAND}`);
  }

  const recordedPane = readTextFileIfPresent(path.join(request.projectRoot, '.hive-flow', 'data', 'tmux-pane.txt'));
  const allowExternal = process.env.HIVE_FLOW_ALLOW_TMUX_COMPACT === '1';
  if (recordedPane && recordedPane !== currentPane && !allowExternal) {
    throw new Error(
      `Refusing to inject /compact into pane ${recordedPane} from ${currentPane}; run compact-now from Claude's own pane.\n\n${CORRECT_SELF_COMPACT_COMMAND}`,
    );
  }

  return recordedPane || currentPane;
}

function runTmux(args) {
  const result = spawnSync('tmux', args, {
    encoding: 'utf8',
    maxBuffer: 1024 * 1024,
  });
  if (result.error) throw result.error;
  if (typeof result.status === 'number' && result.status !== 0) {
    const detail = (result.stderr || result.stdout || '').trim().slice(0, 1000);
    throw new Error(`tmux ${args.join(' ')} exited with status ${result.status}${detail ? `: ${detail}` : ''}`);
  }
}

function launchInplaceCompact(request, pane) {
  const prompt = `/compact ${request.preservationPrompt}`;
  runTmux(['send-keys', '-t', pane, '-l', prompt]);
  runTmux(['send-keys', '-t', pane, 'Enter']);
  return { launched: true, mode: 'inplace', pane };
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    process.stdout.write('Usage: compact-now.cjs --reason "..." [--mode inplace|headless] [--resume SESSION_ID] [--goal "..."] [--next-step "..."]\n');
    return 0;
  }

  const projectRoot = resolveProjectRoot();
  const dataDir = path.join(projectRoot, '.hive-flow', 'data');
  const handoffPath = path.join(dataDir, 'compaction-handoff.md');
  const requestPath = path.join(dataDir, 'compact-request.json');
  fs.mkdirSync(dataDir, { recursive: true });
  const contextMeasurement = assertContextFloorAllowsCompaction(projectRoot, args.resume);

  const handoffWrittenAt = new Date().toISOString();
  const request = {
    version: 1,
    type: 'hive-flow.compact-request',
    requestedBy: 'compact-now.cjs',
    handoffWrittenAt,
    requestedAt: handoffWrittenAt,
    reason: args.reason,
    mode: args.mode,
    resume: args.resume,
    goal: args.goal,
    nextStep: args.nextStep,
    projectRoot,
    handoffPath,
    staleAfterMs: 300000,
    contextMeasurement: contextMeasurement ? {
      percentage: typeof contextMeasurement.percentage === 'number' ? contextMeasurement.percentage : null,
      percent: typeof contextMeasurement.percentage === 'number'
        ? Number((contextMeasurement.percentage * 100).toFixed(1))
        : null,
      source: contextMeasurement.statePath,
      detail: contextMeasurement.detail || '',
      floorPercent: Number((COMPACT_CONTEXT_FLOOR_PCT * 100).toFixed(0)),
      adviceStartsPercent: 70,
    } : null,
    preservationPrompt: '',
  };
  request.preservationPrompt = buildPreservationPrompt(request);

  const inplacePane = request.mode === 'inplace' ? resolveInplaceCompactTarget(request) : '';

  // Recovery note FIRST. The request is written only after the durable handoff.
  appendRecoveryNote(handoffPath, request);
  request.requestedAt = new Date().toISOString();
  writeJsonAtomic(requestPath, request);

  const headless = request.mode === 'headless'
    ? launchHeadlessCompact(request)
    : launchInplaceCompact(request, inplacePane);

  process.stdout.write(JSON.stringify({
    ok: true,
    requestPath,
    handoffPath,
    mode: request.mode,
    reason: request.reason,
    headless,
  }, null, 2) + '\n');
  return 0;
}

try {
  process.exitCode = main();
} catch (err) {
  process.stderr.write(`[compact-now] ${err && err.message ? err.message : String(err)}\n`);
  process.exitCode = 1;
}
