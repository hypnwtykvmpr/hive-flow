// cli/src/progress/__tests__/router-status.test.ts
//
// P5 (Knot hive-flow-29a5): closed router-note Status grammar.
//
// Acceptance coverage:
//   - parseRouterStatus accepts the closed set and FLAGS unknown values
//     (raw preserved, recognized:false) instead of silently coercing.
//   - The progress-authority classifier uses the Status header as the
//     AUTHORITATIVE gate/continuation signal when present; body text-mining
//     applies only to legacy headerless/unknown notes.

import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';

import { ROUTER_STATUSES, isRouterStatus, parseRouterStatus } from '../router-status.js';
import { collectProgressAuthoritySnapshot } from '../progress-authority-classifier.js';

const roots: string[] = [];
afterAll(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

function tempRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'hf-router-status-'));
  roots.push(root);
  return root;
}

function writeNote(root: string, name: string, text: string, mtimeMs: number): void {
  const dir = join(root, '.hive-flow', 'data', 'tmux-router');
  mkdirSync(dir, { recursive: true });
  const path = join(dir, name);
  writeFileSync(path, text, 'utf-8');
  const seconds = mtimeMs / 1000;
  utimesSync(path, seconds, seconds);
}

// ---------------------------------------------------------------------------
// Parser: closed set, unknown flagged
// ---------------------------------------------------------------------------

describe('parseRouterStatus', () => {
  it('accepts every closed-set value', () => {
    for (const status of ROUTER_STATUSES) {
      const parsed = parseRouterStatus(`Status: ${status}\n\n# Note\nbody`);
      expect(parsed).toMatchObject({ status, raw: status, recognized: true });
    }
  });

  it('canonicalizes case on input, preserves raw', () => {
    const parsed = parseRouterStatus('status: verify_clean\n\nbody');
    expect(parsed.status).toBe('VERIFY_CLEAN');
    expect(parsed.raw).toBe('verify_clean');
    expect(parsed.recognized).toBe(true);
  });

  it('flags unknown values with the raw preserved, never coerces', () => {
    const parsed = parseRouterStatus('Status: TOTALLY_NEW_STATE\n\nbody');
    expect(parsed).toEqual({ status: null, raw: 'TOTALLY_NEW_STATE', recognized: false, reason: 'unknown-status' });
  });

  it('reports a missing header distinctly', () => {
    expect(parseRouterStatus('# just a note\nno header here')).toEqual({
      status: null, raw: null, recognized: false, reason: 'missing-header',
    });
  });

  it('treats a Status: line deep in the body as prose, not a header', () => {
    const body = ['# Note', 'line', 'line', 'line', 'line', 'line', 'Status: VERIFY_CLEAN'].join('\n');
    expect(parseRouterStatus(body).reason).toBe('missing-header');
  });

  it('isRouterStatus guards the closed set', () => {
    expect(isRouterStatus('VERIFY_BOUNCE')).toBe(true);
    expect(isRouterStatus('verify_bounce')).toBe(false);
    expect(isRouterStatus('ANYTHING_ELSE')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Classifier wiring: Status is authoritative when present
// ---------------------------------------------------------------------------

describe('classifier uses Status when present', () => {
  const nowMs = Date.parse('2026-07-03T12:00:00.000Z');

  async function routerEvidence(root: string, agent = 'claude') {
    const snapshot = await collectProgressAuthoritySnapshot({ cwd: root, agent, nowMs });
    return snapshot.router;
  }

  it('BLOCKED_TRUE_HUMAN_GATE sets the human gate without any legacy gate phrasing', async () => {
    const root = tempRoot();
    writeNote(root, '20260703T110000Z-codex-x-to-claude.md',
      'Status: BLOCKED_TRUE_HUMAN_GATE\n\nOnly the operator can rotate the key.', nowMs - 60_000);
    const router = await routerEvidence(root);
    expect(router.humanGate).toBe(true);
    expect(router.latestStatus).toBe('BLOCKED_TRUE_HUMAN_GATE');
    expect(router.latestStatusRecognized).toBe(true);
  });

  it('a recognized header SUPPRESSES body mining for that note', async () => {
    const root = tempRoot();
    // Body contains legacy gate phrasing, but the closed-set header says the
    // verification is clean -- the header wins for this note.
    writeNote(root, '20260703T110100Z-codex-x-to-claude.md',
      'Status: VERIFY_CLEAN\n\nEarlier we were waiting for human input; resolved now.', nowMs - 60_000);
    const router = await routerEvidence(root);
    expect(router.humanGate).toBe(false);
  });

  it('ACTIVE_HANDOFF addressed to the agent is concrete action; unaddressed is not', async () => {
    const root = tempRoot();
    writeNote(root, '20260703T110200Z-codex-x-to-claude.md',
      'Status: ACTIVE_HANDOFF\n\nTake the next slice.', nowMs - 60_000);
    const addressed = await routerEvidence(root, 'claude');
    expect(addressed.concreteAction).toBe(true);

    const other = await routerEvidence(root, 'codex');
    expect(other.concreteAction).toBe(false);
  });

  it('COMPLETE_NO_ACTION maps to the human gate like legacy queue-complete mining', async () => {
    const root = tempRoot();
    writeNote(root, '20260703T110300Z-claude-x-to-codex.md',
      'Status: COMPLETE_NO_ACTION\n\nAll assignments are complete.', nowMs - 60_000);
    const router = await routerEvidence(root);
    expect(router.humanGate).toBe(true);
  });

  it('an unknown header is surfaced and the note falls back to legacy body mining', async () => {
    const root = tempRoot();
    writeNote(root, '20260703T110400Z-codex-x-to-claude.md',
      'Status: SOME_LEGACY_MARKER\n\nWaiting for human approval on the push.', nowMs - 60_000);
    const router = await routerEvidence(root);
    // Legacy mining still classifies the body...
    expect(router.humanGate).toBe(true);
    // ...and the unrecognized header is flagged, not hidden.
    expect(router.latestStatus).toBe('SOME_LEGACY_MARKER');
    expect(router.latestStatusRecognized).toBe(false);
  });

  it('headerless notes keep the exact legacy mining behavior', async () => {
    const root = tempRoot();
    writeNote(root, '20260703T110500Z-codex-x-to-claude.md',
      '# Note\nHandoff ready: implement the slice, to-claude.', nowMs - 60_000);
    const router = await routerEvidence(root);
    expect(router.concreteAction).toBe(true);
    expect(router.latestStatus).toBeUndefined();
  });
});
