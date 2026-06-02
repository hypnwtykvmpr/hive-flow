import { describe, it, expect, vi } from 'vitest';

const randomBytesMock = vi.fn();

vi.mock('crypto', async () => {
  const actual = await vi.importActual<typeof import('crypto')>('crypto');
  return {
    ...actual,
    randomBytes: randomBytesMock,
  };
});

describe('TokenGenerator verification-code sampling', () => {
  it('should reject random bytes that would introduce modulo bias', async () => {
    randomBytesMock
      .mockReturnValueOnce(Buffer.from([250]))
      .mockReturnValueOnce(Buffer.from([7]));

    const { TokenGenerator } = await import('../src/token-generator.js');
    const generator = new TokenGenerator();

    const code = generator.generateVerificationCode(1);

    expect(code.code).toBe('7');
    expect(randomBytesMock).toHaveBeenCalledTimes(2);
  });
});
