import { describe, expect, it } from 'vitest';
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
});
