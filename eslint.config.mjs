import js from '@eslint/js'
import tseslint from 'typescript-eslint'

// Type-aware linting: the rules that actually catch bugs here (floating promises,
// unnecessary conditions, unsafe argument types) all need the type checker, so the
// project service is on rather than running the syntax-only preset.
export default tseslint.config(
  {
    ignores: [
      'bin/**',
      'node_modules/**',
      'server/.vercel/**',
      'playwright-report/**',
      'test-results/**',
      // Its own config file: linting it type-aware would need it inside the
      // TypeScript project, which it is not.
      'eslint.config.mjs'
    ]
  },
  js.configs.recommended,
  ...tseslint.configs.recommendedTypeChecked,
  {
    languageOptions: {
      parserOptions: {
        // The build's tsconfig only covers src/ and excludes tests, so linting
        // leans on a wider one rather than loosening what the build compiles.
        project: './tsconfig.eslint.json',
        tsconfigRootDir: import.meta.dirname
      }
    },
    rules: {
      // The scene deliberately fires network calls without awaiting them so play
      // never blocks on the record store; those are marked with `void` at the call
      // site, which this rule accepts.
      '@typescript-eslint/no-floating-promises': 'error',
      '@typescript-eslint/no-misused-promises': 'error',
      '@typescript-eslint/no-unnecessary-condition': 'warn',
      '@typescript-eslint/switch-exhaustiveness-check': 'error',
      // Empty catch blocks are a design choice here (offline must degrade silently),
      // but each one carries a comment explaining why.
      'no-empty': ['error', { allowEmptyCatch: true }]
    }
  },
  {
    // The endpoint is a separate deploy unit, and Playwright specs run in Node
    // rather than the scene runtime.
    files: ['server/**/*.ts', 'e2e/**/*.ts', 'playwright.config.ts'],
    rules: {
      '@typescript-eslint/no-unnecessary-condition': 'off'
    }
  },
  {
    // Build scripts run in Node, not in the scene runtime, so they need Node's
    // globals declared rather than inherited from the DCL type package.
    files: ['scripts/**/*.mjs'],
    languageOptions: {
      globals: { console: 'readonly', process: 'readonly', URL: 'readonly' }
    }
  },
  {
    // node:test's test() returns a promise that is never meant to be awaited;
    // flagging every case here would train us to ignore the rule everywhere else.
    files: ['src/**/*.test.ts'],
    rules: {
      '@typescript-eslint/no-floating-promises': 'off'
    }
  }
)
