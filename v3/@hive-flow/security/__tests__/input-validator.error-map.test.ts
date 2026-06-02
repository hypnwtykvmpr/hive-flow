import { describe, it, expect } from 'vitest';
import { z } from 'zod';

describe('InputValidator error map scoping', () => {
  it('should not mutate Zod default errors outside security schemas', async () => {
    const before = z.string().min(2).safeParse('').error?.issues[0]?.message;

    await import('../src/input-validator.js');

    const after = z.string().min(2).safeParse('').error?.issues[0]?.message;

    expect(after).toBe(before);
    expect(after).not.toBe('Input below minimum required size');
  });
});
