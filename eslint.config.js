import js from '@eslint/js';
import tseslint from '@typescript-eslint/eslint-plugin';
import tsparser from '@typescript-eslint/parser';
import globals from 'globals';
import noComments from 'eslint-plugin-no-comments';

export default [
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
      'no-comments': noComments,
    },
    rules: {
      ...js.configs.recommended.rules,
      ...tseslint.configs.recommended.rules,
      '@typescript-eslint/no-explicit-any': 'off',
      '@typescript-eslint/no-unused-vars': ['warn', { 
        argsIgnorePattern: '^_', 
        varsIgnorePattern: '^_',
        caughtErrors: 'none',
      }],
      'no-empty': 'warn',
      'no-useless-escape': 'warn',
      '@typescript-eslint/ban-ts-comment': 'error',
      'no-comments/disallowComments': 'error',
    },
  },
  
  {
    ignores: [
      'dist/',
      'node_modules/',
      '**/node_modules/',
      'outputs/',
      'projects/',
      'true/',
      'coverage/',
      '*.log',
      'src/dashboard-backend/',
    ],
  },
];
