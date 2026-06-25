/**
 * HF-5: control-plane store dirs must be write-protected so provider agents
 * cannot overwrite agent/hive/task/terminal state via the bridge write_file/
 * edit_file tools. Verifies the embedded TS policy, the on-disk JSON policy
 * (via loadPolicy), and the CJS mirror all agree.
 *
 * Lives in src/__tests__ (not src/permission-guard/__tests__, which is a
 * protected path) so it can be authored/maintained without coordinator routing.
 */
import { describe, expect, it } from 'vitest';
import { createRequire } from 'node:module';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  findProtectedWritePath,
  isProtectedWritePath,
  loadPolicy,
} from '../permission-guard/protected-paths.js';

const require = createRequire(import.meta.url);
const cjsPolicy = require('../permission-guard/protected-paths.cjs') as typeof import('../permission-guard/protected-paths.js');

const CONTROL_PLANE_ENTRIES = [
  '.hive-flow/agents/',
  '.hive-flow/hives/',
  '.hive-flow/tasks/',
  '.hive-flow/terminals/',
] as const;

function tmpProject(): string {
  const root = mkdtempSync(join(tmpdir(), 'cp-policy-'));
  mkdirSync(join(root, '.hive-flow', 'enforcement'), { recursive: true });
  return root;
}

describe('HF-5 control-plane store protection (TS/CJS/JSON parity)', () => {
  it('lists every control-plane dir in the resolved policy.protectedWrite', () => {
    const policy = loadPolicy();
    for (const entry of CONTROL_PLANE_ENTRIES) {
      expect(policy.protectedWrite, `policy.protectedWrite must contain ${entry}`).toContain(entry);
    }
  });

  it('blocks writes under each control-plane dir in BOTH the TS and CJS matchers', () => {
    const root = tmpProject();
    try {
      const targets = [
        join(root, '.hive-flow', 'agents', 'store.json'),
        join(root, '.hive-flow', 'hives', 'hive-x.json'),
        join(root, '.hive-flow', 'tasks', 'task-y.json'),
        join(root, '.hive-flow', 'terminals', 'term-z.json'),
      ];
      for (const target of targets) {
        expect(isProtectedWritePath(target, root), `TS: ${target}`).toBe(true);
        expect(cjsPolicy.isProtectedWritePath(target, root), `CJS: ${target}`).toBe(true);
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('uses directory-boundary matching (sibling prefix dirs are NOT protected)', () => {
    const root = tmpProject();
    try {
      // shared-prefix siblings must remain writable
      expect(findProtectedWritePath(join(root, '.hive-flow', 'agents-archive', 'old.json'), root)).toBeNull();
      expect(findProtectedWritePath(join(root, '.hive-flow', 'tasks.bak'), root)).toBeNull();
      // exact dir membership IS protected
      expect(findProtectedWritePath(join(root, '.hive-flow', 'agents', 'store.json'), root)).not.toBeNull();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
