/**
 * Safe Executor — cross-platform (Windows) command-name hardening (E2).
 *
 * `DANGEROUS_COMMANDS.includes(path.basename(cmd))` and the allowlist
 * `path.basename(allowed) === path.basename(cmd)` comparisons let a Windows
 * executable token bypass the destructive-command blocklist: `path.basename`
 * on POSIX returns `rm.exe` (not `rm`), so `rm.exe`/`shutdown.exe`/`kill.exe`
 * sailed past the blocklist. The fix normalizes the basename used for
 * NAME-POLICY decisions (blocklist + allowlist membership) the same way the
 * provider bridge does: backslash→slash, basename, lowercase, trim trailing
 * dots/spaces, strip ONE trailing known Windows exec extension.
 */
import { describe, it, expect } from 'vitest';
import { SafeExecutor, SafeExecutorError } from '../safe-executor.js';

describe('SafeExecutor cross-platform command-name hardening (E2)', () => {
  describe('blocklist: dangerous .exe tokens cannot be allowed', () => {
    it('rejects rm.exe in the allowlist (constructor validateConfig)', () => {
      expect(() => new SafeExecutor({ allowedCommands: ['rm.exe'] })).toThrow(SafeExecutorError);
    });
    it('rejects shutdown.exe in the allowlist', () => {
      expect(() => new SafeExecutor({ allowedCommands: ['shutdown.exe'] })).toThrow(SafeExecutorError);
    });
    it('rejects kill.exe in the allowlist', () => {
      expect(() => new SafeExecutor({ allowedCommands: ['kill.exe'] })).toThrow(SafeExecutorError);
    });
    it('rejects a Windows-path rm.exe (backslash)', () => {
      expect(() => new SafeExecutor({ allowedCommands: ['C:\\Windows\\System32\\rm.exe'] })).toThrow(SafeExecutorError);
    });
    it('rejects rm.exe via allowCommand at runtime', () => {
      const ex = new SafeExecutor({ allowedCommands: ['git'] });
      expect(() => ex.allowCommand('rm.exe')).toThrow(SafeExecutorError);
    });

    // Regression: bare destructive names still blocked (existing behavior).
    it('still rejects bare rm', () => {
      expect(() => new SafeExecutor({ allowedCommands: ['rm'] })).toThrow(SafeExecutorError);
    });
    it('still rejects bare shutdown', () => {
      expect(() => new SafeExecutor({ allowedCommands: ['shutdown'] })).toThrow(SafeExecutorError);
    });
  });

  describe('allowlist: .exe tokens match their POSIX allowlist entry', () => {
    it('git.exe is allowed when git is in the allowlist', () => {
      const ex = new SafeExecutor({ allowedCommands: ['git', 'node'] });
      expect(ex.isCommandAllowed('git.exe')).toBe(true);
    });
    it('node.cmd is allowed when node is in the allowlist', () => {
      const ex = new SafeExecutor({ allowedCommands: ['git', 'node'] });
      expect(ex.isCommandAllowed('node.cmd')).toBe(true);
    });
    it('NODE.EXE (capital) is allowed when node is in the allowlist', () => {
      const ex = new SafeExecutor({ allowedCommands: ['git', 'node'] });
      expect(ex.isCommandAllowed('NODE.EXE')).toBe(true);
    });
    it('an unrelated .exe is NOT allowed', () => {
      const ex = new SafeExecutor({ allowedCommands: ['git', 'node'] });
      expect(ex.isCommandAllowed('curl.exe')).toBe(false);
    });
  });
});
