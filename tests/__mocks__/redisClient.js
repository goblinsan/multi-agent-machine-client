
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
