// v3/@hive-flow/cli/src/integrations/__tests__/shell-prompt-adapter.test.ts
//
// Shell-prompt suppression adapter tests. Asserts:
//   - apply installs a CLAUDECODE-gated managed block; verify confirms it.
//   - apply→uninstall restores the shell rc BYTE-IDENTICAL across rc shapes
//     (empty, no trailing newline, one/many trailing newlines, theme-like body).
//   - re-apply is idempotent (already-registered, content unchanged).
//   - uninstall refuses a user-tampered block without --force-adopt, and removes
//     it with --force-adopt.
//   - the pure region helpers are mutually invertible for arbitrary base text.
//
import { describe, expect, it } from 'vitest';
import { mkdtempSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { shellPromptAdapter, __testing } from '../adapters/shell-prompt.js';
import type { AdapterCtx } from '../adapter.js';

function fixture(rc?: string) {
  const home = mkdtempSync(join(tmpdir(), 'hf-shell-prompt-'));
  const rcPath = join(home, '.zshrc');
  if (rc !== undefined) writeFileSync(rcPath, rc);
  const statePath = join(home, '.hive-flow', 'integrations', 'state.json');
  return { home, rcPath, statePath };
}

function ctxFor(home: string, rcPath: string, statePath: string, overrides: Partial<AdapterCtx> = {}): AdapterCtx {
  return {
    projectRoot: home,
    homeDir: home,
    scope: 'user',
    launcherPath: '',
    statePath,
    shellProfilePath: rcPath,
    dryRun: false,
    createConfig: true,
    forceAdopt: false,
    ...overrides,
  };
}

const RC_SHAPES: Array<{ name: string; rc: string }> = [
  { name: 'empty file', rc: '' },
  { name: 'no trailing newline', rc: "export PATH=/usr/bin\nalias ll='ls -la'" },
  { name: 'one trailing newline', rc: 'autoload -Uz promptinit\nPROMPT="%n@%m %~ %# "\n' },
  { name: 'many trailing newlines', rc: 'source ~/.theme.zsh\n\n\n' },
  { name: 'theme-like body', rc: '# my zsh\nsource ~/.oh-my-zsh/oh-my-zsh.sh\nZSH_THEME="powerline"\nPROMPT=$\'%F{blue}┌──%f\\n└─ \'\n' },
];

describe('shell-prompt adapter', () => {
  it('installs a CLAUDECODE-gated block and verify confirms it', async () => {
    const { home, rcPath, statePath } = fixture('PROMPT="%~ %# "\n');
    const ctx = ctxFor(home, rcPath, statePath);

    const applied = await shellPromptAdapter.apply(ctx);
    expect(applied.outcome).toBe('applied');
    expect(applied.changed).toBe(true);

    const written = readFileSync(rcPath, 'utf8');
    expect(written).toContain(__testing.BLOCK_START);
    expect(written).toContain(__testing.BLOCK_END);
    expect(written).toContain('$CLAUDECODE');
    expect(written.endsWith('\n')).toBe(true);

    const v = await shellPromptAdapter.verify(ctx);
    expect(v.ok).toBe(true);

    // State recorded.
    expect(existsSync(statePath)).toBe(true);
  });

  it('plan/dry-run does not write the rc', async () => {
    const { home, rcPath, statePath } = fixture('PROMPT="x"\n');
    const before = readFileSync(rcPath, 'utf8');
    const planned = await shellPromptAdapter.plan(ctxFor(home, rcPath, statePath));
    expect(planned.outcome).toBe('planned');
    expect(readFileSync(rcPath, 'utf8')).toBe(before);
  });

  for (const { name, rc } of RC_SHAPES) {
    it(`apply then uninstall restores byte-identical rc (${name})`, async () => {
      const { home, rcPath, statePath } = fixture(rc);
      const ctx = ctxFor(home, rcPath, statePath);

      const applied = await shellPromptAdapter.apply(ctx);
      expect(applied.outcome).toBe('applied');
      const withBlock = readFileSync(rcPath, 'utf8');
      expect(withBlock).toContain(__testing.BLOCK_START);
      // The original content is preserved verbatim at the head (suppress, not replace).
      if (rc !== '') expect(withBlock.startsWith(rc)).toBe(true);

      const removed = await shellPromptAdapter.uninstall(ctx);
      expect(removed.outcome).toBe('applied');
      expect(readFileSync(rcPath, 'utf8')).toBe(rc);
    });
  }

  it('is idempotent on re-apply (already-registered, content stable)', async () => {
    const { home, rcPath, statePath } = fixture('PROMPT="a"\n');
    const ctx = ctxFor(home, rcPath, statePath);

    await shellPromptAdapter.apply(ctx);
    const first = readFileSync(rcPath, 'utf8');
    const second = await shellPromptAdapter.apply(ctx);
    expect(second.outcome).toBe('already-registered');
    expect(second.changed).toBe(false);
    expect(readFileSync(rcPath, 'utf8')).toBe(first);
    // Exactly one managed block.
    const occurrences = first.split(__testing.BLOCK_START).length - 1;
    expect(occurrences).toBe(1);
  });

  it('uninstall on an absent block is a no-op', async () => {
    const { home, rcPath, statePath } = fixture('PROMPT="z"\n');
    const r = await shellPromptAdapter.uninstall(ctxFor(home, rcPath, statePath));
    expect(r.outcome).toBe('already-registered');
    expect(r.changed).toBe(false);
  });

  it('refuses to remove a tampered block without --force-adopt; removes with it', async () => {
    const { home, rcPath, statePath } = fixture('PROMPT="b"\n');
    const ctx = ctxFor(home, rcPath, statePath);
    await shellPromptAdapter.apply(ctx);

    // User edits inside the managed block.
    const tampered = readFileSync(rcPath, 'utf8').replace("PS1='$ '", "PS1='HACKED '");
    writeFileSync(rcPath, tampered);

    const refused = await shellPromptAdapter.uninstall(ctx);
    expect(refused.outcome).toBe('conflict:manual-entry');
    expect(refused.changed).toBe(false);

    const forced = await shellPromptAdapter.uninstall(ctxFor(home, rcPath, statePath, { forceAdopt: true }));
    expect(forced.outcome).toBe('applied');
    expect(readFileSync(rcPath, 'utf8')).toBe('PROMPT="b"\n');
  });

  it('verify fails when the block is absent', async () => {
    const { home, rcPath, statePath } = fixture('PROMPT="none"\n');
    const v = await shellPromptAdapter.verify(ctxFor(home, rcPath, statePath));
    expect(v.ok).toBe(false);
  });

  describe('duplicate / multi-block handling (Codex bounce regressions)', () => {
    it('apply collapses duplicate exact blocks to exactly one', async () => {
      const base = 'PROMPT=base\n';
      const { home, rcPath, statePath } = fixture(__testing.withBlock(base) + __testing.managedRegion());
      const ctx = ctxFor(home, rcPath, statePath);

      const r = await shellPromptAdapter.apply(ctx);
      expect(r.outcome).toBe('applied');
      expect(r.changed).toBe(true);
      const text = readFileSync(rcPath, 'utf8');
      expect(text.split(__testing.BLOCK_START).length - 1).toBe(1);
      expect(text.startsWith(base)).toBe(true);
      // verify now passes (exactly one canonical block), and uninstall restores base.
      expect((await shellPromptAdapter.verify(ctx)).ok).toBe(true);
      await shellPromptAdapter.uninstall(ctx);
      expect(readFileSync(rcPath, 'utf8')).toBe(base);
    });

    it('verify fails when a valid first block is followed by a tampered second block', async () => {
      const base = 'x\n';
      const tampered = __testing.managedRegion().replace("PS1='$ '", "PS1='HACK '");
      const { home, rcPath, statePath } = fixture(__testing.withBlock(base) + tampered);
      const v = await shellPromptAdapter.verify(ctxFor(home, rcPath, statePath));
      expect(v.ok).toBe(false);
    });

    it('uninstall removes ALL exact duplicate blocks and restores base byte-identical', async () => {
      const base = 'PROMPT=base\n';
      const { home, rcPath, statePath } = fixture(base);
      const ctx = ctxFor(home, rcPath, statePath);
      await shellPromptAdapter.apply(ctx); // records state, one block
      // A second identical block is appended out-of-band.
      writeFileSync(rcPath, readFileSync(rcPath, 'utf8') + __testing.managedRegion());
      const r = await shellPromptAdapter.uninstall(ctx);
      expect(r.outcome).toBe('applied');
      expect(readFileSync(rcPath, 'utf8')).toBe(base);
    });

    it('uninstall refuses a tampered duplicate without --force-adopt, removes all with it', async () => {
      const base = 'PROMPT=base\n';
      const { home, rcPath, statePath } = fixture(base);
      const ctx = ctxFor(home, rcPath, statePath);
      await shellPromptAdapter.apply(ctx); // state + one canonical block
      const tampered = __testing.managedRegion().replace("PS1='$ '", "PS1='HACK '");
      writeFileSync(rcPath, readFileSync(rcPath, 'utf8') + tampered);

      const refused = await shellPromptAdapter.uninstall(ctx);
      expect(refused.outcome).toBe('conflict:manual-entry');
      expect(refused.changed).toBe(false);

      const forced = await shellPromptAdapter.uninstall(ctxFor(home, rcPath, statePath, { forceAdopt: true }));
      expect(forced.outcome).toBe('applied');
      expect(readFileSync(rcPath, 'utf8')).toBe(base);
    });
  });

  describe('pure region helpers are mutually invertible', () => {
    const bases = [
      '',
      'a',
      'a\n',
      'a\n\n\n',
      'line1\nline2',
      'line1\nline2\n',
      '# comment\nexport X=1\n',
    ];
    for (const base of bases) {
      it(`withoutAllBlocks(withBlock(${JSON.stringify(base)})) === base`, () => {
        const withB = __testing.withBlock(base);
        expect(withB).toContain(__testing.BLOCK_START);
        expect(__testing.withoutAllBlocks(withB)).toBe(base);
        // Re-applying over an already-blocked file is stable.
        const reBlocked = __testing.withBlock(__testing.withoutAllBlocks(withB));
        expect(reBlocked).toBe(withB);
        // Two adjacent blocks (non-canonical) strip back to base byte-identically.
        const twice = withB + __testing.managedRegion();
        expect(__testing.withoutAllBlocks(twice)).toBe(base);
      });
    }
  });
});
