#!/usr/bin/env node
//
// Drain Notifications — UserPromptSubmit hook
//
// Guaranteed-delivery fallback for the Sentinel Protocol. Reads pending
// agent/hive completion lines written by agent-task-rewake.cjs to
// `.hive-flow/data/pending-notifications.jsonl` and injects them as
// additionalContext on the human's next prompt, so a completion is NEVER
// silently lost even where async-rewake (exit 2) is not honored.
//
// Each line is JSON: { taskId, ts, summary }. After draining, the file is
// truncated so each completion surfaces exactly once.
//
// Fail-open: any error produces no output (never blocks the prompt).

'use strict';

const fs = require('fs');
const path = require('path');
const { wakeSessionPaths } = require('./wake-paths.cjs');

function projectDir() {
  return process.env.CLAUDE_PROJECT_DIR || process.cwd();
}

function emptyOutput() {
  return {};
}

function pendingFile(projectRoot) {
  return path.join(projectRoot, '.hive-flow', 'data', 'pending-notifications.jsonl');
}

function pendingFiles(projectRoot, sessionInput = null, env = process.env) {
  const files = [];
  const wake = wakeSessionPaths(sessionInput, env);
  if (wake) files.push(wake.pendingFile);
  files.push(pendingFile(projectRoot));
  return files;
}

function collectDrainFiles(file) {
  const dir = path.dirname(file);
  const base = path.basename(file);
  const files = [];

  try {
    if (fs.existsSync(dir)) {
      for (const entry of fs.readdirSync(dir)) {
        if (entry.startsWith(`${base}.draining-`)) {
          files.push(path.join(dir, entry));
        }
      }
    }
  } catch {
    return files;
  }

  try {
    if (fs.existsSync(file)) {
      const draining = `${file}.draining-${process.pid}-${Date.now()}`;
      fs.renameSync(file, draining);
      files.push(draining);
    }
  } catch {
    // If another hook is draining concurrently, let that owner finish.
  }

  return files;
}

function parseSummariesFromLines(lines) {
  const summaries = new Map();
  for (const line of lines) {
    try {
      const obj = JSON.parse(line);
      if (obj && obj.summary) {
        const key = obj.taskId || obj.hiveId || obj.summary;
        const kind = typeof obj.kind === 'string' ? obj.kind : '';
        const existing = summaries.get(key);
        const entry = { kind, summary: `- ${obj.summary}` };
        if (!existing || supersedesCheckDue(existing.kind, kind)) summaries.set(key, entry);
      }
    } catch {
      /* skip corrupt line */
    }
  }
  return [...summaries.values()].map((entry) => entry.summary);
}

function supersedesCheckDue(existingKind, nextKind) {
  return (
    (existingKind === 'hive-check' && nextKind === 'hive') ||
    (existingKind === 'task-check' && nextKind === 'task')
  );
}

function drainNotifications(projectRoot = projectDir(), sessionInput = null) {
  const drainFiles = [];
  for (const file of pendingFiles(projectRoot, sessionInput, process.env)) {
    drainFiles.push(...collectDrainFiles(file));
  }
  if (drainFiles.length === 0) return emptyOutput();

  const lines = [];
  for (const drainFile of drainFiles) {
    try {
      const raw = fs.readFileSync(drainFile, 'utf8');
      lines.push(...raw.split('\n').map((l) => l.trim()).filter(Boolean));
    } catch {
      // Leave unread files in place so a future prompt can retry.
      continue;
    }
  }

  const summaries = parseSummariesFromLines(lines);

  // Remove only after parsing; an interruption before this point leaves a
  // .draining-* file that the next run recovers.
  for (const drainFile of drainFiles) {
    try { fs.unlinkSync(drainFile); } catch { /* retry on a future run */ }
  }

  if (summaries.length === 0) {
    return emptyOutput();
  }

  const context = `Hive Flow — background agent task(s) completed since your last message:\n${summaries.join('\n')}`;
  return {
    hookSpecificOutput: {
      hookEventName: 'UserPromptSubmit',
      additionalContext: context,
    },
  };
}

if (require.main === module) {
  try {
    process.stdout.write(JSON.stringify(drainNotifications()));
  } catch {
    try { process.stdout.write('{}'); } catch { /* noop */ }
  }
}

module.exports = {
  projectDir,
  emptyOutput,
  pendingFile,
  pendingFiles,
  collectDrainFiles,
  parseSummariesFromLines,
  supersedesCheckDue,
  drainNotifications,
};
