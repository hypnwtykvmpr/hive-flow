import { describe, expect, it, afterAll, beforeEach } from 'vitest';
import fc from 'fast-check';
import { createRequire } from 'node:module';
import { copyFileSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdtempSync } from 'node:fs';
import { propertyRunsFromEnv } from './property-runs.js';

const PROPERTY_RUNS = propertyRunsFromEnv(100);

const require = createRequire(import.meta.url);
const here = dirname(fileURLToPath(import.meta.url));
const source = resolve(here, '../../../../../.claude/helpers/enforcement.cjs');
const root = mkdtempSync(join(tmpdir(), 'hive-flow-enforcement-security-'));
const helperPath = join(root, '.claude', 'helpers', 'enforcement.cjs');
mkdirSync(dirname(helperPath), { recursive: true });
copyFileSync(source, helperPath);

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let enf: any;

function resetModule(): void {
  delete require.cache[require.resolve(helperPath)];
  enf = require(helperPath);
}

function statePath(): string {
  return enf.getStateFile();
}

describe('enforcement security property contracts', () => {
  beforeEach(() => {
    resetModule();
    rmSync(join(root, '.hive-flow', 'enforcement'), { recursive: true, force: true });
    mkdirSync(dirname(statePath()), { recursive: true });
  });

  afterAll(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it('recovers tampered signed state at WARNED minimum for arbitrary prior levels', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: 3 }),
        fc.integer({ min: 0, max: 50 }),
        fc.array(fc.string({ maxLength: 24 }), { maxLength: 5 }),
        (level, violations, restrictedGroups) => {
          resetModule();
          rmSync(join(root, '.hive-flow', 'enforcement'), { recursive: true, force: true });
          mkdirSync(dirname(statePath()), { recursive: true });
          const state = {
            level,
            violations,
            consecutiveDenials: 0,
            lastActivity: new Date(0).toISOString(),
            restrictedGroups,
            history: [],
            resetAt: null,
            integrityCompromised: false,
          };
          const envelope = enf.signState(state);
          envelope.hmac = `${envelope.hmac.slice(1)}0`;
          writeFileSync(statePath(), JSON.stringify(envelope));

          const recovered = enf.getState();
          expect(recovered.level).toBeGreaterThanOrEqual(enf.LEVELS.WARNED);
          expect(recovered.integrityCompromised).toBe(true);
          expect(recovered.violations).toBeGreaterThanOrEqual(1);

          const rewritten = JSON.parse(readFileSync(statePath(), 'utf8'));
          expect(enf.verifyState(rewritten).valid).toBe(true);
        },
      ),
      { seed: 20_621, numRuns: PROPERTY_RUNS },
    );
  });

  it('treats generated protected write destinations as circumvention', () => {
    const protectedLeaves = fc.constantFrom(
      '.claude/settings.json',
      '.claude/helpers/enforcement.cjs',
      '.claude/helpers/role-enforcement.cjs',
      '.hive-flow/enforcement/state.json',
      'v3/@hive-flow/cli/dist/src/mcp-tools/index.js',
    );
    const toolName = fc.constantFrom('Write', 'Edit', 'MultiEdit', 'mcp__filesystem__write_file', 'mcp__filesystem__move_file');

    fc.assert(
      fc.property(protectedLeaves, toolName, (leaf, tool) => {
        const input = tool === 'mcp__filesystem__move_file'
          ? { source: 'tmp.txt', destination: leaf }
          : { file_path: leaf, path: leaf };
        const result = enf.detectCircumvention(tool, input, {
          level: 0,
          violations: 0,
          restrictedGroups: [],
          history: [],
          integrityCompromised: false,
        });
        expect(result.circumvention).toBe(true);
      }),
      { seed: 20_622, numRuns: PROPERTY_RUNS },
    );
  });
});
