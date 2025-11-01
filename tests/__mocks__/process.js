
import { vi } from 'vitest';

export const processPersonaRequest = vi.fn().mockResolvedValue({
  status: 'success',
  result: { message: 'Mock processing complete' }
});
