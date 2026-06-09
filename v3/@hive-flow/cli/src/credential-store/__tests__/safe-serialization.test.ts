import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import {
  redactCredentialMaterial,
  serializeCredentialSafeJson,
} from '../safe-serialization.js';

const planted = {
  apiKey: 'or-test-openrouter-secret',
  config: {
    env: {
      OPENROUTER_API_KEY: 'or-test-openrouter-secret',
      DEEPSEEK_API_KEY: 'sk-deepseek-secret',
    },
  },
  headers: {
    Authorization: 'Bearer sk-test-bearer-secret',
  },
  nested: ['AIzaSySecretGoogleKey', 'CURSOR_TEST_SECRET'],
};

describe('credential-safe serialization', () => {
  it('redacts planted provider key, config.env, and authorization shapes', () => {
    const rendered = serializeCredentialSafeJson(planted);

    expect(rendered).not.toContain('or-test-openrouter-secret');
    expect(rendered).not.toContain('sk-deepseek-secret');
    expect(rendered).not.toContain('sk-test-bearer-secret');
    expect(rendered).not.toContain('AIzaSySecretGoogleKey');
    expect(rendered).not.toContain('CURSOR_TEST_SECRET');
    expect(rendered).toContain('[REDACTED]');
  });

  it('does not mutate the original value while redacting', () => {
    const rendered = redactCredentialMaterial(planted);

    expect(planted.apiKey).toBe('or-test-openrouter-secret');
    expect(JSON.stringify(rendered)).not.toContain('or-test-openrouter-secret');
  });

  it('redacts long hex and base64-like provider secrets in arbitrary result text', () => {
    const longHex = 'a'.repeat(64);
    const longBase64 = Buffer.from('credential-redaction-fixture-with-enough-entropy').toString('base64');
    const rendered = serializeCredentialSafeJson({
      result: `provider returned hex=${longHex} and blob=${longBase64}`,
    });

    expect(rendered).not.toContain(longHex);
    expect(rendered).not.toContain(longBase64);
    expect(rendered).toContain('[REDACTED]');
  });

  it('does not redact ordinary short or-prefixed policy words', () => {
    const rendered = serializeCredentialSafeJson({
      denyReason: 'restricted-exec-or-write',
    });

    expect(rendered).toContain('restricted-exec-or-write');
    expect(rendered).not.toContain('restricted-exec-[REDACTED]');
  });

  it('property: redacts arbitrary long byte strings rendered as hex or base64', () => {
    fc.assert(
      fc.property(fc.uint8Array({ minLength: 32, maxLength: 64 }), (bytes) => {
        const hex = Buffer.from(bytes).toString('hex');
        const base64 = Buffer.from(bytes).toString('base64');
        const rendered = serializeCredentialSafeJson({ stdout: `hex:${hex} base64:${base64}` });

        expect(rendered).not.toContain(hex);
        expect(rendered).not.toContain(base64);
      }),
      { numRuns: 50 },
    );
  });
});
