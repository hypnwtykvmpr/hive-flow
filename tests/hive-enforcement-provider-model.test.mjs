/**
 * Regression: d7rA-006 — PROVIDER_MODELS['codex-cli'] must be 'gpt-5.5'
 *
 * The MCP enforcement gate blocks codex-cli+gpt-5.4; auto-spawned deficit
 * workers were silently rejected. This test asserts the corrected model value
 * and that it does not match the previously-blocked value.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, '..');

// Load the module via CJS require (it is a CommonJS file).
const _require = createRequire(import.meta.url);
const { PROVIDER_MODELS, PROVIDERS } = _require(
  join(REPO_ROOT, '.claude/helpers/hive-enforcement.cjs')
);

describe('hive-enforcement PROVIDER_MODELS regression (d7rA-006)', () => {
  it('PROVIDER_MODELS[codex-cli] is gpt-5.5 (not the gate-blocked gpt-5.4)', () => {
    assert.equal(
      PROVIDER_MODELS['codex-cli'],
      'gpt-5.5',
      'codex-cli model must be gpt-5.5 to pass the MCP enforcement gate'
    );
  });

  it('PROVIDER_MODELS[codex-cli] is not the previously gate-blocked gpt-5.4', () => {
    assert.notEqual(
      PROVIDER_MODELS['codex-cli'],
      'gpt-5.4',
      'gpt-5.4 is explicitly blocked by the model gate — must not be used'
    );
  });

  it('every provider in the PROVIDERS cycle has a model entry', () => {
    for (const provider of PROVIDERS) {
      assert.ok(
        typeof PROVIDER_MODELS[provider] === 'string' && PROVIDER_MODELS[provider].length > 0,
        `PROVIDER_MODELS['${provider}'] must be a non-empty string`
      );
    }
  });

  it('gemini-cli model is unchanged (gemini-3.1-pro-preview)', () => {
    assert.equal(PROVIDER_MODELS['gemini-cli'], 'gemini-3.1-pro-preview');
  });
});
