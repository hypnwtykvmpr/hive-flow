import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['__tests__/**/*.test.ts'],
    exclude: ['node_modules', 'dist'],
    globals: false,
    testTimeout: 20000,
    hookTimeout: 10000,
    typecheck: { enabled: false },
  },
});
