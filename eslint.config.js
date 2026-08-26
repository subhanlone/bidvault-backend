// @ts-check
import js from '@eslint/js';
import globals from 'globals';
import tseslint from 'typescript-eslint';

/**
 * Type-aware linting for the backend, which had none.
 *
 * `tsc` catches type errors; it does not catch the class of defect that costs this codebase
 * most: a promise nobody awaits. The audit found several — an awaited Redis write on the bid
 * path that stalls a committed bid, four `.catch(() => {})` calls that silently drop audit
 * records, a sequential `await` inside an unbounded loop. `no-floating-promises` and
 * `no-misused-promises` are the reason this config exists; everything else is a bonus.
 *
 * Type-aware rules need the program, hence projectService.
 */
export default tseslint.config(
  {
    ignores: ['dist/**', 'node_modules/**', 'prisma/migrations/**'],
  },
  js.configs.recommended,
  ...tseslint.configs.recommendedTypeChecked,
  {
    languageOptions: {
      parserOptions: {
        // tsconfig.json is src-only (build output must not include tests), so the test and
        // script files live in tsconfig.test.json. Both are listed here or those files parse
        // with no type information and every type-aware rule silently skips them.
        project: ['./tsconfig.json', './tsconfig.test.json'],
        tsconfigRootDir: import.meta.dirname,
      },
      globals: { ...globals.node },
    },
    rules: {
      // The rules this config exists for.
      '@typescript-eslint/no-floating-promises': 'error',
      '@typescript-eslint/no-misused-promises': 'error',
      '@typescript-eslint/await-thenable': 'error',

      // Express handlers legitimately take unused `next`, and `_`-prefixed params are the
      // established convention in this codebase (see middleware/error-handler.ts).
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrors: 'none' },
      ],

      // Prisma and Stripe payloads are legitimately `any` at the boundary; the DTO mappers
      // and response-contract middleware are what constrain them. Warn rather than error so
      // the signal stays useful.
      '@typescript-eslint/no-unsafe-assignment': 'warn',
      '@typescript-eslint/no-unsafe-member-access': 'warn',
      '@typescript-eslint/no-unsafe-argument': 'warn',
      '@typescript-eslint/no-unsafe-call': 'warn',
      '@typescript-eslint/no-unsafe-return': 'warn',

      // `require-await` fires on async route handlers that only ever return, which is a
      // normal Express shape here.
      '@typescript-eslint/require-await': 'off',
      // Template literals carrying numbers/ids are pervasive and intentional.
      '@typescript-eslint/restrict-template-expressions': 'off',
    },
  },
  {
    // Plain JS — this config, and the dependency-free .mjs gate scripts — is in no tsconfig,
    // so type-aware rules have no program to work from and would fail to parse.
    files: ['**/*.js', '**/*.mjs'],
    ...tseslint.configs.disableTypeChecked,
  },
  {
    // Scripts and tests run once and exit; a floating promise there is not a leak.
    files: ['scripts/**/*.ts', 'tests/**/*.ts', 'prisma/seed.ts'],
    rules: {
      '@typescript-eslint/no-floating-promises': 'warn',
    },
  },
);
