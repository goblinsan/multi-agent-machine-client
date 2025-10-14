/**
 * Mock implementation of redisClient for testing.
 * 
 * Vitest/Jest automatically uses this mock when vi.mock('../src/redisClient.js') is called
 * without a factory function. This provides a single source of truth for Redis mocking
 * across all test files.
 * 
 * Usage in test files:
 *   vi.mock('../src/redisClient.js');  // That's it! Uses this mock automatically
 * 
 * Note: Some tests may need custom Redis mock behavior (e.g., workflowSteps.test.ts
 * needs specific xReadGroup return values). Those tests should use inline vi.mock()
 * with a factory function instead of this shared mock.
 */
import { vi } from 'vitest';

export const makeRedis = vi.fn().mockResolvedValue({
  xGroupCreate: vi.fn().mockResolvedValue(null),
  xReadGroup: vi.fn().mockResolvedValue([]),
  xAck: vi.fn().mockResolvedValue(null),
  xRange: vi.fn().mockResolvedValue([]),
  xDel: vi.fn().mockResolvedValue(0),
  disconnect: vi.fn().mockResolvedValue(null),
  quit: vi.fn().mockResolvedValue(null),
  xRevRange: vi.fn().mockResolvedValue([]),
  xAdd: vi.fn().mockResolvedValue('test-id'),
  exists: vi.fn().mockResolvedValue(1)
});
