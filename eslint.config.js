import js from '@eslint/js';
import tseslint from '@typescript-eslint/eslint-plugin';
import tsparser from '@typescript-eslint/parser';
import globals from 'globals';

export default [
  // Apply to all TypeScript files
  {
    files: ['**/*.ts', '**/*.tsx'],
    languageOptions: {
      parser: tsparser,
      parserOptions: {
        sourceType: 'module',
        ecmaVersion: 'latest',
      },
      globals: {
        ...globals.node,
        ...globals.es2021,
      },
    },
    plugins: {
      '@typescript-eslint': tseslint,
    },
    rules: {
      ...js.configs.recommended.rules,
      ...tseslint.configs.recommended.rules,
      // Keep rules light to avoid noisy CI; tighten later if desired
      '@typescript-eslint/no-explicit-any': 'off',
      '@typescript-eslint/no-unused-vars': ['warn', { 
        argsIgnorePattern: '^_', 
        varsIgnorePattern: '^_',
        caughtErrors: 'none',  // Don't warn about unused catch bindings
      }],
      'no-empty': 'warn',  // Empty catch blocks are common for error suppression
      'no-useless-escape': 'warn',  // Can be fixed later
      '@typescript-eslint/ban-ts-comment': 'warn',  // Warn instead of error
    },
  },
  // Ignore patterns
  {
    ignores: [
      'dist/',
      'node_modules/',
      'outputs/',
      'projects/',
      'true/',
      'coverage/',
      '*.log',
    ],
  },
];
