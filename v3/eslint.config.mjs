import eslint from '@eslint/js';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  eslint.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ['src/**/*.ts', '@hive-flow/*/src/**/*.ts', 'hive-flow/src/**/*.ts'],
    rules: {
      '@typescript-eslint/ban-ts-comment': 'warn',
      '@typescript-eslint/no-explicit-any': 'warn',
      '@typescript-eslint/no-unused-vars': ['warn', { argsIgnorePattern: '^_' }],
      '@typescript-eslint/no-require-imports': 'warn',
      '@typescript-eslint/no-namespace': 'warn',
      'no-async-promise-executor': 'warn',
      'no-console': 'warn',
      'no-case-declarations': 'off',
      'no-constant-condition': 'warn',
      'no-control-regex': 'off',
      'no-useless-escape': 'warn',
      'prefer-const': 'off',
    },
  },
  {
    ignores: ['**/dist/**', '**/node_modules/**', '**/__tests__/**'],
  }
);
