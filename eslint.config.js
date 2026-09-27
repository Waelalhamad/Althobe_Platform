// @ts-check
import js from '@eslint/js';
import globals from 'globals';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  {
    ignores: [
      '**/node_modules/**',
      '**/dist/**',
      '**/coverage/**',
      'backend/prisma/migrations/**',
      'packages/ui/brand/**',
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommendedTypeChecked,
  {
    languageOptions: {
      globals: { ...globals.node },
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      '@typescript-eslint/no-explicit-any': 'error',
      // An un-awaited query inside a transaction runs outside it, or after commit.
      '@typescript-eslint/no-floating-promises': 'error',
      '@typescript-eslint/no-misused-promises': 'error',
      // A function that returns a promise must be async, so validation and permission failures
      // reject the promise instead of throwing synchronously (caught by the tests, 2026-09-24).
      '@typescript-eslint/promise-function-async': 'error',
      '@typescript-eslint/consistent-type-imports': 'error',
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
      eqeqeq: ['error', 'always'],
    },
  },
  {
    files: ['*.js', '*.mjs'],
    ...tseslint.configs.disableTypeChecked,
  },
  {
    files: ['apps/**/*.{ts,tsx}', 'packages/ui/**/*.{ts,tsx}'],
    languageOptions: { globals: { ...globals.browser } },
  },

  // ---- Module boundaries (ADR-002) ----------------------------------------------------------
  // A module is called through its service. Its repository is private to it.
  {
    files: ['backend/src/modules/**/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: ['../*/*.repository*', '../../*/*.repository*'],
              message:
                'Another module’s repository is private. Call its service instead (ADR-002).',
            },
          ],
        },
      ],
    },
  },
  // shared/ is infrastructure. It must never depend on a business module.
  {
    files: ['backend/src/shared/**/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: ['../modules/*', '../modules/**', '../../modules/**'],
              message: 'shared/ must not import from modules/ — dependencies point one way.',
            },
          ],
        },
      ],
    },
  },
);
