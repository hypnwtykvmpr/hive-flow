#!/usr/bin/env node
/*
 * compact-now.cjs
 *
 * Volitional self-compaction trigger. This helper never decides to compact from
 * context percentage. It writes a recovery handoff first, then arms a one-shot
 * compact request consumed by context-persistence-hook.mjs.
 */

'use strict';

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const VALID_MODES = new Set(['inplace', 'headless']);
const CORRECT_SELF_COMPACT_COMMAND = [
  'Correct self-compaction command:',
  'node .claude/helpers/compact-now.cjs --mode headless --reason "<why compaction is needed>" --resume "$CLAUDE_SESSION_ID" --next-step "<exact next step after compact>"',
  'This writes .hive-flow/data/compaction-handoff.md first, then invokes Claude Code as: claude --output-format stream-json --verbose -p "/compact <preservation prompt>" --resume "$CLAUDE_SESSION_ID".',
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
    preservationPrompt: '',
  };
  request.preservationPrompt = buildPreservationPrompt(request);

  // Recovery note FIRST. The request is written only after the durable handoff.
  appendRecoveryNote(handoffPath, request);
  request.requestedAt = new Date().toISOString();
  writeJsonAtomic(requestPath, request);

  const headless = request.mode === 'headless'
    ? launchHeadlessCompact(request)
    : { launched: false, mode: 'inplace' };

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
