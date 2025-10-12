import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { PersonaRequestStep } from '../src/workflows/steps/PersonaRequestStep.js';
import { WorkflowContext } from '../src/workflows/engine/WorkflowContext.js';
import * as persona from '../src/agents/persona.js';
import * as redisClient from '../src/redisClient.js';

// Mock dependencies
vi.mock('../src/agents/persona.js');
vi.mock('../src/redisClient.js');
vi.mock('../src/logger.js', () => ({
  logger: {
    info: vi.fn(),
    error: vi.fn(),
    warn: vi.fn(),
    debug: vi.fn()
  }
}));

describe('PersonaRequestStep - Timeout Retry Logic', () => {
  let mockRedis: any;
  let context: WorkflowContext;

  beforeEach(() => {
    // Reset all mocks
    vi.clearAllMocks();

    // Mock Redis client
    mockRedis = {
      disconnect: vi.fn()
    };
    vi.mocked(redisClient.makeRedis).mockResolvedValue(mockRedis);

    // Create workflow context
    context = new WorkflowContext(
      'test-workflow-id',
      'test-project-id',
      '/test/repo',
      'main',
      { steps: [] } as any,
      {}
    );
    context.setVariable('repo_remote', 'git@github.com:test/repo.git');
    context.setVariable('branch', 'main');
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('Retry on Timeout', () => {
    it('should retry when persona request times out and succeed on second attempt', async () => {
      // Mock sendPersonaRequest to return correlation IDs
      vi.mocked(persona.sendPersonaRequest)
        .mockResolvedValueOnce('corr-id-1')
        .mockResolvedValueOnce('corr-id-2');

      // Mock waitForPersonaCompletion: first call timeout (throws), second call success
      vi.mocked(persona.waitForPersonaCompletion)
        .mockRejectedValueOnce(new Error('Timed out waiting for lead-engineer completion')) // Timeout on first attempt
        .mockResolvedValueOnce({ // Success on second attempt
          fields: {
            result: JSON.stringify({ status: 'success', output: 'test result' })
          }
        } as any);

      const step = new PersonaRequestStep({
        name: 'test-persona-request',
        type: 'persona_request',
        config: {
          step: '1-test',
          persona: 'lead-engineer',
          intent: 'test',
          payload: { test: 'data' }
        }
      });

      const result = await step.execute(context);

      expect(result.status).toBe('success');
      expect(result.data?.totalAttempts).toBe(2);
      expect(persona.sendPersonaRequest).toHaveBeenCalledTimes(2);
      expect(persona.waitForPersonaCompletion).toHaveBeenCalledTimes(2);
      expect(mockRedis.disconnect).toHaveBeenCalledTimes(1);
    });

    it('should respect default max retries (3) and fail after exhausting attempts', async () => {
      // Mock sendPersonaRequest to return correlation IDs
      vi.mocked(persona.sendPersonaRequest)
        .mockResolvedValueOnce('corr-id-1')
        .mockResolvedValueOnce('corr-id-2')
        .mockResolvedValueOnce('corr-id-3')
        .mockResolvedValueOnce('corr-id-4');

      // Mock all attempts to timeout
      vi.mocked(persona.waitForPersonaCompletion)
        .mockRejectedValue(new Error('Timed out waiting for lead-engineer completion'));

      const step = new PersonaRequestStep({
        name: 'test-persona-request',
        type: 'persona_request',
        config: {
          step: '1-test',
          persona: 'lead-engineer',
          intent: 'test',
          payload: { test: 'data' }
        }
      });

      const result = await step.execute(context);

      expect(result.status).toBe('failure');
      expect(result.data?.totalAttempts).toBe(4); // Initial attempt + 3 retries
      expect(result.error?.message).toContain('timed out after 4 attempts');
      expect(persona.sendPersonaRequest).toHaveBeenCalledTimes(4);
      expect(persona.waitForPersonaCompletion).toHaveBeenCalledTimes(4);
      expect(mockRedis.disconnect).toHaveBeenCalledTimes(1);
    });

    it('should succeed on first attempt without retrying', async () => {
      // Mock sendPersonaRequest
      vi.mocked(persona.sendPersonaRequest).mockResolvedValueOnce('corr-id-1');

      // Mock immediate success
      vi.mocked(persona.waitForPersonaCompletion).mockResolvedValueOnce({
        fields: {
          result: JSON.stringify({ status: 'success', output: 'test result' })
        }
      } as any);

      const step = new PersonaRequestStep({
        name: 'test-persona-request',
        type: 'persona_request',
        config: {
          step: '1-test',
          persona: 'lead-engineer',
          intent: 'test',
          payload: { test: 'data' }
        }
      });

      const result = await step.execute(context);

      expect(result.status).toBe('success');
      expect(result.data?.totalAttempts).toBe(1);
      expect(persona.sendPersonaRequest).toHaveBeenCalledTimes(1);
      expect(persona.waitForPersonaCompletion).toHaveBeenCalledTimes(1);
      expect(mockRedis.disconnect).toHaveBeenCalledTimes(1);
    });

    it('should succeed on third attempt after two timeouts', async () => {
      // Mock sendPersonaRequest to return correlation IDs
      vi.mocked(persona.sendPersonaRequest)
        .mockResolvedValueOnce('corr-id-1')
        .mockResolvedValueOnce('corr-id-2')
        .mockResolvedValueOnce('corr-id-3');

      // Mock: timeout, timeout, success
      vi.mocked(persona.waitForPersonaCompletion)
        .mockRejectedValueOnce(new Error('Timed out waiting for lead-engineer completion'))
        .mockRejectedValueOnce(new Error('Timed out waiting for lead-engineer completion'))
        .mockResolvedValueOnce({
          fields: {
            result: JSON.stringify({ status: 'success', output: 'third time lucky' })
          }
        } as any);

      const step = new PersonaRequestStep({
        name: 'test-persona-request',
        type: 'persona_request',
        config: {
          step: '1-test',
          persona: 'lead-engineer',
          intent: 'test',
          payload: { test: 'data' }
        }
      });

      const result = await step.execute(context);

      expect(result.status).toBe('success');
      expect(result.data?.totalAttempts).toBe(3);
      expect(result.outputs?.output).toBe('third time lucky');
      expect(persona.sendPersonaRequest).toHaveBeenCalledTimes(3);
      expect(persona.waitForPersonaCompletion).toHaveBeenCalledTimes(3);
    });
  });

  describe('Per-Step Retry Override', () => {
    it('should respect custom maxRetries when specified in config', async () => {
      // Mock all attempts to timeout
      vi.mocked(persona.sendPersonaRequest)
        .mockResolvedValueOnce('corr-id-1')
        .mockResolvedValueOnce('corr-id-2');
      vi.mocked(persona.waitForPersonaCompletion)
        .mockRejectedValue(new Error('Timed out waiting for lead-engineer completion'));

      const step = new PersonaRequestStep({
        name: 'test-persona-request',
        type: 'persona_request',
        config: {
          step: '1-test',
          persona: 'lead-engineer',
          intent: 'test',
          payload: { test: 'data' },
          maxRetries: 1 // Override: only 1 retry instead of default 3
        }
      });

      const result = await step.execute(context);

      expect(result.status).toBe('failure');
      expect(result.data?.totalAttempts).toBe(2); // Initial attempt + 1 retry
      expect(persona.sendPersonaRequest).toHaveBeenCalledTimes(2);
      expect(persona.waitForPersonaCompletion).toHaveBeenCalledTimes(2);
    });

    it('should allow zero retries when maxRetries is 0', async () => {
      // Mock timeout on first attempt
      vi.mocked(persona.sendPersonaRequest).mockResolvedValueOnce('corr-id-1');
      vi.mocked(persona.waitForPersonaCompletion).mockRejectedValue(new Error('Timed out waiting for lead-engineer completion'));

      const step = new PersonaRequestStep({
        name: 'test-persona-request',
        type: 'persona_request',
        config: {
          step: '1-test',
          persona: 'lead-engineer',
          intent: 'test',
          payload: { test: 'data' },
          maxRetries: 0 // No retries
        }
      });

      const result = await step.execute(context);

      expect(result.status).toBe('failure');
      expect(result.data?.totalAttempts).toBe(1); // Only initial attempt
      expect(persona.sendPersonaRequest).toHaveBeenCalledTimes(1);
      expect(persona.waitForPersonaCompletion).toHaveBeenCalledTimes(1);
    });

    it('should allow higher retries than default when specified', async () => {
      // Mock all attempts to timeout
      const mockSendPersonaRequest = vi.mocked(persona.sendPersonaRequest);
      const mockWaitForPersonaCompletion = vi.mocked(persona.waitForPersonaCompletion);
      
      // Set up mocks for 6 attempts (1 initial + 5 retries)
      for (let i = 1; i <= 6; i++) {
        mockSendPersonaRequest.mockResolvedValueOnce(`corr-id-${i}`);
      }
      mockWaitForPersonaCompletion.mockRejectedValue(new Error('Timed out waiting for lead-engineer completion'));

      const step = new PersonaRequestStep({
        name: 'test-persona-request',
        type: 'persona_request',
        config: {
          step: '1-test',
          persona: 'lead-engineer',
          intent: 'test',
          payload: { test: 'data' },
          maxRetries: 5 // More than default
        }
      });

      const result = await step.execute(context);

      expect(result.status).toBe('failure');
      expect(result.data?.totalAttempts).toBe(6); // Initial attempt + 5 retries
      expect(persona.sendPersonaRequest).toHaveBeenCalledTimes(6);
      expect(persona.waitForPersonaCompletion).toHaveBeenCalledTimes(6);
    });
  });

  describe('Error Handling', () => {
    it('should fail immediately on non-timeout errors without retrying', async () => {
      // Mock sendPersonaRequest to throw an error
      vi.mocked(persona.sendPersonaRequest).mockRejectedValueOnce(
        new Error('Redis connection failed')
      );

      const step = new PersonaRequestStep({
        name: 'test-persona-request',
        type: 'persona_request',
        config: {
          step: '1-test',
          persona: 'lead-engineer',
          intent: 'test',
          payload: { test: 'data' }
        }
      });

      const result = await step.execute(context);

      expect(result.status).toBe('failure');
      expect(result.error?.message).toContain('Redis connection failed');
      // Should only be called once, not retried
      expect(persona.sendPersonaRequest).toHaveBeenCalledTimes(1);
      expect(persona.waitForPersonaCompletion).not.toHaveBeenCalled();
    });

    it('should validate maxRetries config parameter', async () => {
      const step = new PersonaRequestStep({
        name: 'test-persona-request',
        type: 'persona_request',
        config: {
          step: '1-test',
          persona: 'lead-engineer',
          intent: 'test',
          payload: { test: 'data' },
          maxRetries: -1 // Invalid: negative
        }
      });

      const validation = await step.validate(context);

      expect(validation.valid).toBe(false);
      expect(validation.errors).toContain(
        'PersonaRequestStep: maxRetries must be a non-negative number'
      );
    });
  });

  describe('Logging', () => {
    it('should log each retry attempt', async () => {
      const { logger } = await import('../src/logger.js');

      // Mock timeouts then success
      vi.mocked(persona.sendPersonaRequest)
        .mockResolvedValueOnce('corr-id-1')
        .mockResolvedValueOnce('corr-id-2')
        .mockResolvedValueOnce('corr-id-3');
      vi.mocked(persona.waitForPersonaCompletion)
        .mockRejectedValueOnce(new Error('Timed out waiting for lead-engineer completion'))
        .mockRejectedValueOnce(new Error('Timed out waiting for lead-engineer completion'))
        .mockResolvedValueOnce({
          fields: {
            result: JSON.stringify({ status: 'success' })
          }
        } as any);

      const step = new PersonaRequestStep({
        name: 'test-persona-request',
        type: 'persona_request',
        config: {
          step: '1-test',
          persona: 'lead-engineer',
          intent: 'test',
          payload: { test: 'data' }
        }
      });

      await step.execute(context);

      // Check that retry logs were created
      expect(logger.info).toHaveBeenCalledWith(
        'Retrying persona request after timeout',
        expect.objectContaining({
          attempt: 2,
          persona: 'lead-engineer'
        })
      );
      expect(logger.info).toHaveBeenCalledWith(
        'Retrying persona request after timeout',
        expect.objectContaining({
          attempt: 3,
          persona: 'lead-engineer'
        })
      );

      // Check that timeout warnings were logged
      expect(logger.warn).toHaveBeenCalledWith(
        'Persona request timed out, will retry',
        expect.objectContaining({
          attempt: 1,
          persona: 'lead-engineer'
        })
      );
      expect(logger.warn).toHaveBeenCalledWith(
        'Persona request timed out, will retry',
        expect.objectContaining({
          attempt: 2,
          persona: 'lead-engineer'
        })
      );
    });

    it('should log final failure after all retries exhausted', async () => {
      const { logger } = await import('../src/logger.js');

      // Mock all attempts to timeout
      vi.mocked(persona.sendPersonaRequest)
        .mockResolvedValueOnce('corr-id-1')
        .mockResolvedValueOnce('corr-id-2');
      vi.mocked(persona.waitForPersonaCompletion)
        .mockRejectedValue(new Error('Timed out waiting for lead-engineer completion'));

      const step = new PersonaRequestStep({
        name: 'test-persona-request',
        type: 'persona_request',
        config: {
          step: '1-test',
          persona: 'lead-engineer',
          intent: 'test',
          payload: { test: 'data' },
          maxRetries: 1
        }
      });

      await step.execute(context);

      expect(logger.error).toHaveBeenCalledWith(
        'Persona request failed after all retries',
        expect.objectContaining({
          persona: 'lead-engineer',
          totalAttempts: 2
        })
      );
    });
  });
});
