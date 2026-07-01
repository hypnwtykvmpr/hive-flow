import { defineConfig } from 'vitest/config';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const e2eRoot = dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  root: e2eRoot,
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
