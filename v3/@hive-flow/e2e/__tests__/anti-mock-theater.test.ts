import { mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { describe, expect, it } from 'vitest';
import * as fc from 'fast-check';
import { formatViolations, scanE2eSources } from '../src/anti-mock-theater.js';
import { packageRoot } from './helpers.js';

describe('CA-1 anti-mock-theater gate', () => {
  it('keeps the e2e suite free of mocks, phantom imports, and forbidden legacy methods', () => {
    const violations = scanE2eSources(packageRoot);
    expect(formatViolations(violations)).toBe('');
  });

  it('fails on a planted mock and phantom import', async () => {
    const root = await makeTempRoot();
    const sourcePath = join(root, '__tests__', 'bad.test.ts');
    const phantomImport = ['..', '..', 'src', 'phantom'].join('/');
    const plantedMock = ['vi.', 'fn()'].join('');
    await writeFile(sourcePath, `import x from '${phantomImport}';\nconst y = ${plantedMock};\n`);

    try {
      const violations = scanE2eSources(root);
      expect(violations.map((v) => v.label)).toEqual(
        expect.arrayContaining(['phantom root source import', 'vitest function mock'])
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('accepts arbitrary source that avoids the forbidden pattern vocabulary', async () => {
    await fc.assert(
      fc.asyncProperty(safeSourceArbitrary(), async (source) => {
        const root = await makeTempRoot();
        await writeFile(join(root, '__tests__', 'safe.test.ts'), source);
        try {
          expect(scanE2eSources(root)).toHaveLength(0);
        } finally {
          await rm(root, { recursive: true, force: true });
        }
      }),
      { numRuns: 40 }
    );
  });
});

async function makeTempRoot(): Promise<string> {
  const root = join(tmpdir(), `hive-flow-e2e-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  await mkdir(join(root, '__tests__'), { recursive: true });
  return root;
}

function safeSourceArbitrary(): fc.Arbitrary<string> {
  const forbiddenFragments = [
    ['vi.', 'fn('].join(''),
    ['vi.', 'mock('].join(''),
    ['..', '..', 'src'].join('/'),
    ['vector', 'Search'].join(''),
    ['get', 'SwarmState'].join(''),
    ['distribute', 'Tasks'].join(''),
    ['execute', 'Task'].join(''),
    ['scale', 'Agents'].join(''),
    ['reach', 'Consensus'].join(''),
    ['re', 'configure'].join(''),
    ['Workflow', 'Engine'].join(''),
    ['clear', 'Agent'].join(''),
    ['get', 'ExtensionPoints'].join(''),
    'mocks',
  ];

  return fc
    .string({ minLength: 0, maxLength: 200 })
    .filter((source) => forbiddenFragments.every((fragment) => !source.includes(fragment)));
}
