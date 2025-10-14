/**
 * Mock implementation of persona module for testing.
 * 
 * Provides default persona mock behavior for tests that don't need complex
 * persona interactions. Tests needing custom persona behavior (e.g., different
 * responses per persona, specific error scenarios) should use inline vi.mock()
 * with factory functions.
 * 
 * Usage in test files:
 *   vi.mock('../src/agents/persona.js');  // Uses this mock with defaults
 * 
 * To override in a specific test:
 *   import * as persona from '../src/agents/persona.js';
 *   vi.mocked(persona.sendPersonaRequest).mockResolvedValueOnce('custom-corr-id');
 * 
 * Note: Tests with complex persona logic (conditional responses, multiple personas)
 * should keep inline mocks for clarity.
 */
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
