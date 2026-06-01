import { describe, expect, it } from 'vitest';

import { createASTAnalyzer } from '../ast-analyzer.js';

describe('ASTAnalyzer', () => {
  it('uses ast-grep structural matching for symbols, imports, exports, and line ranges', () => {
    const code = [
      "import type { Config } from './config.js';",
      "import fs, { readFile } from 'node:fs';",
      "import 'side-effect-package';",
      "const dynamicModule = await import('node:path');",
      "const os = require('node:os');",
      'export interface Thing { id: string }',
      'export type Alias = Thing;',
      'export enum Mode { Fast }',
      'export default class Worker extends Base {',
      '  constructor(public name: string) {}',
      '  async run(flag: boolean): Promise<void> {',
      '    if (flag && this.name) {',
      "      await readFile(this.name, 'utf8');",
      '    }',
      '  }',
      '}',
      'export function topLevel(input: string) {',
      '  const nested = () => input.toUpperCase();',
      '  return nested();',
      '}',
      'export const arrow = async (value: number) => value + 1;',
      'export { arrow as renamedArrow };',
    ].join('\n');

    const analysis = createASTAnalyzer().analyze(code, '/tmp/example.ts');

    expect(analysis.language).toBe('typescript');
    expect(analysis.root.metadata?.parser).toBe('ast-grep');
    expect(analysis.root.metadata?.matchEngine).toBe('ast-grep-kind-fields');
    expect(analysis.imports).toEqual([
      './config.js',
      'node:fs',
      'side-effect-package',
      'node:path',
      'node:os',
    ]);
    expect(analysis.exports).toEqual(expect.arrayContaining(['Thing', 'Alias', 'Mode', 'Worker', 'topLevel', 'arrow']));
    expect(analysis.classes.map(cls => cls.name)).toEqual(['Worker']);
    expect(analysis.functions.map(fn => fn.name)).toEqual([
      'constructor',
      'run',
      'topLevel',
      'nested',
      'arrow',
    ]);

    const worker = analysis.classes[0];
    expect(worker.startLine).toBe(9);
    expect(worker.endLine).toBe(16);
    expect(worker.metadata?.extends).toBe('Base');

    const run = analysis.functions.find(fn => fn.name === 'run');
    expect(run?.startLine).toBe(11);
    expect(run?.endLine).toBe(15);
    expect(createASTAnalyzer().getClassAtLine(analysis, 12)?.name).toBe('Worker');
    expect(createASTAnalyzer().getFunctionAtLine(analysis, 12)?.name).toBe('run');
    expect(createASTAnalyzer().getFunctionAtLine(analysis, 18)?.name).toBe('nested');
    expect(analysis.complexity.cyclomatic).toBeGreaterThanOrEqual(3);
  });

  it('does not report commented or string literal pseudo-symbols', () => {
    const code = [
      "const text = 'function fake() {} class Fake {}';",
      '// function commentedOut() {}',
      '// class Commented {}',
      'export function real() {',
      '  return text;',
      '}',
    ].join('\n');

    const analysis = createASTAnalyzer().analyze(code, '/tmp/false-positive.ts');

    expect(analysis.functions.map(fn => fn.name)).toEqual(['real']);
    expect(analysis.classes).toEqual([]);
    expect(analysis.exports).toEqual(['real']);
  });

  it('keeps ast-grep import and export matching scoped to structural module edges', () => {
    const code = [
      "import legacy = require('legacy-module');",
      "const fs = require('node:fs');",
      "export { value as renamedValue } from './value.js';",
      'export const value = () => "not-a-module";',
      'export default function () {',
      "  return 'not-an-import';",
      '}',
    ].join('\n');

    const analysis = createASTAnalyzer().analyze(code, '/tmp/edges.ts');

    expect(analysis.imports).toEqual(['legacy-module', './value.js', 'node:fs']);
    expect(analysis.exports).toEqual(expect.arrayContaining(['value', 'default']));
    expect(analysis.imports).not.toContain('not-a-module');
    expect(analysis.imports).not.toContain('not-an-import');
  });

  it('keeps the legacy heuristic fallback for non-JavaScript languages', () => {
    const code = [
      'class Worker:',
      '    def run(self):',
      '        return True',
    ].join('\n');

    const analysis = createASTAnalyzer().analyze(code, '/tmp/worker.py');

    expect(analysis.language).toBe('python');
    expect(analysis.classes.map(cls => cls.name)).toEqual(['Worker']);
    expect(analysis.functions.map(fn => fn.name)).toEqual(['run']);
  });
});
