import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['__tests__/**/*.test.ts', 'src/**/*.test.ts', 'src/**/__tests__/**/*.test.ts'],
    globals: true,
    testTimeout: 10000,
    hookTimeout: 10000,
    // Disable coverage for CLI package (uses vitest v2)
    coverage: {
      enabled: false,
    },
  },
});
