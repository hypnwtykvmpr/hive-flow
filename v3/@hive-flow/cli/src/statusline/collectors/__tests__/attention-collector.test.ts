// v3/@hive-flow/cli/src/statusline/collectors/__tests__/attention-collector.test.ts
//
// Phase 8 attention collector regression tests. These tests are intentionally
// independent of the recorder: every fixture is a canned JSONL ledger written
// directly to `.hive-flow/attention.jsonl`. That keeps the collector contract
// pinned even when the recorder's redaction / sanitization logic evolves.
//
// Coverage:
//   - Empty ledger / missing ledger -> empty summary
//   - Single emit -> 1 unresolved row
//   - emit + resolve -> removed by eventId/id
//   - resolve-without-emit -> no-op (no throw)
//   - N+1 events -> only top N kept; the dropped tail is the lowest-priority
//     / oldest items
//   - Severity ordering (critical -> warn -> info)
//   - Recency tiebreak within the same severity

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { collectAttention, DEFAULT_MAX_ATTENTION_ITEMS } from '../attention.js';
import type {
  AttentionEventV1,
  AttentionItem,
  AttentionLedgerEntry,
  AttentionResolvedV1,
  AttentionSeverity,
} from '../../types.js';

function makeItem(overrides: Partial<AttentionItem> & { id: string; ts: string; severity: AttentionSeverity }): AttentionItem {
  return {
    id: overrides.id,
    ts: overrides.ts,
    severity: overrides.severity,
    source: overrides.source ?? 'test',
    message: overrides.message ?? `message for ${overrides.id}`,
    action: overrides.action,
    redacted: overrides.redacted ?? false,
  };
}

function emitEvent(item: AttentionItem): AttentionEventV1 {
  return {
    eventId: `attention-emit-${item.id}`,
    ts: item.ts,
    event: 'emit',
    item,
  };
}

function resolveEvent(id: string, ts: string, reason = 'done'): AttentionResolvedV1 {
  return {
    eventId: `attention-resolve-${id}`,
    ts,
    event: 'resolve',
    id,
    reason,
    redacted: false,
  };
}

function writeLedger(projectRoot: string, events: AttentionLedgerEntry[]): void {
  const dir = join(projectRoot, '.hive-flow');
  mkdirSync(dir, { recursive: true });
  const body = events.map((event) => JSON.stringify(event)).join('\n') + (events.length ? '\n' : '');
  writeFileSync(join(dir, 'attention.jsonl'), body, { encoding: 'utf8', mode: 0o600 });
}

describe('collectAttention', () => {
  let root: string;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'hf-attn-collector-'));
  });
  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it('returns an empty summary when the ledger does not exist', async () => {
    const summary = await collectAttention({ projectRoot: root });
    expect(summary.unresolved).toEqual([]);
  });

  it('returns an empty summary when the ledger is empty', async () => {
    writeLedger(root, []);
    const summary = await collectAttention({ projectRoot: root });
    expect(summary.unresolved).toEqual([]);
  });

  it('produces one row for a single emit event', async () => {
    const item = makeItem({ id: 'attn-1', ts: '2026-01-01T00:00:00.000Z', severity: 'warn' });
    writeLedger(root, [emitEvent(item)]);
    const summary = await collectAttention({ projectRoot: root });
    expect(summary.unresolved).toHaveLength(1);
    const row = summary.unresolved[0]!;
    expect(row.id).toBe('attn-1');
    expect(row.severity).toBe('warn');
    expect(row.message).toBe('message for attn-1');
    expect(row.redacted).toBe(false);
    expect(row.ageSeconds).toBeGreaterThanOrEqual(0);
  });

  it('removes an emitted item when a resolve event follows', async () => {
    const item = makeItem({ id: 'attn-resolved', ts: '2026-01-01T00:00:00.000Z', severity: 'critical' });
    writeLedger(root, [
      emitEvent(item),
      resolveEvent(item.id, '2026-01-01T00:01:00.000Z'),
    ]);
    const summary = await collectAttention({ projectRoot: root });
    expect(summary.unresolved).toEqual([]);
  });

  it('treats a resolve without a prior emit as a no-op', async () => {
    writeLedger(root, [resolveEvent('attn-missing', '2026-01-01T00:00:00.000Z')]);
    await expect(collectAttention({ projectRoot: root })).resolves.toEqual({ unresolved: [] });
  });

  it('orders items by severity (critical before warn before info)', async () => {
    const ts = '2026-01-01T00:00:00.000Z';
    writeLedger(root, [
      emitEvent(makeItem({ id: 'attn-info', ts, severity: 'info' })),
      emitEvent(makeItem({ id: 'attn-warn', ts, severity: 'warn' })),
      emitEvent(makeItem({ id: 'attn-critical', ts, severity: 'critical' })),
    ]);
    const summary = await collectAttention({ projectRoot: root });
    expect(summary.unresolved.map((row) => row.severity)).toEqual(['critical', 'warn', 'info']);
  });

  it('uses recency as the tiebreaker within a single severity (newer first)', async () => {
    writeLedger(root, [
      emitEvent(makeItem({ id: 'attn-old', ts: '2026-01-01T00:00:00.000Z', severity: 'warn' })),
      emitEvent(makeItem({ id: 'attn-new', ts: '2026-01-02T00:00:00.000Z', severity: 'warn' })),
      emitEvent(makeItem({ id: 'attn-middle', ts: '2026-01-01T12:00:00.000Z', severity: 'warn' })),
    ]);
    const summary = await collectAttention({ projectRoot: root });
    expect(summary.unresolved.map((row) => row.id)).toEqual([
      'attn-new',
      'attn-middle',
      'attn-old',
    ]);
  });

  it('caps to maxAttentionItems and drops the lowest-priority / oldest tail', async () => {
    const cap = 3;
    const events: AttentionLedgerEntry[] = [
      // 2 critical (both kept)
      emitEvent(makeItem({ id: 'attn-c-new', ts: '2026-01-02T00:00:00.000Z', severity: 'critical' })),
      emitEvent(makeItem({ id: 'attn-c-old', ts: '2026-01-01T00:00:00.000Z', severity: 'critical' })),
      // 2 warn (newer kept, older dropped)
      emitEvent(makeItem({ id: 'attn-w-new', ts: '2026-01-02T00:00:00.000Z', severity: 'warn' })),
      emitEvent(makeItem({ id: 'attn-w-old', ts: '2026-01-01T00:00:00.000Z', severity: 'warn' })),
      // 1 info (dropped)
      emitEvent(makeItem({ id: 'attn-i', ts: '2026-01-01T00:00:00.000Z', severity: 'info' })),
    ];
    writeLedger(root, events);
    const summary = await collectAttention({ projectRoot: root, maxAttentionItems: cap });
    expect(summary.unresolved).toHaveLength(cap);
    expect(summary.unresolved.map((row) => row.id)).toEqual([
      'attn-c-new',
      'attn-c-old',
      'attn-w-new',
    ]);
  });

  it('falls back to the default cap when maxAttentionItems is invalid', async () => {
    expect(DEFAULT_MAX_ATTENTION_ITEMS).toBe(10);
    // Emit 12 critical items; even with a tampered cap (0, NaN) the default
    // ceiling must hold so a misconfigured caller cannot silently widen the
    // summary or shrink it to nothing.
    const events: AttentionLedgerEntry[] = [];
    for (let i = 0; i < 12; i++) {
      const ts = new Date(Date.UTC(2026, 0, 1, 0, 0, i)).toISOString();
      events.push(emitEvent(makeItem({ id: `attn-${String(i).padStart(2, '0')}`, ts, severity: 'critical' })));
    }
    writeLedger(root, events);
    const zeroCap = await collectAttention({ projectRoot: root, maxAttentionItems: 0 });
    expect(zeroCap.unresolved).toHaveLength(DEFAULT_MAX_ATTENTION_ITEMS);
    const nanCap = await collectAttention({ projectRoot: root, maxAttentionItems: Number.NaN });
    expect(nanCap.unresolved).toHaveLength(DEFAULT_MAX_ATTENTION_ITEMS);
    const negativeCap = await collectAttention({ projectRoot: root, maxAttentionItems: -5 });
    expect(negativeCap.unresolved).toHaveLength(DEFAULT_MAX_ATTENTION_ITEMS);
  });

  it('ignores malformed emit rows without throwing', async () => {
    const good = makeItem({ id: 'attn-good', ts: '2026-01-01T00:00:00.000Z', severity: 'warn' });
    // Hand-written ledger with a malformed emit (missing required fields) and
    // a well-formed emit. The collector must keep the good row and drop the
    // malformed one rather than crashing the renderer.
    const dir = join(root, '.hive-flow');
    mkdirSync(dir, { recursive: true });
    const lines = [
      JSON.stringify({ eventId: 'attention-emit-bad', ts: '2026-01-01T00:00:00.000Z', event: 'emit', item: { id: 'attn-bad' } }),
      JSON.stringify(emitEvent(good)),
    ];
    writeFileSync(join(dir, 'attention.jsonl'), lines.join('\n') + '\n', { encoding: 'utf8', mode: 0o600 });
    const summary = await collectAttention({ projectRoot: root });
    expect(summary.unresolved.map((row) => row.id)).toEqual(['attn-good']);
  });

  it('computes ageSeconds as a non-negative integer', async () => {
    const ts = new Date(Date.now() - 5_000).toISOString();
    writeLedger(root, [emitEvent(makeItem({ id: 'attn-recent', ts, severity: 'warn' }))]);
    const summary = await collectAttention({ projectRoot: root });
    expect(summary.unresolved).toHaveLength(1);
    const row = summary.unresolved[0]!;
    expect(row.ageSeconds).toBeGreaterThanOrEqual(0);
    expect(Number.isInteger(row.ageSeconds)).toBe(true);
  });
});
