// Flat config — kept intentionally light. The point of running eslint in CI is
// to catch obvious mistakes (unused vars, `any`, `let` that could be `const`)
// before they hit review, not to enforce a style guide. Prettier owns style.
import eslint from '@eslint/js';
import prettier from 'eslint-config-prettier';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  {
    ignores: [
      'coverage/**',
      'dist/**',
      'demo-agent/**',
      'example/**',
      'eslint.config.mjs',
      'vitest.config.ts',
      'node_modules/**',
    ],
  },
  eslint.configs.recommended,
  ...tseslint.configs.recommended,
  prettier,
  {
    files: ['**/*.ts'],
    // Deliberately no `parserOptions.project` — we only enable rules that work
    // off the AST. Turning on type-aware rules would force us to list every
    // .ts file (tests included) in a project tsconfig, which is more machinery
    // than a light lint pass warrants. `npm run typecheck` remains the
    // authoritative type gate.
    rules: {
      // These rules fire on the driver-shim code paths that have to accept
      // whatever the host driver or the model gives us. Downgrade to warnings
      // so the diagnostic stays visible without blocking merges.
      '@typescript-eslint/no-explicit-any': 'warn',
      '@typescript-eslint/no-non-null-assertion': 'warn',
      '@typescript-eslint/no-unsafe-function-type': 'warn',
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
    },
  },
  {
    files: ['test/**/*.ts'],
    rules: {
      '@typescript-eslint/no-explicit-any': 'off',
      '@typescript-eslint/no-non-null-assertion': 'off',
      '@typescript-eslint/no-unsafe-function-type': 'off',
      // Tests routinely take a `_opts` parameter to keep the mock signature in
      // sync with the real one — don't force an underscore rename.
      '@typescript-eslint/no-unused-vars': [
        'error',
        { args: 'none', varsIgnorePattern: '^_' },
      ],
    },
  },
);
