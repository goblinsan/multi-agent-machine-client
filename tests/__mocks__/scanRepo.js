/**
 * Mock implementation of scanRepo for testing.
 * 
 * Provides a standard repository scan result for tests. Most tests don't need
 * actual file scanning, just a representative result.
 * 
 * Usage in test files:
 *   vi.mock('../src/scanRepo.js');  // Uses this mock
 * 
 * To customize scan results in a test:
 *   import * as scanRepo from '../src/scanRepo.js';
 *   vi.mocked(scanRepo.scanRepo).mockResolvedValueOnce([...custom files...]);
 */
import { vi } from 'vitest';

export const scanRepo = vi.fn().mockResolvedValue([
  { path: 'src/main.ts', bytes: 1024, lines: 50, mtime: Date.now() },
  { path: 'src/utils.ts', bytes: 512, lines: 25, mtime: Date.now() },
  { path: 'package.json', bytes: 256, lines: 15, mtime: Date.now() }
]);
