#!/usr/bin/env node
/**
 * Post-compaction recovery acknowledgement helper.
 *
 * This helper is intentionally small: SessionStart arms the recovery flag,
 * enforcement denies mutation while it exists, and this command clears it only
 * after the agent supplies a session-matched recovery summary.
 */

const fs = require('fs');
const path = require('path');

function resolveProjectRoot(args) {
  const explicit = readOption(args, '--project-root');
  if (explicit) return path.resolve(explicit);
  return path.resolve(__dirname, '../..');
}

function dataDir(projectRoot) {
  return path.join(projectRoot, '.hive-flow', 'data');
}

function flagPath(projectRoot) {
  return path.join(dataDir(projectRoot), 'compaction-recovery-required.json');
}

function ackPath(projectRoot) {
  return path.join(dataDir(projectRoot), 'compaction-recovery-ack.json');
}

function readOption(args, name) {
  const index = args.indexOf(name);
  if (index < 0) return '';
  return String(args[index + 1] || '');
}

function sanitize(value, max = 2000) {
  return String(value || '')
    .replace(/[\x00-\x1f\x7f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max);
}

function readJson(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return null;
  }
}

function buildRecoveryGuidance(projectRoot, flag, invalidFlag = false) {
  const session = sanitize(flag?.sessionId || process.env.CLAUDE_SESSION_ID || '<session-id>', 120) || '<session-id>';
  const nonce = sanitize(flag?.recoveryNonce || '<nonce-from-recovery-flag>', 120) || '<nonce-from-recovery-flag>';
  const handoffFile = flag?.handoffPath || path.join(dataDir(projectRoot), 'compaction-handoff.md');
  const stateFile = flag?.statePath || path.join(dataDir(projectRoot), 'compaction-state.json');
  const handoffExists = !invalidFlag && fs.existsSync(handoffFile);
  const stateExists = !invalidFlag && fs.existsSync(stateFile);
  const handoffFlag = handoffExists ? '--handoff-reviewed' : '--handoff-missing';
  const stateFlag = stateExists ? '--state-reviewed' : '--state-missing';
  const objective = !handoffExists && !stateExists ? 'null' : '<active objective>';
  const nextStep = !handoffExists && !stateExists ? 'null' : '<exact next step>';

  if (invalidFlag) {
    return [
      'Recovery flag is malformed. Read live repo state, then clear with:',
      `node .claude/helpers/compaction-recovery.cjs ack --session "${session}" --summary "<what you recovered and exact next step>"`,
    ].join('\n');
  }

  return [
    'To pass the post-compact recovery gate:',
    handoffExists ? `1. Read ${handoffFile}.` : `1. ${handoffFile} is absent; use --handoff-missing.`,
    stateExists ? `2. Read ${stateFile}.` : `2. ${stateFile} is absent; use --state-missing.`,
    '3. Run git status --short --branch and inspect relevant git diff.',
    '4. State the recovered objective and next step. If both durable files are absent, use objective null and next-step null.',
    'Then run:',
    `node .claude/helpers/compaction-recovery.cjs ack --session "${session}" --nonce "${nonce}" ${handoffFlag} ${stateFlag} --git-status-reviewed --objective "${objective}" --next-step "${nextStep}" --summary "<what you recovered>"`,
  ].join('\n');
}

function writeJsonAtomic(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const tmpPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmpPath, JSON.stringify(value, null, 2));
  fs.renameSync(tmpPath, filePath);
}

function printUsage(stream = process.stderr) {
  stream.write([
    'Usage:',
    '  node .claude/helpers/compaction-recovery.cjs status [--project-root DIR]',
    '  node .claude/helpers/compaction-recovery.cjs ack --session SESSION_ID --nonce NONCE (--handoff-reviewed|--handoff-missing) (--state-reviewed|--state-missing) --git-status-reviewed --objective "..." --next-step "..." --summary "..." [--project-root DIR]',
    '',
    'Before ack: read .hive-flow/data/compaction-handoff.md, inspect git status --short --branch,',
    'and state the active objective, constraints, changed files, verification state, and next step.',
    '',
  ].join('\n'));
}

function commandStatus(projectRoot) {
  const filePath = flagPath(projectRoot);
  const exists = fs.existsSync(filePath);
  const flag = readJson(filePath);
  process.stdout.write(JSON.stringify({
    required: Boolean(flag) || exists,
    invalid: exists && !flag,
    flag,
    guidance: buildRecoveryGuidance(projectRoot, flag, exists && !flag),
  }, null, 2) + '\n');
  return 0;
}

function commandAck(projectRoot, args) {
  const flagFile = flagPath(projectRoot);
  const flagExists = fs.existsSync(flagFile);
  const flag = readJson(flagFile);
  if (!flagExists) {
    process.stdout.write(JSON.stringify({ ok: true, cleared: false, reason: 'no recovery flag present' }) + '\n');
    return 0;
  }
  const invalidFlag = !flag || flag.type !== 'hive-flow.compaction-recovery-required';

  const sessionId = sanitize(readOption(args, '--session') || process.env.CLAUDE_SESSION_ID || '', 120);
  const nonce = sanitize(readOption(args, '--nonce'), 120);
  const objective = sanitize(readOption(args, '--objective'), 1000);
  const nextStep = sanitize(readOption(args, '--next-step'), 1000);
  const summary = sanitize(readOption(args, '--summary'), 2000);
  const handoffReviewed = args.includes('--handoff-reviewed');
  const handoffMissing = args.includes('--handoff-missing');
  const stateReviewed = args.includes('--state-reviewed');
  const stateMissing = args.includes('--state-missing');
  const gitStatusReviewed = args.includes('--git-status-reviewed');
  if (!invalidFlag && flag.sessionId && sessionId !== flag.sessionId) {
    process.stderr.write(`Compaction recovery ack denied: session mismatch. Expected ${flag.sessionId}; got ${sessionId || '<missing>'}.\n\n${buildRecoveryGuidance(projectRoot, flag)}\n`);
    return 2;
  }
  if (!invalidFlag && flag.recoveryNonce && nonce !== flag.recoveryNonce) {
    process.stderr.write(`Compaction recovery ack denied: recovery nonce mismatch.\n\n${buildRecoveryGuidance(projectRoot, flag)}\n`);
    return 2;
  }
  const handoffFile = !invalidFlag ? flag.handoffPath || path.join(dataDir(projectRoot), 'compaction-handoff.md') : '';
  const stateFile = !invalidFlag ? flag.statePath || path.join(dataDir(projectRoot), 'compaction-state.json') : '';
  const actualHandoffExists = handoffFile ? fs.existsSync(handoffFile) : false;
  const actualStateExists = stateFile ? fs.existsSync(stateFile) : false;
  const handoffEvidenceOk = !invalidFlag && (
    (handoffReviewed && actualHandoffExists) ||
    (handoffMissing && !actualHandoffExists)
  );
  const stateEvidenceOk = !invalidFlag && (
    (stateReviewed && actualStateExists) ||
    (stateMissing && !actualStateExists)
  );
  const allDurableContextMissing = !invalidFlag && !actualHandoffExists && !actualStateExists;
  const objectiveOk = objective.length >= 10 || (allDurableContextMissing && objective.toLowerCase() === 'null');
  const nextStepOk = nextStep.length >= 10 || (allDurableContextMissing && nextStep.toLowerCase() === 'null');

  if (!invalidFlag && (!handoffEvidenceOk || !stateEvidenceOk || !gitStatusReviewed || !objectiveOk || !nextStepOk)) {
    process.stderr.write(`Compaction recovery ack denied: include verified handoff/state reviewed-or-missing evidence, --git-status-reviewed, --objective, and --next-step.\n\n${buildRecoveryGuidance(projectRoot, flag)}\n`);
    return 2;
  }
  if (summary.length < 20) {
    process.stderr.write(`Compaction recovery ack denied: --summary must describe what was recovered and the exact next step.\n\n${buildRecoveryGuidance(projectRoot, flag, invalidFlag)}\n`);
    return 2;
  }

  const ack = {
    type: 'hive-flow.compaction-recovery-ack',
    version: 1,
    sessionId,
    compactBoundaryId: !invalidFlag ? sanitize(flag.compactBoundaryId || flag.compact_boundary_id || '', 200) : '',
    compactBoundaryTimestamp: !invalidFlag ? sanitize(flag.compactBoundaryTimestamp || flag.compact_boundary_timestamp || '', 120) : '',
    compactBoundaryTrigger: !invalidFlag ? sanitize(flag.compactBoundaryTrigger || flag.compact_boundary_trigger || '', 120) : '',
    acknowledgedAt: new Date().toISOString(),
    summary,
    evidence: {
      nonceVerified: !invalidFlag && Boolean(flag.recoveryNonce),
      handoffReviewed,
      handoffMissing,
      handoffExists: actualHandoffExists,
      stateReviewed,
      stateMissing,
      stateExists: actualStateExists,
      gitStatusReviewed,
      objective: objective.toLowerCase() === 'null' ? null : objective,
      nextStep: nextStep.toLowerCase() === 'null' ? null : nextStep,
    },
    invalidFlagCleared: invalidFlag,
    clearedFlagCreatedAt: invalidFlag ? null : flag.createdAt || null,
    requiredActions: !invalidFlag && Array.isArray(flag.requiredActions) ? flag.requiredActions : [],
  };
  writeJsonAtomic(ackPath(projectRoot), ack);
  try {
    fs.unlinkSync(flagFile);
  } catch (err) {
    process.stderr.write(`Compaction recovery ack wrote audit record but could not remove flag: ${err.message}\n`);
    return 3;
  }
  process.stdout.write(JSON.stringify({ ok: true, cleared: true, ackPath: ackPath(projectRoot) }) + '\n');
  return 0;
}

function main(argv = process.argv.slice(2)) {
  const command = argv[0] || 'status';
  const projectRoot = resolveProjectRoot(argv);

  if (command === 'status') return commandStatus(projectRoot);
  if (command === 'ack') return commandAck(projectRoot, argv);
  if (command === '--help' || command === 'help') {
    printUsage(process.stdout);
    return 0;
  }

  printUsage();
  return 2;
}

if (require.main === module) {
  process.exitCode = main();
}

module.exports = {
  main,
  flagPath,
  ackPath,
  buildRecoveryGuidance,
};
