import { defineConfig } from 'vitest/config';
import path from 'path';

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts', 'tests/**/*.test.tsx'],
    environment: 'node',
    globals: false,
    dir: path.resolve(process.cwd()),
    setupFiles: [path.resolve(process.cwd(), 'tests/setup.ts')],
  },
});
