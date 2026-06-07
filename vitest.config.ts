import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    exclude: [
      '**/node_modules/**',
      '**/dist/**',
      '**/.git/**',
      '**/.claude/worktrees/**',
      '**/.codex/worktrees/**',
      '**/.resources/**',
    ],
  },
});
