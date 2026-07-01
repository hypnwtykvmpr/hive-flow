import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import {
  CREDENTIAL_BOUNDARY_GATES,
  getCredentialBoundaryGate,
} from '../boundary-gates.js';

const repoRoot = resolve(__dirname, '..', '..', '..', '..');

function listFiles(root: string): string[] {
  const result: string[] = [];
  for (const entry of readdirSync(root)) {
    const filePath = join(root, entry);
    const stat = statSync(filePath);
    if (stat.isDirectory()) {
      result.push(...listFiles(filePath));
    } else if (/\.(?:ts|js|mjs|cjs)$/.test(entry)) {
      result.push(filePath);
    }
  }
  return result;
}

describe('credential boundary gate registry', () => {
  it('keeps PR3 green and flips the PR5 strict API bootstrap boundary green', () => {
    expect(getCredentialBoundaryGate('credential-use-not-know')).toMatchObject({
      targetSlice: 'PR3',
      status: 'green',
    });
    expect(getCredentialBoundaryGate('strict-api-no-env-no-config-serialization')).toMatchObject({
      targetSlice: 'PR5',
      status: 'green',
    });
    expect(getCredentialBoundaryGate('strict-api-no-env-no-config-serialization')?.description)
      .toMatch(/production holder bootstrap|seeded|env|argv|config|log|result/i);
    expect(getCredentialBoundaryGate('strict-api-no-env-no-config-serialization')?.description)
      .not.toMatch(/sub-agent|provider-worker|role denial|access control/i);
  });

  it('requires all xfail gates to name the slice that must flip them green', () => {
    for (const gate of CREDENTIAL_BOUNDARY_GATES.filter(entry => entry.status === 'xfail')) {
      expect(gate.targetSlice).toMatch(/^PR[35]$/);
      expect(gate.description.trim()).not.toBe('');
    }
  });

  it.fails.each(CREDENTIAL_BOUNDARY_GATES.filter(entry => entry.status === 'xfail'))(
    'xfail gate %s remains red until its target slice flips it green',
    (gate) => {
      expect(gate.status).toBe('green');
    },
  );
});

describe('credential raw-key boundary registration', () => {
  it('does not expose getKey or retrieveSecret through CLI or MCP surface names', () => {
    const scannedRoots = [
      join(repoRoot, 'cli', 'src', 'commands'),
      join(repoRoot, 'cli', 'src', 'mcp-tools'),
    ];

    const offenders = scannedRoots
      .flatMap(listFiles)
      .filter(filePath => /\b(?:getKey|retrieveSecret)\b/.test(readFileSync(filePath, 'utf8')));

    expect(offenders).toEqual([]);
  });
});
