/**
 * Forbidden Safeguard Enhancement Tests
 *
 * Covers:
 * 1. splitShellCommands() — quote-aware command splitting
 * 2. Updated FORBIDDEN_PATTERNS — git push -f, --force-with-lease
 * 3. checkForbiddenSafeguard — chained command detection
 * 4. Subcommand extraction — bash -c / sh -c wrappers
 * 5. Bypass attempts that MUST be caught (10 cases)
 * 6. Legitimate commands that MUST pass (10 cases)
 * 7. Interaction with hasChainedDestructive (complementary, not conflicting)
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@hive-flow/shared', () => ({
  resolveProjectRoot: () => '/project',
}));

import {
  evaluateHookInput,
  resetConfigCache,
  splitShellCommands,
  stripCommand,
  hasChainedDestructive,
} from '../gate.js';
import type { HookInput } from '../types.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function bashInput(command: string): HookInput {
  return { tool_name: 'Bash', tool_input: { command }, cwd: '/project' };
}

beforeEach(() => {
  resetConfigCache();
});

// ---------------------------------------------------------------------------
// 1. splitShellCommands — quote-aware splitting
// ---------------------------------------------------------------------------

describe('splitShellCommands', () => {
  it('splits on &&', () => {
    expect(splitShellCommands('echo ok && rm -rf /')).toEqual(['echo ok', 'rm -rf /']);
  });

  it('splits on ;', () => {
    expect(splitShellCommands('echo ok; rm -rf /')).toEqual(['echo ok', 'rm -rf /']);
  });

  it('splits on ||', () => {
    expect(splitShellCommands('false || rm -rf /')).toEqual(['false', 'rm -rf /']);
  });

  it('splits on |', () => {
    expect(splitShellCommands('ls | rm -rf /')).toEqual(['ls', 'rm -rf /']);
  });

  it('does NOT split inside double quotes', () => {
    const result = splitShellCommands('echo "hello && world"');
    expect(result).toEqual(['echo "hello && world"']);
  });

  it('does NOT split inside single quotes', () => {
    const result = splitShellCommands("echo 'a;b' || ls");
    expect(result).toEqual(["echo 'a;b'", 'ls']);
  });

  it('does NOT split inside $-quotes', () => {
    const result = splitShellCommands("echo $'a&&b' && ls");
    expect(result).toEqual(["echo $'a&&b'", 'ls']);
  });

  it('handles escaped characters outside quotes', () => {
    const result = splitShellCommands('echo test\\; && ls');
    expect(result).toEqual(['echo test\\;', 'ls']);
  });

  it('handles multiple chained segments', () => {
    const result = splitShellCommands('a && b; c || d | e');
    expect(result).toEqual(['a', 'b', 'c', 'd', 'e']);
  });

  it('handles empty input', () => {
    expect(splitShellCommands('')).toEqual([]);
  });

  it('trims whitespace from segments', () => {
    expect(splitShellCommands('  echo ok  &&  ls  ')).toEqual(['echo ok', 'ls']);
  });

  it('handles unterminated single quote gracefully', () => {
    const result = splitShellCommands("echo 'unterminated && rm -rf /");
    // The unterminated quote consumes the rest, no split
    expect(result).toEqual(["echo 'unterminated && rm -rf /"]);
  });

  it('handles backslash escapes inside double quotes', () => {
    const result = splitShellCommands('echo "he said \\"no\\"" && ls');
    expect(result).toEqual(['echo "he said \\"no\\""', 'ls']);
  });

  it('returns single element for simple command', () => {
    expect(splitShellCommands('npm test')).toEqual(['npm test']);
  });
});

// ---------------------------------------------------------------------------
// 2. FORBIDDEN_PATTERNS — git push -f and --force-with-lease
// ---------------------------------------------------------------------------

describe('FORBIDDEN_PATTERNS covers git push short flags', () => {
  it('denies git push -f', async () => {
    const result = await evaluateHookInput(bashInput('git push -f origin main'));
    expect(result.decision).toBe('deny');
  });

  it('denies git push -f (no args)', async () => {
    const result = await evaluateHookInput(bashInput('git push -f'));
    expect(result.decision).toBe('deny');
  });

  it('denies git push --force-with-lease', async () => {
    const result = await evaluateHookInput(bashInput('git push --force-with-lease origin main'));
    expect(result.decision).toBe('deny');
  });

  it('denies git push --force-with-lease (no args)', async () => {
    const result = await evaluateHookInput(bashInput('git push --force-with-lease'));
    expect(result.decision).toBe('deny');
  });

  it('still denies git push --force (original pattern)', async () => {
    const result = await evaluateHookInput(bashInput('git push --force origin main'));
    expect(result.decision).toBe('deny');
  });

  it('still allows normal git push', async () => {
    const result = await evaluateHookInput(bashInput('git push origin main'));
    expect(result.decision).toBe('allow');
  });

  it('still allows git push with -u flag (not -f)', async () => {
    const result = await evaluateHookInput(bashInput('git push -u origin feature-branch'));
    expect(result.decision).toBe('allow');
  });
});

describe('safe rm/chmod are not blanket-denied', () => {
  it('allows a non-recursive single-file rm through the full guard stack', async () => {
    const result = await evaluateHookInput(bashInput('rm stale-output.txt'));
    expect(result.decision).toBe('allow');
  });

  it('allows ordinary executable-bit chmod through the full guard stack', async () => {
    const result = await evaluateHookInput(bashInput('chmod +x scripts/run-local.sh'));
    expect(result.decision).toBe('allow');
  });

  it('still blocks root and sudo destructive rm commands', async () => {
    await expect(evaluateHookInput(bashInput('rm -rf /'))).resolves.toMatchObject({ decision: 'deny' });
    await expect(evaluateHookInput(bashInput('rm -rf /*'))).resolves.toMatchObject({ decision: 'deny' });
    await expect(evaluateHookInput(bashInput('sudo rm stale-output.txt'))).resolves.toMatchObject({ decision: 'deny' });
  });
});

// ---------------------------------------------------------------------------
// 3. checkForbiddenSafeguard — chained command detection
// ---------------------------------------------------------------------------

describe('Forbidden safeguard catches chained commands', () => {
  it('catches rm after &&', async () => {
    const result = await evaluateHookInput(bashInput('echo test && rm -rf /'));
    expect(result.decision).toBe('deny');
  });

  it('catches rm after ;', async () => {
    const result = await evaluateHookInput(bashInput('echo test; rm -rf /'));
    expect(result.decision).toBe('deny');
  });

  it('catches rm after ||', async () => {
    const result = await evaluateHookInput(bashInput('false || rm -rf /'));
    expect(result.decision).toBe('deny');
  });

  it('catches rm after |', async () => {
    const result = await evaluateHookInput(bashInput('ls | rm -rf /'));
    expect(result.decision).toBe('deny');
  });

  it('catches chmod in a chain', async () => {
    const result = await evaluateHookInput(bashInput('echo ok && chmod 777 /etc'));
    expect(result.decision).toBe('deny');
  });

  it('catches git push --force in a chain', async () => {
    const result = await evaluateHookInput(bashInput('npm test && git push --force origin main'));
    expect(result.decision).toBe('deny');
  });

  it('catches git push -f in a chain', async () => {
    const result = await evaluateHookInput(bashInput('npm run build && git push -f origin main'));
    expect(result.decision).toBe('deny');
  });

  it('catches git reset --hard in a chain', async () => {
    const result = await evaluateHookInput(bashInput('echo cleaning && git reset --hard HEAD'));
    expect(result.decision).toBe('deny');
  });

  it('catches forbidden command with env var prefix in chain', async () => {
    const result = await evaluateHookInput(bashInput('echo ok && MY_VAR=1 rm -rf /tmp'));
    expect(result.decision).toBe('deny');
  });
});

// ---------------------------------------------------------------------------
// 4. Subcommand extraction — bash -c / sh -c
// ---------------------------------------------------------------------------

describe('Forbidden safeguard catches subcommands in shell wrappers', () => {
  it('catches rm inside bash -c', async () => {
    const result = await evaluateHookInput(bashInput('bash -c "rm -rf /"'));
    expect(result.decision).toBe('deny');
  });

  it('catches rm inside sh -c', async () => {
    const result = await evaluateHookInput(bashInput("sh -c 'rm -rf /'"));
    expect(result.decision).toBe('deny');
  });

  it('catches chained forbidden inside bash -c', async () => {
    const result = await evaluateHookInput(bashInput('bash -c "echo ok && rm -rf /"'));
    expect(result.decision).toBe('deny');
  });

  it('catches chmod inside bash -c after chain', async () => {
    const result = await evaluateHookInput(bashInput('echo setup && bash -c "chmod 777 /etc"'));
    expect(result.decision).toBe('deny');
  });
});

// ---------------------------------------------------------------------------
// 5. Bypass attempts that MUST be caught (10 cases)
// ---------------------------------------------------------------------------

describe('Bypass attempts (10 cases that MUST be caught)', () => {
  const bypassAttempts: Array<{ name: string; cmd: string }> = [
    {
      name: '1. rm hidden after &&',
      cmd: 'echo test && rm -rf /',
    },
    {
      name: '2. rm hidden after ; with innocent prefix',
      cmd: 'ls -la; rm -rf /home/user',
    },
    {
      name: '3. git push -f short flag bypass',
      cmd: 'git push -f origin main',
    },
    {
      name: '4. git push --force-with-lease bypass',
      cmd: 'git push --force-with-lease origin feature',
    },
    {
      name: '5. chmod after || (on-failure chain)',
      cmd: 'npm test || chmod 777 /etc/shadow',
    },
    {
      name: '6. rm piped from innocent command',
      cmd: 'cat file.txt | rm -rf /tmp',
    },
    {
      name: '7. chained git reset --hard after build',
      cmd: 'npm run build && git reset --hard HEAD~5',
    },
    {
      name: '8. docker rm hidden after &&',
      cmd: 'docker ps && docker rm my-container',
    },
    {
      name: '9. rm with env var prefix in chain',
      cmd: 'echo ok && FORCE=1 rm -rf ./build',
    },
    {
      name: '10. killall hidden after semicolons',
      cmd: 'echo a; echo b; killall node',
    },
  ];

  for (const { name, cmd } of bypassAttempts) {
    it(`catches: ${name}`, async () => {
      const result = await evaluateHookInput(bashInput(cmd));
      expect(result.decision).toBe('deny');
    });
  }
});

// ---------------------------------------------------------------------------
// 6. Legitimate commands that MUST pass (10 cases)
// ---------------------------------------------------------------------------

describe('Legitimate commands (10 cases that MUST pass)', () => {
  const legitimate: Array<{ name: string; cmd: string }> = [
    {
      name: '1. normal git push',
      cmd: 'git push origin main',
    },
    {
      name: '2. git push with -u flag',
      cmd: 'git push -u origin feature-branch',
    },
    {
      name: '3. npm build && npm test chain',
      cmd: 'npm run build && npm test',
    },
    {
      name: '4. echo with && inside quotes',
      cmd: 'echo "building && testing" > log.txt',
    },
    {
      name: '5. grep with semicolon in pattern',
      cmd: "grep 'foo;bar' src/index.ts",
    },
    {
      name: '6. git status && git log chain',
      cmd: 'git status && git log --oneline -5',
    },
    {
      name: '7. node build pipeline',
      cmd: 'tsc --noEmit && eslint src/ && npm test',
    },
    {
      name: '8. cat with pipe to grep',
      cmd: 'cat package.json | grep version',
    },
    {
      name: '9. ls with semicolon and pwd',
      cmd: 'ls -la; pwd',
    },
    {
      name: '10. echo with rm-like text in quotes',
      cmd: 'echo "do not rm -rf anything"',
    },
  ];

  for (const { name, cmd } of legitimate) {
    it(`allows: ${name}`, async () => {
      const result = await evaluateHookInput(bashInput(cmd));
      expect(result.decision).toBe('allow');
    });
  }
});

// ---------------------------------------------------------------------------
// 7. Complementary behavior with hasChainedDestructive
// ---------------------------------------------------------------------------

describe('Complementary behavior with hasChainedDestructive', () => {
  it('hasChainedDestructive catches && rm (regex-based)', () => {
    expect(hasChainedDestructive('echo test && rm -rf /')).toBe(true);
  });

  it('hasChainedDestructive catches ; rm (regex-based)', () => {
    expect(hasChainedDestructive('echo test; rm file')).toBe(true);
  });

  it('hasChainedDestructive does NOT protect against chained git push --force', () => {
    // This is the gap that the enhanced forbidden safeguard fills
    expect(hasChainedDestructive('npm test && git push --force origin main')).toBe(false);
  });

  it('hasChainedDestructive does NOT protect against chained git push -f', () => {
    expect(hasChainedDestructive('npm test && git push -f origin main')).toBe(false);
  });

  it('hasChainedDestructive does NOT protect against chained chmod', () => {
    expect(hasChainedDestructive('echo ok && chmod 777 /etc')).toBe(false);
  });

  it('hasChainedDestructive does NOT protect against chained git reset --hard', () => {
    expect(hasChainedDestructive('npm test && git reset --hard HEAD')).toBe(false);
  });

  it('forbidden safeguard catches what hasChainedDestructive misses', async () => {
    // These are NOT caught by hasChainedDestructive but ARE caught by the safeguard
    const gapCommands = [
      'npm test && git push --force origin main',
      'npm test && git push -f origin main',
      'echo ok && chmod 777 /etc',
      'echo ok && git reset --hard HEAD',
      'echo ok && chown root:root /etc/passwd',
      'echo ok && killall node',
      'echo ok && docker rm container1',
      'echo ok && docker rmi image:latest',
    ];

    for (const cmd of gapCommands) {
      const result = await evaluateHookInput(bashInput(cmd));
      expect(result.decision).toBe('deny');
    }
  });
});

// ---------------------------------------------------------------------------
// Edge cases
// ---------------------------------------------------------------------------

describe('Edge cases', () => {
  it('handles deeply chained commands', async () => {
    const result = await evaluateHookInput(
      bashInput('echo a && echo b && echo c && rm -rf /')
    );
    expect(result.decision).toBe('deny');
  });

  it('handles mixed operators', async () => {
    const result = await evaluateHookInput(
      bashInput('echo a; echo b || chmod 777 /tmp')
    );
    expect(result.decision).toBe('deny');
  });

  it('does not false-positive on rm appearing in arguments', async () => {
    // "rm" appears in the grep pattern, not as a command
    const result = await evaluateHookInput(bashInput('grep "rm -rf" src/safety.ts'));
    expect(result.decision).toBe('allow');
  });

  it('does not false-positive on --force in non-git context', async () => {
    // npm install --force is not git push --force
    const result = await evaluateHookInput(bashInput('npm install --force'));
    expect(result.decision).toBe('allow');
  });

  it('handles empty segments gracefully', async () => {
    // Trailing semicolons produce empty segments
    const result = await evaluateHookInput(bashInput('npm test;'));
    expect(result.decision).toBe('allow');
  });
});
