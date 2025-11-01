
import { vi } from 'vitest';

export const sendPersonaRequest = vi.fn().mockResolvedValue('mock-corr-id');

export const waitForPersonaCompletion = vi.fn().mockResolvedValue({
  id: 'mock-event-id',
  fields: {
    result: JSON.stringify({
      status: 'success',
      normalizedStatus: 'pass'
    })
  }
});

export const parseEventResult = vi.fn().mockImplementation((event) => {
  if (event && event.fields && event.fields.result) {
    return JSON.parse(event.fields.result);
  }
  return { status: 'pass' };
});
