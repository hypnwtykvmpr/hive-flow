import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    setupFiles: ['../../__tests__/setup.ts'],
    include: [
      '__tests__/**/*.test.ts',
      '__tests__/**/*.spec.ts',
      'src/__tests__/**/*.test.ts',
      'src/__tests__/**/*.spec.ts',
      'src/**/__tests__/**/*.test.ts',
      'src/**/__tests__/**/*.spec.ts',
    ],
    exclude: ['**/node_modules/**', '**/dist/**'],
    mockReset: true,
    clearMocks: true,
    restoreMocks: true,
    testTimeout: 10000,
    hookTimeout: 10000,
  },
});
