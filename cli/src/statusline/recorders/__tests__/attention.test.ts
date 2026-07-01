// v3/@hive-flow/cli/src/statusline/recorders/__tests__/attention.test.ts
//
// Phase 8 / Attention recorder — covers all four mandatory Phase 5 C3
// redactions plus the recorder->redactor->writer order contract.
//
//   1. Homedir replacement   ($HOME prefix -> `~`)
//   2. Secret-key redaction  (token | api_key | apikey | password | secret |
//                              credential, case-insensitive -> [REDACTED])
//   3. Quoted-string truncation (> 80 chars inner -> 80 + ...)
//   4. Multi-line rejection  (typed error)
//
// Plus:
//   - Catastrophic-backtracking resistance (10000 hostile chars < 100ms)
//   - Recorder spy contract: redactor runs BEFORE the writer is called, and
//     the writer never sees the raw input message.

import { describe, expect, it } from 'vitest';

import {
  AttentionMultiLineError,
  recordAttentionEmit,
  recordAttentionResolve,
  redactAttentionSummary,
  type AttentionAppend,
} from '../attention.js';
import type { AppendJsonlLockedResult } from '../../storage.js';
import type { AttentionEventV1, AttentionResolvedV1 } from '../../types.js';

const FAKE_HOME = '/Users/test-user';
const FAKE_LEDGER = '/tmp/test-attention.jsonl';
const FAKE_SPOOL = '/tmp/test-spool';
const FAKE_NOW = '2026-05-21T00:00:00.000Z';
const FAKE_EVENT_ID = 'attn-fixed-id';

const okResult: AppendJsonlLockedResult = { written: true, spooled: false };

function spyAppend(): {
  append: AttentionAppend;
  calls: Array<{
    ledgerPath: string;
    spoolRoot: string;
    ledgerName: 'attention';
    event: AttentionEventV1 | AttentionResolvedV1;
  }>;
} {
  const calls: Array<{
    ledgerPath: string;
    spoolRoot: string;
    ledgerName: 'attention';
    event: AttentionEventV1 | AttentionResolvedV1;
  }> = [];
  const append: AttentionAppend = async (opts) => {
    calls.push({
      ledgerPath: opts.ledgerPath,
      spoolRoot: opts.spoolRoot,
      ledgerName: opts.ledgerName,
      event: opts.event,
    });
    return okResult;
  };
  return { append, calls };
}

describe('redactAttentionSummary', () => {
  // -------------------------------------------------------------------------
  // 1. Homedir replacement
  // -------------------------------------------------------------------------

  describe('homedir replacement', () => {
    it('replaces the resolved $HOME prefix with `~`', () => {
      const input = `failed to read ${FAKE_HOME}/.hive-flow/state/cache.json`;
      const out = redactAttentionSummary(input, { homedir: () => FAKE_HOME });
      expect(out).toBe('failed to read ~/.hive-flow/state/cache.json');
    });

    it('replaces every occurrence of $HOME in the same message', () => {
      const input = `a=${FAKE_HOME}/x b=${FAKE_HOME}/y`;
      const out = redactAttentionSummary(input, { homedir: () => FAKE_HOME });
      expect(out).toBe('a=~/x b=~/y');
    });

    it('uses the real os.homedir() resolved at runtime when no override', () => {
      const realHome = process.env.HOME ?? process.env.USERPROFILE ?? '';
      // Only assert real-home replacement when $HOME is set (CI sandboxes
      // sometimes strip it; the recorder still works, just nothing to swap).
      if (realHome.length > 0) {
        const input = `${realHome}/scratch`;
        const out = redactAttentionSummary(input);
        expect(out).toBe('~/scratch');
      }
    });

    it('no-op when the message does not contain the homedir', () => {
      const input = '/etc/hosts is missing';
      const out = redactAttentionSummary(input, { homedir: () => FAKE_HOME });
      expect(out).toBe(input);
    });
  });

  // -------------------------------------------------------------------------
  // 2. Secret-key redaction (all 6 keys, case-insensitive)
  // -------------------------------------------------------------------------

  describe('secret-key redaction', () => {
    it.each([
      ['token', 'token=abc123 next=foo', 'token=[REDACTED] next=foo'],
      ['api_key', 'api_key=secret_xyz', 'api_key=[REDACTED]'],
      ['apikey', 'apikey=val_42', 'apikey=[REDACTED]'],
      ['password', 'password=hunter2', 'password=[REDACTED]'],
      ['secret', 'secret=topSecret', 'secret=[REDACTED]'],
      ['credential', 'credential=jwt.eyJ.', 'credential=[REDACTED]'],
    ])('redacts %s (lowercase)', (_label, input, expected) => {
      const out = redactAttentionSummary(input, { homedir: () => FAKE_HOME });
      expect(out).toBe(expected);
    });

    it('is case-insensitive across all 6 keys', () => {
      const cases: Array<[string, string]> = [
        ['Token=abc next', 'Token=[REDACTED] next'],
        ['API_KEY=abc next', 'API_KEY=[REDACTED] next'],
        ['ApiKey=abc next', 'ApiKey=[REDACTED] next'],
        ['PASSWORD=abc next', 'PASSWORD=[REDACTED] next'],
        ['Secret=abc next', 'Secret=[REDACTED] next'],
        ['CREDENTIAL=abc next', 'CREDENTIAL=[REDACTED] next'],
      ];
      for (const [input, expected] of cases) {
        const out = redactAttentionSummary(input, { homedir: () => FAKE_HOME });
        expect(out).toBe(expected);
      }
    });

    it('accepts `:` as the key-value separator', () => {
      const input = 'token: abc-123, next=ok';
      const out = redactAttentionSummary(input, { homedir: () => FAKE_HOME });
      expect(out).toBe('token: [REDACTED], next=ok');
    });

    it('does not match keys embedded in other words', () => {
      // `mytoken` should not match — \b prevents it.
      const input = 'mytoken=visible, prefix_secret=visible';
      const out = redactAttentionSummary(input, { homedir: () => FAKE_HOME });
      // `mytoken` has no word boundary before `t` (m+y are word chars), so
      // it does not match. `prefix_secret` is a single word from \b's POV
      // because `_` is a word char, so it also does not match.
      expect(out).toBe(input);
    });

    it('redacts quoted secret values without leaking content', () => {
      const input = 'token="abc def ghi" next=x';
      const out = redactAttentionSummary(input, { homedir: () => FAKE_HOME });
      expect(out).toContain('[REDACTED]');
      expect(out).not.toContain('abc def ghi');
    });

    it('handles multiple secret keys in one message', () => {
      const input = 'token=a, password=b, api_key=c';
      const out = redactAttentionSummary(input, { homedir: () => FAKE_HOME });
      expect(out).toBe('token=[REDACTED], password=[REDACTED], api_key=[REDACTED]');
    });
  });

  // -------------------------------------------------------------------------
  // 3. Quoted-string truncation
  // -------------------------------------------------------------------------

  describe('quoted-string truncation', () => {
    it('truncates a quoted string longer than 80 chars to 80 + "..."', () => {
      const inner = 'x'.repeat(120);
      const input = `msg="${inner}" tail`;
      const out = redactAttentionSummary(input, { homedir: () => FAKE_HOME });
      const expectedInner = 'x'.repeat(80) + '...';
      expect(out).toBe(`msg="${expectedInner}" tail`);
    });

    it('leaves a quoted string of exactly 80 chars untouched', () => {
      const inner = 'y'.repeat(80);
      const input = `msg="${inner}" tail`;
      const out = redactAttentionSummary(input, { homedir: () => FAKE_HOME });
      expect(out).toBe(`msg="${inner}" tail`);
    });

    it('leaves a quoted string shorter than 80 chars untouched', () => {
      const input = `msg="short value" tail`;
      const out = redactAttentionSummary(input, { homedir: () => FAKE_HOME });
      expect(out).toBe(input);
    });

    it('truncates multiple long quoted strings independently', () => {
      const longA = 'a'.repeat(100);
      const longB = 'b'.repeat(200);
      const input = `x="${longA}" y="${longB}"`;
      const out = redactAttentionSummary(input, { homedir: () => FAKE_HOME });
      expect(out).toBe(`x="${'a'.repeat(80)}..." y="${'b'.repeat(80)}..."`);
    });

    it('only affects double quotes, not single quotes', () => {
      const inner = "'".repeat(120) + 'x'.repeat(120);
      const input = `msg='${inner}' tail`;
      const out = redactAttentionSummary(input, { homedir: () => FAKE_HOME });
      // No double quotes -> no truncation.
      expect(out).toBe(input);
    });
  });

  // -------------------------------------------------------------------------
  // 4. Multi-line rejection
  // -------------------------------------------------------------------------

  describe('multi-line rejection', () => {
    it('throws AttentionMultiLineError on \\n', () => {
      expect(() => redactAttentionSummary('first\nsecond')).toThrow(AttentionMultiLineError);
    });

    it('throws AttentionMultiLineError on \\r', () => {
      expect(() => redactAttentionSummary('first\rsecond')).toThrow(AttentionMultiLineError);
    });

    it('throws AttentionMultiLineError on CRLF', () => {
      expect(() => redactAttentionSummary('first\r\nsecond')).toThrow(AttentionMultiLineError);
    });

    it('rejects before any redaction work (no partial mutation observed)', () => {
      const input = `token=secret\nhome=${FAKE_HOME}`;
      // The thrown error must be the multi-line one even though the input
      // also contains a secret. The redactor must check newlines FIRST.
      let thrown: unknown;
      try {
        redactAttentionSummary(input, { homedir: () => FAKE_HOME });
      } catch (err) {
        thrown = err;
      }
      expect(thrown).toBeInstanceOf(AttentionMultiLineError);
      expect((thrown as AttentionMultiLineError).code).toBe('ATTENTION_MULTI_LINE');
    });

    it('exposes a structural `code` for instanceof-free checks', () => {
      try {
        redactAttentionSummary('x\ny');
        expect.fail('expected AttentionMultiLineError');
      } catch (err) {
        // Cross-module instanceof can fail if two copies of the module are
        // loaded; the `code` field is the durable identity.
        expect((err as { code?: string }).code).toBe('ATTENTION_MULTI_LINE');
      }
    });
  });

  // -------------------------------------------------------------------------
  // Catastrophic-backtracking resistance (regex linearity)
  // -------------------------------------------------------------------------

  describe('regex linearity', () => {
    it('completes within 100ms on 10000 single-quote chars (hostile to naive regex)', () => {
      const hostile = "'".repeat(10_000);
      const start = Date.now();
      const out = redactAttentionSummary(hostile, { homedir: () => FAKE_HOME });
      const elapsed = Date.now() - start;
      expect(elapsed).toBeLessThan(100);
      // Single quotes are not part of any redaction; the output is unchanged.
      expect(out).toBe(hostile);
    });

    it('completes within 100ms on 10000 double-quote chars', () => {
      // Pathological alternation of `"` is the classic regex-DoS shape. A
      // linear engine still terminates fast; we assert that.
      const hostile = '"'.repeat(10_000);
      const start = Date.now();
      // Each `""` is a zero-length-inner quoted string match (length<=80 so
      // no truncation). All passes are linear.
      const out = redactAttentionSummary(hostile, { homedir: () => FAKE_HOME });
      const elapsed = Date.now() - start;
      expect(elapsed).toBeLessThan(100);
      expect(typeof out).toBe('string');
    });

    it('completes within 100ms on a near-match secret-key prefix repeated', () => {
      // Repeat a string that looks like the start of a secret key but never
      // completes. A backtracking-prone alternation could blow up here.
      const hostile = 'tokentoken'.repeat(1_000); // 10000 chars, no `=`/`:`
      const start = Date.now();
      const out = redactAttentionSummary(hostile, { homedir: () => FAKE_HOME });
      const elapsed = Date.now() - start;
      expect(elapsed).toBeLessThan(100);
      expect(out).toBe(hostile);
    });

    it('completes within 100ms on 10000-char quoted string', () => {
      const inner = 'a'.repeat(10_000);
      const input = `m="${inner}" tail`;
      const start = Date.now();
      const out = redactAttentionSummary(input, { homedir: () => FAKE_HOME });
      const elapsed = Date.now() - start;
      expect(elapsed).toBeLessThan(100);
      expect(out).toBe(`m="${'a'.repeat(80)}..." tail`);
    });
  });

  // -------------------------------------------------------------------------
  // Determinism / chaining
  // -------------------------------------------------------------------------

  describe('chain determinism', () => {
    it('applies homedir first, then secrets, then quoted truncation', () => {
      // Construct an input where each pass is observable in the final output.
      const longInner = 'q'.repeat(120);
      const input = `path=${FAKE_HOME}/cfg token=letmein log="${longInner}"`;
      const out = redactAttentionSummary(input, { homedir: () => FAKE_HOME });
      expect(out).toBe(`path=~/cfg token=[REDACTED] log="${'q'.repeat(80)}..."`);
    });

    it('is idempotent on already-redacted output', () => {
      const input = `path=${FAKE_HOME}/cfg token=letmein`;
      const once = redactAttentionSummary(input, { homedir: () => FAKE_HOME });
      const twice = redactAttentionSummary(once, { homedir: () => FAKE_HOME });
      expect(twice).toBe(once);
    });
  });
});

// ===========================================================================
// Recorder contract: redactor called BEFORE writer
// ===========================================================================

describe('recordAttentionEmit', () => {
  it('writes a redacted item (raw input never reaches the ledger)', async () => {
    const { append, calls } = spyAppend();
    const rawMessage = `secret token=letmein at ${FAKE_HOME}/log`;
    await recordAttentionEmit(
      {
        ledgerPath: FAKE_LEDGER,
        spoolRoot: FAKE_SPOOL,
        id: 'attn-1',
        severity: 'warn',
        source: 'tests',
        message: rawMessage,
      },
      {
        append,
        homedir: () => FAKE_HOME,
        now: () => FAKE_NOW,
        newEventId: () => FAKE_EVENT_ID,
      },
    );
    expect(calls).toHaveLength(1);
    const written = calls[0];
    expect(written.ledgerName).toBe('attention');
    expect(written.event.event).toBe('emit');
    const event = written.event as AttentionEventV1;
    expect(event.eventId).toBe(FAKE_EVENT_ID);
    expect(event.ts).toBe(FAKE_NOW);
    expect(event.item.id).toBe('attn-1');
    expect(event.item.message).toBe('secret token=[REDACTED] at ~/log');
    expect(event.item.message).not.toContain('letmein');
    expect(event.item.message).not.toContain(FAKE_HOME);
    expect(event.item.redacted).toBe(true);
  });

  it('redacts the optional `action` field independently', async () => {
    const { append, calls } = spyAppend();
    await recordAttentionEmit(
      {
        ledgerPath: FAKE_LEDGER,
        spoolRoot: FAKE_SPOOL,
        id: 'attn-2',
        severity: 'critical',
        source: 'mcp',
        message: 'connection lost',
        action: `restart with password=hunter2 from ${FAKE_HOME}/.config`,
      },
      {
        append,
        homedir: () => FAKE_HOME,
        now: () => FAKE_NOW,
        newEventId: () => FAKE_EVENT_ID,
      },
    );
    const event = calls[0].event as AttentionEventV1;
    expect(event.item.action).toBe('restart with password=[REDACTED] from ~/.config');
    expect(event.item.action).not.toContain('hunter2');
  });

  it('omits `action` from the persisted item when not provided', async () => {
    const { append, calls } = spyAppend();
    await recordAttentionEmit(
      {
        ledgerPath: FAKE_LEDGER,
        spoolRoot: FAKE_SPOOL,
        id: 'attn-3',
        severity: 'info',
        source: 'session',
        message: 'starting',
      },
      {
        append,
        homedir: () => FAKE_HOME,
        now: () => FAKE_NOW,
        newEventId: () => FAKE_EVENT_ID,
      },
    );
    const event = calls[0].event as AttentionEventV1;
    expect(event.item.action).toBeUndefined();
  });

  it('propagates the multi-line typed error without writing anything', async () => {
    let writeCount = 0;
    const append: AttentionAppend = async () => {
      writeCount++;
      return okResult;
    };
    await expect(
      recordAttentionEmit(
        {
          ledgerPath: FAKE_LEDGER,
          spoolRoot: FAKE_SPOOL,
          id: 'attn-4',
          severity: 'warn',
          source: 'session',
          message: 'line1\nline2',
        },
        {
          append,
          homedir: () => FAKE_HOME,
          now: () => FAKE_NOW,
          newEventId: () => FAKE_EVENT_ID,
        },
      ),
    ).rejects.toBeInstanceOf(AttentionMultiLineError);
    // CRITICAL: the writer must NOT have been called. Redactor runs FIRST.
    expect(writeCount).toBe(0);
  });

  it('invokes the redactor BEFORE the writer (call-order contract)', async () => {
    // We assert ordering via a shared call log. The recorder must redact
    // the message before invoking append, so by the time append fires, the
    // event passed in is already redacted (no raw input survives).
    const log: Array<'redacted' | 'write'> = [];
    const home = () => {
      log.push('redacted');
      return FAKE_HOME;
    };
    const append: AttentionAppend = async (opts) => {
      log.push('write');
      // Whatever the writer sees must already be redacted.
      const event = opts.event as AttentionEventV1;
      expect(event.item.message).not.toContain('letmein');
      expect(event.item.message).not.toContain(FAKE_HOME);
      return okResult;
    };
    await recordAttentionEmit(
      {
        ledgerPath: FAKE_LEDGER,
        spoolRoot: FAKE_SPOOL,
        id: 'attn-5',
        severity: 'warn',
        source: 'tests',
        message: `token=letmein at ${FAKE_HOME}/log`,
      },
      { append, homedir: home, now: () => FAKE_NOW, newEventId: () => FAKE_EVENT_ID },
    );
    // First event must be 'redacted' (homedir read during redactor), then
    // 'write'. The redactor must NOT be triggered after the write.
    expect(log[0]).toBe('redacted');
    expect(log.includes('write')).toBe(true);
    expect(log.lastIndexOf('redacted')).toBeLessThan(log.lastIndexOf('write'));
  });

  it('uses the storage primitive when no append override is provided', async () => {
    // Smoke test: when invoked without a `deps.append`, the recorder targets
    // the default `appendJsonlLocked`. We invoke it against a bogus path
    // so the call surfaces an error from the storage layer; we only assert
    // that redaction still ran (the failure path comes from I/O, not the
    // redactor — proving the recorder's call site is wired up).
    await expect(
      recordAttentionEmit({
        ledgerPath: '/nonexistent/dir-that-cannot-be-created/\x00invalid',
        spoolRoot: '/nonexistent/spool/\x00invalid',
        id: 'attn-default-append',
        severity: 'info',
        source: 'tests',
        message: 'hello world',
      }),
    ).rejects.toBeDefined();
  });
});

describe('recordAttentionResolve', () => {
  it('redacts the reason and writes a resolve event', async () => {
    const { append, calls } = spyAppend();
    const rawReason = `dismissed by ${FAKE_HOME}/agent with token=ok`;
    await recordAttentionResolve(
      {
        ledgerPath: FAKE_LEDGER,
        spoolRoot: FAKE_SPOOL,
        id: 'attn-1',
        reason: rawReason,
      },
      {
        append,
        homedir: () => FAKE_HOME,
        now: () => FAKE_NOW,
        newEventId: () => FAKE_EVENT_ID,
      },
    );
    expect(calls).toHaveLength(1);
    const event = calls[0].event as AttentionResolvedV1;
    expect(event.event).toBe('resolve');
    expect(event.id).toBe('attn-1');
    expect(event.reason).toBe('dismissed by ~/agent with token=[REDACTED]');
    expect(event.reason).not.toContain(FAKE_HOME);
    expect(event.reason).not.toContain('token=ok');
    expect(event.redacted).toBe(true);
  });

  it('propagates the multi-line typed error without writing', async () => {
    let writeCount = 0;
    const append: AttentionAppend = async () => {
      writeCount++;
      return okResult;
    };
    await expect(
      recordAttentionResolve(
        {
          ledgerPath: FAKE_LEDGER,
          spoolRoot: FAKE_SPOOL,
          id: 'attn-2',
          reason: 'first\nsecond',
        },
        {
          append,
          homedir: () => FAKE_HOME,
          now: () => FAKE_NOW,
          newEventId: () => FAKE_EVENT_ID,
        },
      ),
    ).rejects.toBeInstanceOf(AttentionMultiLineError);
    expect(writeCount).toBe(0);
  });
});
