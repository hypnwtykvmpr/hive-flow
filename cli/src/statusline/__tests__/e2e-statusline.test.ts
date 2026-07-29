// cli/src/statusline/__tests__/e2e-statusline.test.ts
//
// Phase 13 E2E smoke: real recorders -> refresher/cache -> pure renderer.
// This intentionally asserts structural user-visible behavior instead of
// exact ANSI bytes so palette refactors do not make the test brittle.

import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { renderClaudeCodeStatusline } from '../claude-code-renderer.js';
import { statuslinePaths } from '../paths.js';
import { clearProjectScopeCache, resolveProjectScope, type ProjectScope } from '../project-scope.js';
import { refreshStatuslineSnapshot } from '../refresher.js';
import { recordAttentionEmit } from '../recorders/attention.js';
import { recordProviderCall, recordPresenceEvent } from '../recorders/scoreboard.js';
import { recordSessionEvent } from '../recorders/session.js';
import { recordTestRun } from '../recorders/tests.js';
import type {
  ProviderCallEventV1,
  ScoreboardPresenceEventV1,
  SessionEventV1,
  StatuslineSnapshotV1,
} from '../types.js';

function stripAnsi(value: string): string {
  return value.replace(/\x1b\[[0-9;]*m/g, '');
}

function readIfExists(filePath: string): string | undefined {
  return existsSync(filePath) ? readFileSync(filePath, 'utf8') : undefined;
}

function stdinPayload(projectRoot: string): Record<string, unknown> {
  return {
    workspace: { current_dir: projectRoot, project_dir: projectRoot },
    model: { id: 'claude-opus-4-8[1m]', display_name: 'Opus 4.8' },
    context_window: {
      used_percentage: 42,
      total_input_tokens: 42_000,
      total_output_tokens: 7_000,
      context_window_size: 1_000_000,
    },
  };
}

function sessionEvent(scope: ProjectScope, ts: string): SessionEventV1 {
  return {
    version: 1,
    eventId: 'e2e-session-heartbeat',
    ts,
    repoRoot: scope.projectRoot,
    projectKey: scope.projectKey,
    hostCli: 'claude-code',
    sessionId: 'session-e2e',
    event: 'session-heartbeat',
    sessionIdSource: 'native',
    confidence: 'direct',
    producerKind: 'interactive-host',
    producerId: 'e2e',
  };
}

function presenceEvent(scope: ProjectScope, ts: string): ScoreboardPresenceEventV1 {
  return {
    version: 1,
    eventId: 'e2e-presence-codex',
    ts,
    repoRoot: scope.projectRoot,
    projectKey: scope.projectKey,
    hostCli: 'codex',
    provider: 'codex',
    producerKind: 'mcp-tool',
    producerId: 'e2e',
    presenceKey: 'codex:e2e-agent',
    agentId: 'e2e-agent',
    event: 'agent-spawn',
  };
}

function callEvent(
  scope: ProjectScope,
  ts: string,
  event: ProviderCallEventV1['event'],
): ProviderCallEventV1 {
  return {
    version: 1,
    eventId: 'e2e-call-codex',
    ts,
    repoRoot: scope.projectRoot,
    projectKey: scope.projectKey,
    hostCli: 'codex',
    provider: 'codex',
    producerKind: 'mcp-tool',
    producerId: 'e2e',
    sessionId: 'session-e2e',
    model: 'gpt-5',
    event,
    ...(event === 'call-complete' ? { tokensTotal: 1234, ttfbMs: 120 } : {}),
  };
}

describe('statusline E2E recorder -> refresh -> render', () => {
  let projectRoot: string;
  let origForceColor: string | undefined;
  let origNoColor: string | undefined;

  beforeEach(() => {
    projectRoot = mkdtempSync(join(tmpdir(), 'hf-statusline-e2e-'));
    clearProjectScopeCache();
    origForceColor = process.env.FORCE_COLOR;
    origNoColor = process.env.NO_COLOR;
    process.env.FORCE_COLOR = '3';
    delete process.env.NO_COLOR;
  });

  afterEach(() => {
    clearProjectScopeCache();
    rmSync(projectRoot, { recursive: true, force: true });
    if (origForceColor === undefined) delete process.env.FORCE_COLOR;
    else process.env.FORCE_COLOR = origForceColor;
    if (origNoColor === undefined) delete process.env.NO_COLOR;
    else process.env.NO_COLOR = origNoColor;
  });

  it('renders real recorder data from the refreshed snapshot without mutating ledgers', async () => {
    const scope = resolveProjectScope({ cwd: projectRoot });
    const paths = statuslinePaths(scope.projectRoot);
    const nowMs = Date.now();
    const ts = new Date(nowMs).toISOString();

    await recordSessionEvent(sessionEvent(scope, ts));
    await recordPresenceEvent(presenceEvent(scope, ts));
    await recordProviderCall(callEvent(scope, ts, 'call-start'));
    await recordProviderCall(callEvent(scope, ts, 'call-complete'));
    await recordTestRun({
      projectRoot: scope.projectRoot,
      input: {
        kind: 'suite',
        framework: 'vitest',
        projectKey: scope.projectKey,
        repoRoot: scope.projectRoot,
        producerKind: 'manual',
        producerId: 'e2e',
        passed: 3,
        failed: 0,
        skipped: 0,
        total: 3,
        startedAt: ts,
        finishedAt: ts,
        eventId: 'e2e-suite',
        sourceFingerprint: 'e2e-source',
      },
    });
    await recordAttentionEmit(
      {
        ledgerPath: paths.attentionLedger,
        spoolRoot: paths.spoolRoot,
        id: 'attn-e2e',
        severity: 'warn',
        source: 'e2e',
        message: 'review statusline e2e',
      },
      { now: () => ts, newEventId: () => 'e2e-attention-event' },
    );

    const snapshot = await refreshStatuslineSnapshot({
      projectRoot: scope.projectRoot,
      stdinData: stdinPayload(scope.projectRoot),
      now: nowMs,
      force: true,
    });
    const cached = JSON.parse(readFileSync(paths.cache, 'utf8')) as StatuslineSnapshotV1;
    expect(cached).toMatchObject({
      version: 1,
      projectRoot: scope.projectRoot,
      projectKey: scope.projectKey,
      scoreboard: { callsByProvider: { codex: { calls: 1, tokensTotal: 1234 } } },
      tests: { suite: { eventId: 'e2e-suite', total: 3, failed: 0 } },
      attention: { unresolved: [{ id: 'attn-e2e', message: 'review statusline e2e' }] },
    });
    expect(snapshot.scoreboard?.agentsByProvider.codex?.activeAgents).toBe(1);
    expect(snapshot.sessions?.active).toBe(1);

    const before = {
      sessions: readIfExists(paths.sessionsLedger),
      presence: readIfExists(paths.scoreboardPresenceLedger),
      calls: readIfExists(paths.scoreboardCallsLedger),
      tests: readIfExists(paths.testsLedger),
      attention: readIfExists(paths.attentionLedger),
      cache: readIfExists(paths.cache),
      lastRender: readIfExists(paths.lastRender),
    };

    const rendered = await renderClaudeCodeStatusline(stdinPayload(scope.projectRoot), scope.projectRoot);
    const plain = stripAnsi(rendered);

    expect(plain).toContain(scope.displayName);
    expect(plain).toContain('Opus 4.8');
    // f16a: 42% renders as the inline meter (5 solid + a 3/8 partial), not text.
    expect(plain).toContain('ctx │█████▍');
    expect(plain).not.toContain('📖');
    expect(plain).toMatch(/Codex\s+1/);
    expect(plain).toMatch(/Tests\s+3/);
    expect(plain).toContain('review statusline e2e');
    expect(plain).not.toContain('daemon off');
    expect(plain).not.toContain('Vectors');
    expect(plain).not.toContain('Embeddings');
    expect(rendered).not.toContain('\x1b[1;33m');

    expect(readIfExists(paths.sessionsLedger)).toBe(before.sessions);
    expect(readIfExists(paths.scoreboardPresenceLedger)).toBe(before.presence);
    expect(readIfExists(paths.scoreboardCallsLedger)).toBe(before.calls);
    expect(readIfExists(paths.testsLedger)).toBe(before.tests);
    expect(readIfExists(paths.attentionLedger)).toBe(before.attention);
    expect(readIfExists(paths.cache)).toBe(before.cache);
    expect(readIfExists(paths.lastRender)).toBe(before.lastRender);
  });
});
