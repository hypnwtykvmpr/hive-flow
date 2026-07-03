// cli/src/commands/__tests__/statusline-command.test.ts
//
// Phase 13 command-surface tests for `hive-flow statusline`. Wrapper-host
// lifecycle tests live in statusline-wrapper-host.test.ts; this file covers
// operator-facing repair/compact maintenance subcommands.

import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import statuslineCommand from '../statusline.js';
import type { Command, CommandContext } from '../../types.js';
import { CLI } from '../../index.js';
import { statuslinePaths } from '../../statusline/paths.js';

function makeCtx(cwd: string, flags: Record<string, string | number | boolean>): CommandContext {
  return {
    cwd,
    args: [],
    flags: { _: [], ...flags },
    interactive: false,
  };
}

function getSub(name: 'repair' | 'compact'): Command {
  const sub = statuslineCommand.subcommands?.find((c) => c.name === name);
  if (!sub) throw new Error(`subcommand not found: ${name}`);
  return sub;
}

function writeJsonl(filePath: string, rows: readonly unknown[]): void {
  mkdirSync(dirname(filePath), { recursive: true });
  writeFileSync(filePath, rows.map((row) => JSON.stringify(row)).join('\n') + '\n', 'utf8');
}

function sampleTestEvent(eventId: string, repoRoot = '/tmp/project') {
  return {
    version: 1,
    eventId,
    ts: '2026-05-29T00:00:00.000Z',
    repoRoot,
    projectKey: 'abc123',
    runner: 'vitest',
    kind: 'suite',
    passed: 1,
    failed: 0,
    skipped: 0,
    total: 1,
    producerKind: 'manual',
    producerId: 'test',
  };
}

describe('hive-flow statusline repair/compact commands', () => {
  let projectRoot: string;

  beforeEach(() => {
    projectRoot = mkdtempSync(join(tmpdir(), 'hf-statusline-cmd-'));
    vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    rmSync(projectRoot, { recursive: true, force: true });
  });

  it('registers repair and compact alongside the hidden wrapper-host subcommand', () => {
    const names = statuslineCommand.subcommands?.map((s) => s.name).sort();
    expect(names).toEqual(['compact', 'repair', 'wrapper-host']);
    expect(getSub('repair').hidden).toBeFalsy();
    expect(getSub('compact').hidden).toBeFalsy();
  });

  it('repairs a single target and materializes current.json', async () => {
    const paths = statuslinePaths(projectRoot);
    writeJsonl(paths.testsLedger, [sampleTestEvent('suite-1', projectRoot)]);

    const result = await getSub('repair').action!(
      makeCtx(projectRoot, { target: 'tests', json: true }),
    );

    expect(result).toMatchObject({ success: true });
    expect(result?.data).toMatchObject({ target: 'tests', read: 1, corrupt: 0, wroteCurrent: true });
    expect(JSON.parse(readFileSync(paths.testsCurrent, 'utf8'))).toMatchObject({
      suite: { eventId: 'suite-1', total: 1 },
    });
  });

  it('repairs all targets in deterministic declaration order', async () => {
    const result = await getSub('repair').action!(
      makeCtx(projectRoot, { all: true, json: true }),
    );

    expect(result).toMatchObject({ success: true });
    expect(result?.data).toMatchObject({
      results: [
        { target: 'sessions' },
        { target: 'scoreboard' },
        { target: 'tests' },
        { target: 'attention' },
      ],
    });
  });

  it('compacts a canonical ledger target', async () => {
    const paths = statuslinePaths(projectRoot);
    writeJsonl(paths.testsLedger, [
      sampleTestEvent('suite-1', projectRoot),
      sampleTestEvent('suite-2', projectRoot),
      sampleTestEvent('suite-3', projectRoot),
    ]);

    const result = await getSub('compact').action!(
      makeCtx(projectRoot, { target: 'tests', keep: 2, json: true }),
    );

    expect(result).toMatchObject({ success: true });
    expect(result?.data).toMatchObject({ target: 'tests', before: 3, after: 2, skipped: 0, wroteCurrent: true });
    const lines = readFileSync(paths.testsLedger, 'utf8').trim().split('\n');
    expect(lines).toHaveLength(2);
    expect(lines[0]).toContain('suite-2');
    expect(lines[1]).toContain('suite-3');
  });

  it('compacts all canonical ledgers and accepts --ledger as a target alias', async () => {
    const single = await getSub('compact').action!(
      makeCtx(projectRoot, { ledger: 'scoreboard-calls', keep: 5, json: true }),
    );
    expect(single).toMatchObject({ success: true });
    expect(single?.data).toMatchObject({ target: 'scoreboard-calls' });

    const all = await getSub('compact').action!(
      makeCtx(projectRoot, { all: true, keep: 5, json: true }),
    );
    expect(all).toMatchObject({ success: true });
    expect(all?.data).toMatchObject({
      results: [
        { target: 'tests' },
        { target: 'sessions' },
        { target: 'scoreboard-calls' },
        { target: 'scoreboard-presence' },
        { target: 'attention' },
      ],
    });
  });

  it('compact --all reports per-target errors without hiding partial failure', async () => {
    const paths = statuslinePaths(projectRoot);
    const outside = join(projectRoot, 'outside-tests.jsonl');
    writeFileSync(outside, '{"eventId":"outside"}\n', 'utf8');
    mkdirSync(dirname(paths.testsLedger), { recursive: true });
    symlinkSync(outside, paths.testsLedger);
    writeJsonl(paths.sessionsLedger, [
      { eventId: 'session-1' },
      { eventId: 'session-2' },
    ]);

    const result = await getSub('compact').action!(
      makeCtx(projectRoot, { all: true, keep: 1, json: true }),
    );

    expect(result).toMatchObject({ success: false, exitCode: 1 });
    expect(result?.data).toMatchObject({ ok: false, errors: 1 });
    const results = (result?.data as { results?: Array<{ target: string; error?: true }> }).results ?? [];
    expect(results.find((row) => row.target === 'tests')).toMatchObject({ error: true });
    expect(results.find((row) => row.target === 'sessions')).toMatchObject({ target: 'sessions' });
  });

  it('surfaces argv errors as exit code 2 before touching storage', async () => {
    const noTarget = await getSub('repair').action!(makeCtx(projectRoot, { json: true }));
    expect(noTarget).toMatchObject({ success: false, exitCode: 2 });

    const noKeep = await getSub('compact').action!(
      makeCtx(projectRoot, { target: 'tests', json: true }),
    );
    expect(noKeep).toMatchObject({ success: false, exitCode: 2 });
  });

  it('routes invalid target values through action-level argv errors with exit code 2', async () => {
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(((code?: string | number | null) => {
      throw new Error(`process.exit:${String(code)}`);
    }) as never);
    const cli = new CLI({ interactive: false });

    await expect(
      cli.run([
        'statusline',
        'repair',
        '--target',
        'bogus',
        '--json',
        '--no-update',
      ]),
    ).rejects.toThrow('process.exit:2');

    await expect(
      cli.run([
        'statusline',
        'compact',
        '--target',
        'bogus',
        '--keep',
        '5',
        '--json',
        '--no-update',
      ]),
    ).rejects.toThrow('process.exit:2');

    await expect(
      cli.run([
        'statusline',
        'compact',
        '--ledger',
        'bogus',
        '--keep',
        '5',
        '--json',
        '--no-update',
      ]),
    ).rejects.toThrow('process.exit:2');

    expect(exitSpy).toHaveBeenCalledTimes(3);
    expect(exitSpy).toHaveBeenNthCalledWith(1, 2);
    expect(exitSpy).toHaveBeenNthCalledWith(2, 2);
    expect(exitSpy).toHaveBeenNthCalledWith(3, 2);
  });
});
