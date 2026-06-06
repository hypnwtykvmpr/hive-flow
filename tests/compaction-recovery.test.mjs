import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fc from 'fast-check';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdtempSync } from 'node:fs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(__dirname, '..');
const helperPath = join(repoRoot, '.claude', 'helpers', 'compaction-recovery.cjs');

function runHelper(args, projectRoot) {
  return spawnSync(process.execPath, [helperPath, ...args], {
    cwd: projectRoot,
    encoding: 'utf8',
  });
}

describe('compaction recovery helper', () => {
  it('acknowledges a matching post-compact recovery flag and leaves an audit record', () => {
    const projectRoot = mkdtempSync(join(tmpdir(), 'hf-compaction-recovery-'));
    const dataDir = join(projectRoot, '.hive-flow', 'data');
    const flagPath = join(dataDir, 'compaction-recovery-required.json');
    const ackPath = join(dataDir, 'compaction-recovery-ack.json');
    const handoffPath = join(dataDir, 'compaction-handoff.md');
    const statePath = join(dataDir, 'compaction-state.json');

    try {
      mkdirSync(dataDir, { recursive: true });
      writeFileSync(handoffPath, 'handoff details');
      writeFileSync(statePath, JSON.stringify({ compacted: true }));
      writeFileSync(flagPath, JSON.stringify({
        type: 'hive-flow.compaction-recovery-required',
        sessionId: 'session-ack',
        recoveryNonce: 'abc123recovery',
        source: 'compact',
        handoffPath,
        statePath,
        createdAt: new Date().toISOString(),
        requiredActions: ['read-compaction-handoff', 'inspect-live-git-state', 'acknowledge-recovery'],
      }));

      const mismatch = runHelper([
        'ack',
        '--project-root', projectRoot,
        '--session', 'wrong-session',
        '--nonce', 'abc123recovery',
        '--handoff-reviewed',
        '--state-reviewed',
        '--git-status-reviewed',
        '--objective', 'Resume deterministic compaction recovery implementation.',
        '--next-step', 'Run the focused recovery gates and continue the implementation.',
        '--summary', 'Read the durable handoff and checked git status before resuming.',
      ], projectRoot);
      assert.notEqual(mismatch.status, 0);
      assert.equal(existsSync(flagPath), true);

      const missingEvidence = runHelper([
        'ack',
        '--project-root', projectRoot,
        '--session', 'session-ack',
        '--nonce', 'abc123recovery',
        '--summary', 'Read the durable handoff and checked git status before resuming.',
      ], projectRoot);
      assert.notEqual(missingEvidence.status, 0);
      assert.match(missingEvidence.stderr, /To pass the post-compact recovery gate/);
      assert.match(missingEvidence.stderr, /--handoff-reviewed --state-reviewed --git-status-reviewed/);
      assert.equal(existsSync(flagPath), true);

      const wrongNonce = runHelper([
        'ack',
        '--project-root', projectRoot,
        '--session', 'session-ack',
        '--nonce', 'wrong',
        '--handoff-reviewed',
        '--state-reviewed',
        '--git-status-reviewed',
        '--objective', 'Resume deterministic compaction recovery implementation.',
        '--next-step', 'Run the focused recovery gates and continue the implementation.',
        '--summary', 'Read the durable handoff and checked git status before resuming.',
      ], projectRoot);
      assert.notEqual(wrongNonce.status, 0);
      assert.equal(existsSync(flagPath), true);

      const falseMissing = runHelper([
        'ack',
        '--project-root', projectRoot,
        '--session', 'session-ack',
        '--nonce', 'abc123recovery',
        '--handoff-missing',
        '--state-reviewed',
        '--git-status-reviewed',
        '--objective', 'Resume deterministic compaction recovery implementation.',
        '--next-step', 'Run the focused recovery gates and continue the implementation.',
        '--summary', 'Read the durable handoff and checked git status before resuming.',
      ], projectRoot);
      assert.notEqual(falseMissing.status, 0);
      assert.equal(existsSync(flagPath), true);

      const ok = runHelper([
        'ack',
        '--project-root', projectRoot,
        '--session', 'session-ack',
        '--nonce', 'abc123recovery',
        '--handoff-reviewed',
        '--state-reviewed',
        '--git-status-reviewed',
        '--objective', 'Resume deterministic compaction recovery implementation.',
        '--next-step', 'Run the focused recovery gates and continue the implementation.',
        '--summary', 'Read the durable handoff and checked git status before resuming.',
      ], projectRoot);
      assert.equal(ok.status, 0, ok.stderr);
      assert.equal(existsSync(flagPath), false);
      assert.equal(existsSync(ackPath), true);
      const ack = JSON.parse(readFileSync(ackPath, 'utf8'));
      assert.equal(ack.type, 'hive-flow.compaction-recovery-ack');
      assert.equal(ack.sessionId, 'session-ack');
      assert.match(ack.summary, /durable handoff/);
      assert.equal(ack.evidence.nonceVerified, true);
      assert.equal(ack.evidence.handoffReviewed, true);
      assert.equal(ack.evidence.handoffExists, true);
      assert.equal(ack.evidence.stateReviewed, true);
      assert.equal(ack.evidence.stateExists, true);
      assert.equal(ack.evidence.gitStatusReviewed, true);
      assert.match(ack.evidence.objective, /deterministic compaction/);
      assert.match(ack.evidence.nextStep, /focused recovery gates/);
    } finally {
      rmSync(projectRoot, { recursive: true, force: true });
    }
  });

  it('can clear a malformed recovery flag with an explicit recovery summary', () => {
    const projectRoot = mkdtempSync(join(tmpdir(), 'hf-compaction-recovery-malformed-'));
    const dataDir = join(projectRoot, '.hive-flow', 'data');
    const flagPath = join(dataDir, 'compaction-recovery-required.json');
    const ackPath = join(dataDir, 'compaction-recovery-ack.json');

    try {
      mkdirSync(dataDir, { recursive: true });
      writeFileSync(flagPath, '{not-json');

      const ok = runHelper([
        'ack',
        '--project-root', projectRoot,
        '--session', 'any-session',
        '--summary', 'Recovered from a malformed post-compact flag after checking live repository state.',
      ], projectRoot);
      assert.equal(ok.status, 0, ok.stderr);
      assert.equal(existsSync(flagPath), false);
      const ack = JSON.parse(readFileSync(ackPath, 'utf8'));
      assert.equal(ack.invalidFlagCleared, true);
    } finally {
      rmSync(projectRoot, { recursive: true, force: true });
    }
  });

  it('accepts missing durable recovery files and null fields only when absence is verified', () => {
    const projectRoot = mkdtempSync(join(tmpdir(), 'hf-compaction-recovery-empty-'));
    const dataDir = join(projectRoot, '.hive-flow', 'data');
    const flagPath = join(dataDir, 'compaction-recovery-required.json');
    const ackPath = join(dataDir, 'compaction-recovery-ack.json');
    const handoffPath = join(dataDir, 'compaction-handoff.md');
    const statePath = join(dataDir, 'compaction-state.json');

    try {
      mkdirSync(dataDir, { recursive: true });
      writeFileSync(flagPath, JSON.stringify({
        type: 'hive-flow.compaction-recovery-required',
        sessionId: 'empty-session',
        recoveryNonce: 'empty-nonce',
        source: 'compact',
        handoffPath,
        statePath,
        createdAt: new Date().toISOString(),
        requiredActions: ['read-compaction-handoff', 'inspect-live-git-state', 'acknowledge-recovery'],
      }));

      const status = runHelper(['status', '--project-root', projectRoot], projectRoot);
      assert.equal(status.status, 0, status.stderr);
      const statusJson = JSON.parse(status.stdout);
      assert.equal(statusJson.required, true);
      assert.match(statusJson.guidance, /--handoff-missing --state-missing/);
      assert.match(statusJson.guidance, /--objective "null" --next-step "null"/);

      const ok = runHelper([
        'ack',
        '--project-root', projectRoot,
        '--session', 'empty-session',
        '--nonce', 'empty-nonce',
        '--handoff-missing',
        '--state-missing',
        '--git-status-reviewed',
        '--objective', 'null',
        '--next-step', 'null',
        '--summary', 'No durable handoff existed; checked live repository state and found no recovered task context.',
      ], projectRoot);
      assert.equal(ok.status, 0, ok.stderr);
      assert.equal(existsSync(flagPath), false);
      const ack = JSON.parse(readFileSync(ackPath, 'utf8'));
      assert.equal(ack.evidence.handoffMissing, true);
      assert.equal(ack.evidence.stateMissing, true);
      assert.equal(ack.evidence.objective, null);
      assert.equal(ack.evidence.nextStep, null);
    } finally {
      rmSync(projectRoot, { recursive: true, force: true });
    }
  });

  it('property: recovery guidance and ack follow actual filesystem truth, not stale flag snapshots', () => {
    fc.assert(
      fc.property(
        fc.boolean(),
        fc.boolean(),
        fc.boolean(),
        fc.boolean(),
        (handoffExists, stateExists, staleHandoffSnapshot, staleStateSnapshot) => {
          const projectRoot = mkdtempSync(join(tmpdir(), 'hf-compaction-recovery-prop-'));
          const dataDir = join(projectRoot, '.hive-flow', 'data');
          const flagPath = join(dataDir, 'compaction-recovery-required.json');
          const ackPath = join(dataDir, 'compaction-recovery-ack.json');
          const handoffPath = join(dataDir, 'compaction-handoff.md');
          const statePath = join(dataDir, 'compaction-state.json');

          try {
            mkdirSync(dataDir, { recursive: true });
            if (handoffExists) writeFileSync(handoffPath, 'handoff details that may predate recovery');
            if (stateExists) writeFileSync(statePath, JSON.stringify({ objective: 'known before recovery' }));
            writeFileSync(flagPath, JSON.stringify({
              type: 'hive-flow.compaction-recovery-required',
              sessionId: 'property-session',
              recoveryNonce: 'property-nonce',
              source: 'compact',
              handoffPath,
              statePath,
              handoffExists: staleHandoffSnapshot,
              stateExists: staleStateSnapshot,
              createdAt: new Date().toISOString(),
              requiredActions: ['read-compaction-handoff', 'inspect-live-git-state', 'acknowledge-recovery'],
            }));

            const expectedHandoffFlag = handoffExists ? '--handoff-reviewed' : '--handoff-missing';
            const expectedStateFlag = stateExists ? '--state-reviewed' : '--state-missing';
            const status = runHelper(['status', '--project-root', projectRoot], projectRoot);
            assert.equal(status.status, 0, status.stderr);
            const statusJson = JSON.parse(status.stdout);
            assert.match(statusJson.guidance, new RegExp(`${expectedHandoffFlag} ${expectedStateFlag}`));

            const objective = !handoffExists && !stateExists ? 'null' : 'Recovered objective from durable or live repo context.';
            const nextStep = !handoffExists && !stateExists ? 'null' : 'Continue with the next verified recovery gate action.';
            const ok = runHelper([
              'ack',
              '--project-root', projectRoot,
              '--session', 'property-session',
              '--nonce', 'property-nonce',
              expectedHandoffFlag,
              expectedStateFlag,
              '--git-status-reviewed',
              '--objective', objective,
              '--next-step', nextStep,
              '--summary', 'Reviewed the available recovery evidence and live repository state before clearing the gate.',
            ], projectRoot);
            assert.equal(ok.status, 0, ok.stderr);

            const ack = JSON.parse(readFileSync(ackPath, 'utf8'));
            assert.equal(ack.evidence.handoffExists, handoffExists);
            assert.equal(ack.evidence.stateExists, stateExists);
            assert.equal(ack.evidence.objective, objective === 'null' ? null : objective);
            assert.equal(ack.evidence.nextStep, nextStep === 'null' ? null : nextStep);
          } finally {
            rmSync(projectRoot, { recursive: true, force: true });
          }
        }
      ),
      { numRuns: 64 }
    );
  });

  it('property: null objective and next-step only clear the gate when durable recovery files are absent', () => {
    fc.assert(
      fc.property(fc.boolean(), fc.boolean(), (handoffExists, stateExists) => {
        const projectRoot = mkdtempSync(join(tmpdir(), 'hf-compaction-recovery-null-'));
        const dataDir = join(projectRoot, '.hive-flow', 'data');
        const flagPath = join(dataDir, 'compaction-recovery-required.json');
        const handoffPath = join(dataDir, 'compaction-handoff.md');
        const statePath = join(dataDir, 'compaction-state.json');

        try {
          mkdirSync(dataDir, { recursive: true });
          if (handoffExists) writeFileSync(handoffPath, 'handoff exists but advocate cannot summarize it');
          if (stateExists) writeFileSync(statePath, JSON.stringify({ nextStep: 'exists but not summarized' }));
          writeFileSync(flagPath, JSON.stringify({
            type: 'hive-flow.compaction-recovery-required',
            sessionId: 'null-session',
            recoveryNonce: 'null-nonce',
            source: 'compact',
            handoffPath,
            statePath,
            createdAt: new Date().toISOString(),
          }));

          const result = runHelper([
            'ack',
            '--project-root', projectRoot,
            '--session', 'null-session',
            '--nonce', 'null-nonce',
            handoffExists ? '--handoff-reviewed' : '--handoff-missing',
            stateExists ? '--state-reviewed' : '--state-missing',
            '--git-status-reviewed',
            '--objective', 'null',
            '--next-step', 'null',
            '--summary', 'Could not determine recovered task context after checking available state.',
          ], projectRoot);

          if (!handoffExists && !stateExists) {
            assert.equal(result.status, 0, result.stderr);
            assert.equal(existsSync(flagPath), false);
          } else {
            assert.notEqual(result.status, 0);
            assert.equal(existsSync(flagPath), true);
            assert.match(result.stderr, /include verified handoff\/state reviewed-or-missing evidence/);
          }
        } finally {
          rmSync(projectRoot, { recursive: true, force: true });
        }
      }),
      { numRuns: 64 }
    );
  });

  it('property: malformed recovery flags always redirect to the malformed-state escape hatch', () => {
    const malformedJson = fc
      .string({ minLength: 1, maxLength: 80 })
      .filter((value) => {
        try {
          JSON.parse(value);
          return false;
        } catch {
          return true;
        }
      });

    fc.assert(
      fc.property(malformedJson, (payload) => {
        const projectRoot = mkdtempSync(join(tmpdir(), 'hf-compaction-recovery-malformed-prop-'));
        const dataDir = join(projectRoot, '.hive-flow', 'data');
        const flagPath = join(dataDir, 'compaction-recovery-required.json');

        try {
          mkdirSync(dataDir, { recursive: true });
          writeFileSync(flagPath, payload);

          const status = runHelper(['status', '--project-root', projectRoot], projectRoot);
          assert.equal(status.status, 0, status.stderr);
          const statusJson = JSON.parse(status.stdout);
          assert.equal(statusJson.invalid, true);
          assert.match(statusJson.guidance, /Recovery flag is malformed/);

          const short = runHelper([
            'ack',
            '--project-root', projectRoot,
            '--session', 'malformed-session',
            '--summary', 'too short',
          ], projectRoot);
          assert.notEqual(short.status, 0);
          assert.match(short.stderr, /Recovery flag is malformed/);

          const ok = runHelper([
            'ack',
            '--project-root', projectRoot,
            '--session', 'malformed-session',
            '--summary', 'Malformed recovery flag cleared after checking live repository state and exact next step.',
          ], projectRoot);
          assert.equal(ok.status, 0, ok.stderr);
          assert.equal(existsSync(flagPath), false);
        } finally {
          rmSync(projectRoot, { recursive: true, force: true });
        }
      }),
      { numRuns: 64 }
    );
  });
});
