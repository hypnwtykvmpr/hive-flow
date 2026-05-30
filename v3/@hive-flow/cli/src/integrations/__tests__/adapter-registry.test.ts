// v3/@hive-flow/cli/src/integrations/__tests__/adapter-registry.test.ts
//
// Wave 11A — Adapter registry foundation tests.
//
// Covers `listAdapterTargets()`, `registerAdapter()`, `loadAdapter()`, and the
// related helpers in `../adapter-registry.ts`. Wave 11B will land the seven
// per-CLI adapters; this suite uses stub loaders so the foundation can be
// verified without the per-CLI files.
//
// Cast convention: a few tests below use `value as unknown as <Type>` to feed
// deliberately-invalid values into the production runtime guards. This is the
// only path TypeScript allows for exercising defence-in-depth — the
// production functions accept the typed union, and the test must defeat the
// compile-time check to reach the runtime guard. The bug-hunt rule
// disallowing typed casts is scoped to production code; the matching tests
// here verify the guards trigger on the same bad inputs.

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { AdapterCtx, ConnectorAdapter, AdapterTarget } from '../adapters/types.js';
import { ADAPTER_TARGETS } from '../adapters/types.js';
import {
  isKnownTarget,
  listAdapterTargets,
  listRegisteredTargets,
  loadAdapter,
  registerAdapter,
  resetAdapterRegistry,
  unregisterAdapter,
} from '../adapter-registry.js';

/**
 * Build a minimal stub adapter for `target`. The stub records invocations on
 * its `calls` array so tests can assert that `loadAdapter()` returns the
 * actual registered instance (rather than a clone or a structurally-equal
 * lookalike).
 */
function stubAdapter(target: AdapterTarget): ConnectorAdapter & { readonly calls: ReadonlyArray<string> } {
  const calls: string[] = [];
  return Object.freeze({
    target,
    tier: 'wrapper-mode' as const,
    calls,
    async install(_ctx: AdapterCtx) {
      calls.push('install');
      return { wrote: [], skipped: [] };
    },
    async uninstall(_ctx: AdapterCtx) {
      calls.push('uninstall');
      return { removed: [] };
    },
  });
}

describe('adapter-registry: listAdapterTargets()', () => {
  it('returns the seven canonical targets in canonical order', () => {
    const targets = listAdapterTargets();
    // The canonical set is fixed at Wave 11A; tests assert both the count and
    // the membership so a future edit to either the union or the frozen array
    // is caught here.
    expect(targets.length).toBe(7);
    expect(targets).toEqual([
      'claude-code',
      'codex',
      'gemini',
      'forgecode',
      'cursor-cli',
      'qwen',
      'opencode',
    ]);
  });

  it('returns the same frozen array as ADAPTER_TARGETS', () => {
    // Defence in depth: `listAdapterTargets()` re-uses the module-level
    // frozen array rather than allocating a fresh one per call.
    expect(listAdapterTargets()).toBe(ADAPTER_TARGETS);
  });

  it('is independent of which adapters are registered', () => {
    // Listing the canonical set must work before Wave 11B ships any per-CLI
    // file. The registry starts empty; listAdapterTargets() must still
    // return all seven.
    resetAdapterRegistry();
    expect(listRegisteredTargets()).toEqual([]);
    expect(listAdapterTargets().length).toBe(7);
  });
});

describe('adapter-registry: isKnownTarget()', () => {
  it('accepts every canonical target', () => {
    for (const target of ADAPTER_TARGETS) {
      expect(isKnownTarget(target)).toBe(true);
    }
  });

  it('rejects unknown / mistyped target strings', () => {
    expect(isKnownTarget('claude-cli')).toBe(false); // non-existent
    expect(isKnownTarget('Claude-Code')).toBe(false); // wrong casing
    expect(isKnownTarget('forge')).toBe(false); // shortened
    expect(isKnownTarget('cursor')).toBe(false); // shortened
    expect(isKnownTarget('')).toBe(false);
  });

  it('rejects non-string values', () => {
    expect(isKnownTarget(null)).toBe(false);
    expect(isKnownTarget(undefined)).toBe(false);
    expect(isKnownTarget(0)).toBe(false);
    expect(isKnownTarget({ target: 'claude-code' })).toBe(false);
  });
});

describe('adapter-registry: registerAdapter() + loadAdapter()', () => {
  beforeEach(() => {
    resetAdapterRegistry();
  });
  afterEach(() => {
    resetAdapterRegistry();
  });

  it('loads an adapter that was previously registered', async () => {
    const adapter = stubAdapter('claude-code');
    registerAdapter('claude-code', () => Promise.resolve(adapter));
    const loaded = await loadAdapter('claude-code');
    expect(loaded).toBe(adapter);
  });

  it('accepts a module-namespace loader with a `default` export', async () => {
    const adapter = stubAdapter('codex');
    registerAdapter('codex', () => Promise.resolve({ default: adapter }));
    const loaded = await loadAdapter('codex');
    expect(loaded).toBe(adapter);
  });

  it('rejects loadAdapter() when no loader is registered', async () => {
    await expect(loadAdapter('claude-code')).rejects.toThrow(/no adapter registered/);
  });

  it('rejects loadAdapter() for an unknown target', async () => {
    // Cast through `unknown` is the only way to test the runtime guard; the
    // foundation is meant to defence-in-depth a dynamic plugin caller that
    // bypasses TypeScript.
    await expect(loadAdapter('not-a-real-target' as unknown as AdapterTarget))
      .rejects.toThrow(/unknown target/);
  });

  it('rejects an adapter whose target does not match the registration key', async () => {
    // A loader returning the wrong-target adapter is a misconfiguration. The
    // registry verifies the structural contract before handing the instance
    // back to the caller.
    const adapter = stubAdapter('codex');
    // We deliberately register `gemini` -> codex-shaped adapter.
    registerAdapter('gemini', () => Promise.resolve(adapter));
    await expect(loadAdapter('gemini')).rejects.toThrow(/target=/);
  });

  it('rejects an adapter that does not match the ConnectorAdapter shape', async () => {
    registerAdapter('qwen', () => Promise.resolve({ not: 'an adapter' } as unknown as ConnectorAdapter));
    await expect(loadAdapter('qwen')).rejects.toThrow(/ConnectorAdapter shape/);
  });

  it('last-write-wins for repeated registrations', async () => {
    const a = stubAdapter('opencode');
    const b = stubAdapter('opencode');
    registerAdapter('opencode', () => Promise.resolve(a));
    registerAdapter('opencode', () => Promise.resolve(b));
    const loaded = await loadAdapter('opencode');
    expect(loaded).toBe(b);
    expect(loaded).not.toBe(a);
  });

  it('throws when the loader is not a function', () => {
    // The TypeScript signature already enforces this, but a dynamic caller
    // (e.g. JSON-driven discovery) could pass a non-callable through.
    expect(() =>
      registerAdapter('forgecode', null as unknown as () => Promise<ConnectorAdapter>),
    ).toThrow(/must be a function/);
  });

  it('throws when registering for an unknown target', () => {
    expect(() =>
      registerAdapter('not-a-target' as unknown as AdapterTarget, () => Promise.resolve(stubAdapter('claude-code'))),
    ).toThrow(/unknown target/);
  });
});

describe('adapter-registry: listRegisteredTargets() + unregisterAdapter()', () => {
  beforeEach(() => {
    resetAdapterRegistry();
  });
  afterEach(() => {
    resetAdapterRegistry();
  });

  it('listRegisteredTargets() reflects current registrations in canonical order', () => {
    expect(listRegisteredTargets()).toEqual([]);
    // Register out of canonical order to verify the listing is sorted by the
    // canonical ordering, not the registration order.
    registerAdapter('cursor-cli', () => Promise.resolve(stubAdapter('cursor-cli')));
    registerAdapter('claude-code', () => Promise.resolve(stubAdapter('claude-code')));
    registerAdapter('gemini', () => Promise.resolve(stubAdapter('gemini')));
    expect(listRegisteredTargets()).toEqual(['claude-code', 'gemini', 'cursor-cli']);
  });

  it('unregisterAdapter() removes a single target without affecting others', () => {
    registerAdapter('claude-code', () => Promise.resolve(stubAdapter('claude-code')));
    registerAdapter('codex', () => Promise.resolve(stubAdapter('codex')));
    expect(unregisterAdapter('claude-code')).toBe(true);
    expect(listRegisteredTargets()).toEqual(['codex']);
  });

  it('unregisterAdapter() returns false for an absent target', () => {
    expect(unregisterAdapter('claude-code')).toBe(false);
  });
});
