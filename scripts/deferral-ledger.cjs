#!/usr/bin/env node
/**
 * Deferral Ledger — Knots-backed deferral recording and completion discipline.
 *
 * The durable store IS Knots (kno). This script is thin glue that enforces the
 * mandatory deferral record shape and keeps deferred work discoverable across
 * compaction/session boundaries. Knot: hive-flow-5e15.
 *
 * Subcommands:
 *   record --title T --owner O --reason R --unblock U --priority 0-4 --source S [--review REV]
 *       Create a knot, transition it to the native `deferred` state, and attach
 *       a structured DEFERRAL RECORD note. Refuses (exit 1) when any required
 *       field is missing — a deferral without owner/reason/unblock/priority/
 *       source is not a record, it is prose.
 *   digest [--json]
 *       List every open deferral (state=deferred plus `deferral`-tagged open
 *       knots). Silent when the ledger is empty. Fail-open (exit 0 with a
 *       warning) when the kno binary is unavailable — used at SessionStart.
 *   check-note <file>
 *       Scan a router note for deferral language on lines that cite no
 *       hive-flow-xxxx knot id. Warning-only in this slice (always exit 0).
 *   hook-check-note
 *       PostToolUse adapter: reads the hook JSON payload from stdin, self-
 *       filters to markdown writes under .hive-flow/data/tmux-router/, then
 *       runs check-note on the written file.
 */
'use strict';

const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const REPO_ROOT = process.env.CLAUDE_PROJECT_DIR || path.join(__dirname, '..');
const DEFERRAL_TAG = 'deferral';
const REQUIRED_FIELDS = ['title', 'owner', 'reason', 'unblock', 'priority', 'source'];
const DEFAULT_REVIEW = 'next session-start digest';

// ponytail: word-boundary heuristic + same-line knot-id suppression; upgrade to
// sentence-level analysis only if review shows real false-positive pain.
const DEFERRAL_PROSE =
  /\b(defer(?:red|ral|rals|ring|s)?|residuals?|standing-deferred|leftovers?|backlog|when convenient|future slice|later slice|no rush)\b/i;
const KNOT_REF = /\bhive-flow-[0-9a-f]{4}\b/i;

function runKno(args) {
  const res = spawnSync('kno', ['-C', REPO_ROOT, ...args], { encoding: 'utf8' });
  if (res.error && res.error.code === 'ENOENT') {
    return { missing: true, status: 127, stdout: '', stderr: 'kno binary not found on PATH' };
  }
  return {
    missing: false,
    status: res.status === null || res.status === undefined ? 1 : res.status,
    stdout: res.stdout || '',
    stderr: res.stderr || '',
  };
}

function parseFlags(argv) {
  const opts = {};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg.startsWith('--')) {
      const key = arg.slice(2);
      const next = argv[i + 1];
      if (next !== undefined && !next.startsWith('--')) {
        opts[key] = next;
        i += 1;
      } else {
        opts[key] = '';
      }
    }
  }
  return opts;
}

function parseKnotArray(raw) {
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function recordFieldsFromNotes(knot) {
  const fields = { owner: '?', unblock: '?', review: '?' };
  const notes = Array.isArray(knot.notes) ? knot.notes : [];
  for (let i = notes.length - 1; i >= 0; i -= 1) {
    const content = String(notes[i].content || '');
    if (!content.includes('DEFERRAL RECORD')) continue;
    for (const [key, label] of [['owner', 'Owner'], ['unblock', 'Unblock'], ['review', 'Review']]) {
      const match = content.match(new RegExp(`^${label}:\\s*(.+)$`, 'im'));
      if (match) fields[key] = match[1].trim();
    }
    break;
  }
  return fields;
}

function cmdRecord(argv) {
  const opts = parseFlags(argv);
  const missing = REQUIRED_FIELDS.filter((key) => !opts[key] || String(opts[key]).trim() === '');
  if (missing.length) {
    console.error(
      `[deferral-ledger] record refused — missing required field(s): ${missing.map((m) => `--${m}`).join(', ')}. ` +
        'Every deferral needs owner, reason, unblock condition, priority, and source reference.'
    );
    return 1;
  }
  const priority = Number.parseInt(opts.priority, 10);
  if (!Number.isInteger(priority) || priority < 0 || priority > 4 || String(priority) !== String(opts.priority).trim()) {
    console.error('[deferral-ledger] record refused — --priority must be an integer 0-4');
    return 1;
  }
  const review = opts.review && opts.review.trim() !== '' ? opts.review : DEFAULT_REVIEW;

  const created = runKno(['new', opts.title, '--fast', '--tag', DEFERRAL_TAG, '--json']);
  if (created.missing) {
    console.error('[deferral-ledger] record FAILED: kno binary not found on PATH — a deferral cannot be recorded without the ledger.');
    return 1;
  }
  if (created.status !== 0) {
    console.error(`[deferral-ledger] record FAILED: kno new exited ${created.status}: ${created.stderr.trim()}`);
    return 1;
  }
  let knotId = '';
  try {
    knotId = JSON.parse(created.stdout).id || '';
  } catch {
    knotId = '';
  }
  if (!knotId) {
    console.error('[deferral-ledger] record FAILED: could not parse knot id from kno new --json output');
    return 1;
  }

  const note = [
    'DEFERRAL RECORD',
    `Owner: ${opts.owner}`,
    `Reason: ${opts.reason}`,
    `Unblock: ${opts.unblock}`,
    `Priority: ${priority}`,
    `Source: ${opts.source}`,
    `Review: ${review}`,
  ].join('\n');
  const updated = runKno(['update', knotId, '--status', 'deferred', '--priority', String(priority), '--add-note', note]);
  if (updated.status !== 0) {
    console.error(
      `[deferral-ledger] record INCOMPLETE: knot ${knotId} was created but the deferred-state update failed ` +
        `(exit ${updated.status}): ${updated.stderr.trim()}`
    );
    return 1;
  }
  console.log(`[deferral-ledger] recorded ${knotId} (deferred, P${priority}): ${opts.title}`);
  return 0;
}

function collectDeferrals() {
  const deferred = runKno(['ls', '--state', 'deferred', '--json']);
  if (deferred.missing) return { missing: true, knots: [] };
  const seen = new Set();
  const knots = [];
  for (const knot of parseKnotArray(deferred.stdout)) {
    if (knot.id && !seen.has(knot.id)) {
      seen.add(knot.id);
      knots.push(knot);
    }
  }
  const open = runKno(['ls', '--json']);
  for (const knot of parseKnotArray(open.stdout)) {
    if (knot.id && !seen.has(knot.id) && Array.isArray(knot.tags) && knot.tags.includes(DEFERRAL_TAG)) {
      seen.add(knot.id);
      knots.push(knot);
    }
  }
  return { missing: false, knots };
}

function cmdDigest(asJson) {
  const { missing, knots } = collectDeferrals();
  if (missing) {
    console.log('[deferral-ledger] digest skipped: kno binary not found on PATH');
    return 0;
  }
  if (!knots.length) return 0;
  if (asJson) {
    console.log(
      JSON.stringify(
        knots.map((knot) => {
          const fields = recordFieldsFromNotes(knot);
          return {
            id: knot.id,
            title: knot.title,
            state: knot.state,
            priority: knot.priority,
            owner: fields.owner,
            unblock: fields.unblock,
            review: fields.review,
          };
        }),
        null,
        2
      )
    );
    return 0;
  }
  console.log(
    `[deferral-ledger] ${knots.length} open deferral(s) — drive each to completion, explicit cancellation, or replacement:`
  );
  for (const knot of knots) {
    const fields = recordFieldsFromNotes(knot);
    const priority = knot.priority === null || knot.priority === undefined ? '?' : knot.priority;
    console.log(
      `  - ${knot.id} P${priority} [${knot.state}] ${knot.title} | owner=${fields.owner} | unblock=${fields.unblock} | review=${fields.review}`
    );
  }
  return 0;
}

function checkNoteText(text) {
  const offenders = [];
  text.split(/\r?\n/).forEach((line, index) => {
    if (DEFERRAL_PROSE.test(line) && !KNOT_REF.test(line)) {
      offenders.push({ line: index + 1, text: line.trim() });
    }
  });
  return offenders;
}

function cmdCheckNote(file) {
  if (!file) return 0;
  let text = '';
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch {
    return 0; // fail-open: nothing to check
  }
  const offenders = checkNoteText(text);
  if (!offenders.length) return 0;
  console.log(
    `[deferral-ledger] WARNING: ${path.basename(file)} contains deferral language without a knot reference on ` +
      `${offenders.length} line(s). Record every deferral first (node scripts/deferral-ledger.cjs record --title ... ` +
      '--owner ... --reason ... --unblock ... --priority 0-4 --source ...) and cite the hive-flow-xxxx id on the same line.'
  );
  for (const offender of offenders.slice(0, 10)) {
    console.log(`  line ${offender.line}: ${offender.text.slice(0, 160)}`);
  }
  if (offenders.length > 10) {
    console.log(`  ... and ${offenders.length - 10} more line(s)`);
  }
  return 0; // warning-only in this slice (per plan_review constraint)
}

function cmdHookCheckNote() {
  let raw = '';
  try {
    raw = fs.readFileSync(0, 'utf8');
  } catch {
    return 0;
  }
  let payload;
  try {
    payload = JSON.parse(raw);
  } catch {
    return 0;
  }
  const toolInput = payload && typeof payload === 'object' ? payload.tool_input || {} : {};
  const filePath = toolInput.file_path || toolInput.path || '';
  if (!filePath || typeof filePath !== 'string') return 0;
  const resolved = path.resolve(REPO_ROOT, filePath);
  const routerDir = path.join(REPO_ROOT, '.hive-flow', 'data', 'tmux-router') + path.sep;
  if (!resolved.startsWith(routerDir) || !resolved.endsWith('.md')) return 0;
  return cmdCheckNote(resolved);
}

function main() {
  const [cmd, ...rest] = process.argv.slice(2);
  switch (cmd) {
    case 'record':
      return cmdRecord(rest);
    case 'digest':
      return cmdDigest(rest.includes('--json'));
    case 'check-note':
      return cmdCheckNote(rest[0]);
    case 'hook-check-note':
      return cmdHookCheckNote();
    default:
      console.error('usage: deferral-ledger.cjs <record|digest|check-note|hook-check-note> [options]');
      return 1;
  }
}

if (require.main === module) {
  process.exit(main());
}

module.exports = { checkNoteText, parseFlags, recordFieldsFromNotes };
