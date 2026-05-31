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

function projectDir() {
  return process.env.CLAUDE_PROJECT_DIR || process.cwd();
}

try {
  const file = path.join(projectDir(), '.hive-flow', 'data', 'pending-notifications.jsonl');
  if (!fs.existsSync(file)) {
    process.stdout.write('{}');
    process.exit(0);
  }
  const raw = fs.readFileSync(file, 'utf8');
  const lines = raw.split('\n').map((l) => l.trim()).filter(Boolean);
  if (lines.length === 0) {
    process.stdout.write('{}');
    process.exit(0);
  }

  const summaries = [];
  for (const line of lines) {
    try {
      const obj = JSON.parse(line);
      if (obj && obj.summary) summaries.push(`- ${obj.summary}`);
    } catch {
      /* skip corrupt line */
    }
  }

  // Truncate so these surface exactly once (atomic-ish: write empty via tmp+rename).
  try {
    const tmp = file + '.tmp';
    fs.writeFileSync(tmp, '');
    fs.renameSync(tmp, file);
  } catch {
    /* fail-open: if we can't truncate, better to risk a repeat than to drop */
  }

  if (summaries.length === 0) {
    process.stdout.write('{}');
    process.exit(0);
  }

  const context = `Hive Flow — background agent task(s) completed since your last message:\n${summaries.join('\n')}`;
  process.stdout.write(
    JSON.stringify({
      hookSpecificOutput: {
        hookEventName: 'UserPromptSubmit',
        additionalContext: context,
      },
    }),
  );
} catch {
  try { process.stdout.write('{}'); } catch { /* noop */ }
}
