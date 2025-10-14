/**
 * Mock implementation of process module for testing.
 * 
 * Provides standard persona request processing mocks. Most tests don't need
 * actual LLM calls, just successful processing results.
 * 
 * Usage in test files:
 *   vi.mock('../src/process.js');  // Uses this mock
 * 
 * To customize processing results:
 *   import * as process from '../src/process.js';
 *   vi.mocked(process.processPersonaRequest).mockResolvedValueOnce({ ...custom result... });
 */
import { vi } from 'vitest';

export const processPersonaRequest = vi.fn().mockResolvedValue({
  status: 'success',
  result: { message: 'Mock processing complete' }
});
