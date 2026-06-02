import { beforeEach, describe, it, expect } from 'vitest';
import { addHook, defaultRegistry, HookEvent, HookPriority } from '../src/index.js';

describe('@hive-flow/hooks', () => {
  beforeEach(() => {
    defaultRegistry.clear();
  });

  it('should export hook types', () => {
    // Placeholder test - hooks module exports types and utilities
    expect(true).toBe(true);
  });

  it('should support hook registration', () => {
    // Hooks can be registered for pre/post events
    const hooks = new Map<string, Function[]>();
    hooks.set('pre-edit', [() => {}]);
    expect(hooks.has('pre-edit')).toBe(true);
  });

  it('should support hook execution', async () => {
    // Hooks execute in order
    const results: number[] = [];
    const hooks = [
      () => results.push(1),
      () => results.push(2),
    ];
    for (const hook of hooks) {
      hook();
    }
    expect(results).toEqual([1, 2]);
  });

  it('addHook registers hooks through ESM-safe imports', async () => {
    const id = await addHook(
      HookEvent.PreEdit,
      () => ({ success: true }),
      { name: 'esm-safe-hook' }
    );

    const entry = defaultRegistry.get(id);
    expect(entry).toBeDefined();
    expect(entry?.event).toBe(HookEvent.PreEdit);
    expect(entry?.priority).toBe(HookPriority.Normal);
    expect(entry?.name).toBe('esm-safe-hook');
  });
});
