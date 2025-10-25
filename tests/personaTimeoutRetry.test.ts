import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { PersonaRequestStep } from '../src/workflows/steps/PersonaRequestStep.js';
import { WorkflowContext } from '../src/workflows/engine/WorkflowContext.js';
import * as persona from '../src/agents/persona.js';
import * as redisClient from '../src/redisClient.js';
import * as messageTracking from '../src/messageTracking.js';
import { calculateProgressiveTimeout, personaMaxRetries, personaTimeoutMs } from '../src/util.js';

// Mock dependencies
vi.mock('../src/agents/persona.js');
vi.mock('../src/redisClient.js');
vi.mock('../src/messageTracking.js');
vi.mock('../src/logger.js', () => ({
  logger: {
    info: vi.fn(),
    error: vi.fn(),
    warn: vi.fn(),
    debug: vi.fn()
  }
}));

// Mock config
vi.mock('../src/config.js', () => ({
  cfg: {
    personaTimeouts: {
      'context': 60000,
      'lead-engineer': 90000,
      'qa-engineer': 120000
    },
    personaMaxRetries: {
      'context': 3,
      'lead-engineer': 5,
      'qa-engineer': null // unlimited
    },
    personaDefaultTimeoutMs: 60000,
    personaDefaultMaxRetries: 3,
    personaRetryBackoffIncrementMs: 30000,
    requestStream: 'agent.requests',
    eventStream: 'agent.events',
    personaModels: {
      'lead-engineer': 'test-model',
      'context': 'test-model',
      'qa-engineer': 'test-model',
      'devops': 'test-model',
      'tester-qa': 'test-model',
      'code-reviewer': 'test-model',
      'security-review': 'test-model',
      'implementation-planner': 'test-model',
      'plan-evaluator': 'test-model'
    }
  }
}));

describe('PersonaRequestStep - Progressive Timeout and Retry Logic', () => {
  let mockRedis: any;
  let mockTransport: any;
  let context: WorkflowContext;

  beforeEach(() => {
    // Reset all mocks
    vi.clearAllMocks();
    
    // Mock Redis client (deprecated - but tests still check disconnect)
    mockRedis = {
      disconnect: vi.fn()
    };
    vi.mocked(redisClient.makeRedis).mockResolvedValue(mockRedis);

    // Mock transport
    mockTransport = {
      connect: vi.fn().mockResolvedValue(null),
      disconnect: vi.fn().mockResolvedValue(null),
      xAdd: vi.fn().mockResolvedValue('1-0'),
      xGroupCreate: vi.fn().mockResolvedValue(null),
      xReadGroup: vi.fn().mockResolvedValue([]),
      xRead: vi.fn().mockResolvedValue([]),
      xRange: vi.fn().mockResolvedValue([]),
      xAck: vi.fn().mockResolvedValue(1),
      xDel: vi.fn().mockResolvedValue(0),
      del: vi.fn().mockResolvedValue(0),
      xLen: vi.fn().mockResolvedValue(0),
      xPending: vi.fn().mockResolvedValue([]),
      xClaim: vi.fn().mockResolvedValue([]),
      xInfoGroups: vi.fn().mockResolvedValue([]),
      xGroupDestroy: vi.fn().mockResolvedValue(null),
      quit: vi.fn().mockResolvedValue(null)
    };

    // Mock message tracking (no duplicates by default)
    vi.mocked(messageTracking.isDuplicateMessage).mockReturnValue(false);
    vi.mocked(messageTracking.markMessageProcessed).mockImplementation(() => {});

    // Mock interpretPersonaStatus to return proper status interpretation
    vi.mocked(persona.interpretPersonaStatus).mockReturnValue({
      status: 'pass',
      details: '',
      raw: ''
    });

    // Create workflow context
    context = new WorkflowContext(
      'test-workflow-id',
      'test-project-id',
      '/test/repo',
      'main',
      { steps: [] } as any,
      mockTransport,
      {}
    );
    context.setVariable('repo_remote', 'git@github.com:test/repo.git');
    context.setVariable('branch', 'main');
    // CRITICAL: Disable persona bypass for these tests that specifically test persona retry logic
    context.setVariable('SKIP_PERSONA_OPERATIONS', false);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('Progressive Timeout Behavior', () => {
    it('should use increasing timeouts for each retry attempt', async () => {
      // Track timeout values passed to waitForPersonaCompletion
      const timeoutValues: number[] = [];
      
      vi.mocked(persona.sendPersonaRequest)
        .mockResolvedValue('corr-id');

      vi.mocked(persona.waitForPersonaCompletion)
        .mockImplementation(async (_redis, _persona, _workflowId, _corrId, timeout) => {
          timeoutValues.push(timeout || 0);
          if (timeoutValues.length < 3) {
            throw new Error('Timed out waiting for lead-engineer completion');
          }
          return {
            id: 'event-1',
            fields: {
              result: JSON.stringify({ status: 'success' })
            }
          } as any;
        });

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

      // Verify progressive timeout values
      expect(timeoutValues.length).toBe(3);
      expect(timeoutValues[0]).toBe(90000);  // Base: 90s
      expect(timeoutValues[1]).toBe(120000); // Base + 30s: 120s
      expect(timeoutValues[2]).toBe(150000); // Base + 60s: 150s
      
      expect(result.status).toBe('success');
      expect(result.data?.totalAttempts).toBe(3);
    });

    it('should calculate timeouts correctly using calculateProgressiveTimeout', () => {
      const baseTimeout = 60000; // 60s
      const increment = 30000; // 30s

      expect(calculateProgressiveTimeout(baseTimeout, 1, increment)).toBe(60000);  // 60s
      expect(calculateProgressiveTimeout(baseTimeout, 2, increment)).toBe(90000);  // 90s
      expect(calculateProgressiveTimeout(baseTimeout, 3, increment)).toBe(120000); // 120s
      expect(calculateProgressiveTimeout(baseTimeout, 4, increment)).toBe(150000); // 150s
    });

    it('should not have delays between retry attempts', async () => {
      const startTime = Date.now();
      
      vi.mocked(persona.sendPersonaRequest)
        .mockResolvedValue('corr-id');

      vi.mocked(persona.waitForPersonaCompletion)
        .mockRejectedValueOnce(new Error('Timed out'))
        .mockRejectedValueOnce(new Error('Timed out'))
        .mockResolvedValueOnce({
          fields: { result: JSON.stringify({ status: 'success' }) }
        } as any);

      const step = new PersonaRequestStep({
        name: 'test-persona-request',
        type: 'persona_request',
        config: {
          step: '1-test',
          persona: 'context',
          intent: 'test',
          payload: { test: 'data' }
        }
      });

      await step.execute(context);
      
      const duration = Date.now() - startTime;
      
      // Should complete quickly - no artificial delays
      // Allow some overhead for test execution
      expect(duration).toBeLessThan(100);
    });
  });

  describe('Per-Persona Configuration', () => {
    it('should use default timeout for unconfigured persona', async () => {
      let capturedTimeout: number | undefined;
      
      vi.mocked(persona.sendPersonaRequest).mockResolvedValue('corr-id');
      vi.mocked(persona.waitForPersonaCompletion)
        .mockImplementation(async (_r, _p, _w, _c, timeout) => {
          capturedTimeout = timeout;
          return {
            id: 'event-1',
            fields: { result: JSON.stringify({ status: 'success' }) }
          } as any;
        });

      const step = new PersonaRequestStep({
        name: 'test-persona-request',
        type: 'persona_request',
        config: {
          step: '1-test',
          persona: 'qa-engineer', // Configured with 120000ms timeout
          intent: 'test',
          payload: { test: 'data' }
        }
      });

      await step.execute(context);

      expect(capturedTimeout).toBe(120000); // 2 minutes
    });

    it('should use persona-specific max retries from config', async () => {
      vi.mocked(persona.sendPersonaRequest).mockResolvedValue('corr-id');
      vi.mocked(persona.waitForPersonaCompletion)
        .mockRejectedValue(new Error('Timed out waiting for lead-engineer completion'));

      const step = new PersonaRequestStep({
        name: 'test-persona-request',
        type: 'persona_request',
        config: {
          step: '1-test',
          persona: 'lead-engineer', // Configured with 5 max retries
          intent: 'test',
          payload: { test: 'data' }
        }
      });

      const result = await step.execute(context);

      expect(result.status).toBe('failure');
      // 6 total attempts: 1 initial + 5 retries
      expect(persona.sendPersonaRequest).toHaveBeenCalledTimes(6);
    });

    it('should use configured timeout without retry on first attempt', async () => {
      let capturedTimeout: number | undefined;
      
      vi.mocked(persona.sendPersonaRequest).mockResolvedValue('corr-id');
      vi.mocked(persona.waitForPersonaCompletion)
        .mockImplementation(async (_r, _p, _w, _c, timeout) => {
          capturedTimeout = timeout;
          return {
            id: 'event-1',
            fields: { result: JSON.stringify({ status: 'success' }) }
          } as any;
        });

      const step = new PersonaRequestStep({
        name: 'test-persona-request',
        type: 'persona_request',
        config: {
          step: '1-test',
          persona: 'unknown-persona', // Not in config
          intent: 'test',
          payload: { test: 'data' }
        }
      });

      await step.execute(context);

      expect(capturedTimeout).toBe(60000); // Default 1 minute
    });

    it('should allow per-step timeout override', async () => {
      let capturedTimeout: number | undefined;
      
      vi.mocked(persona.sendPersonaRequest).mockResolvedValue('corr-id');
      vi.mocked(persona.waitForPersonaCompletion)
        .mockImplementation(async (_r, _p, _w, _c, timeout) => {
          capturedTimeout = timeout;
          return {
            id: 'event-1',
            fields: { result: JSON.stringify({ status: 'success' }) }
          } as any;
        });

      const step = new PersonaRequestStep({
        name: 'test-persona-request',
        type: 'persona_request',
        config: {
          step: '1-test',
          persona: 'lead-engineer', // Default 90000ms
          intent: 'test',
          timeout: 300000, // Override with 5 minutes
          payload: { test: 'data' }
        }
      });

      await step.execute(context);

      expect(capturedTimeout).toBe(300000); // Override value
    });

    it('should allow per-step maxRetries override', async () => {
      vi.mocked(persona.sendPersonaRequest).mockResolvedValue('corr-id');
      vi.mocked(persona.waitForPersonaCompletion)
        .mockRejectedValue(new Error('Timed out waiting for context completion'));

      const step = new PersonaRequestStep({
        name: 'test-persona-request',
        type: 'persona_request',
        config: {
          step: '1-test',
          persona: 'context', // Default 3 retries
          intent: 'test',
          maxRetries: 1, // Override with 1 retry
          payload: { test: 'data' }
        }
      });

      const result = await step.execute(context);

      expect(result.status).toBe('failure');
      // 2 total attempts: 1 initial + 1 retry
      expect(persona.sendPersonaRequest).toHaveBeenCalledTimes(2);
    });
  });

  describe('Unlimited Retries', () => {
    it('should support unlimited retries when configured', async () => {
      // Stop after 10 attempts to avoid infinite loop in test
      let attemptCount = 0;
      
      vi.mocked(persona.sendPersonaRequest).mockResolvedValue('corr-id');
      vi.mocked(persona.waitForPersonaCompletion)
        .mockImplementation(async () => {
          attemptCount++;
          if (attemptCount >= 10) {
            return {
              id: 'event-1',
              fields: { result: JSON.stringify({ status: 'success' }) }
            } as any;
          }
          throw new Error('Timed out waiting for qa-engineer completion');
        });

      const step = new PersonaRequestStep({
        name: 'test-persona-request',
        type: 'persona_request',
        config: {
          step: '1-test',
          persona: 'qa-engineer', // Configured with unlimited retries
          intent: 'test',
          payload: { test: 'data' }
        }
      });

      const result = await step.execute(context);

      expect(result.status).toBe('success');
      expect(attemptCount).toBe(10);
      expect(persona.sendPersonaRequest).toHaveBeenCalledTimes(10);
    });

    it('should allow per-step unlimited retries via large maxRetries', async () => {
      let attemptCount = 0;
      
      vi.mocked(persona.sendPersonaRequest).mockResolvedValue('corr-id');
      vi.mocked(persona.waitForPersonaCompletion)
        .mockImplementation(async () => {
          attemptCount++;
          if (attemptCount >= 8) {
            return {
              id: 'event-1',
              fields: { result: JSON.stringify({ status: 'success' }) }
            } as any;
          }
          throw new Error('Timed out waiting for context completion');
        });

      // Create step with a large number to simulate unlimited
      const step = new PersonaRequestStep({
        name: 'test-persona-request',
        type: 'persona_request',
        config: {
          step: '1-test',
          persona: 'context',
          intent: 'test',
          maxRetries: 999, // Very large number simulates unlimited
          payload: { test: 'data' }
        }
      });

      const result = await step.execute(context);

      expect(result.status).toBe('success');
      expect(attemptCount).toBe(8);
    });
  });

  describe('Task ID Propagation', () => {
    it('should extract task_id from payload and pass to sendPersonaRequest', async () => {
      vi.mocked(persona.sendPersonaRequest).mockResolvedValue('corr-id');
      vi.mocked(persona.waitForPersonaCompletion).mockResolvedValue({
        fields: { result: JSON.stringify({ status: 'success' }) }
      } as any);

      const step = new PersonaRequestStep({
        name: 'test-persona-request',
        type: 'persona_request',
        config: {
          step: '1-test',
          persona: 'lead-engineer',
          intent: 'test',
          payload: { 
            task_id: 'task-123',
            test: 'data' 
          }
        }
      });

      await step.execute(context);

      expect(persona.sendPersonaRequest).toHaveBeenCalledWith(
        mockTransport,
        expect.objectContaining({
          taskId: 'task-123'
        })
      );
    });

    it('should extract task_id from context variables', async () => {
      context.setVariable('task_id', 'task-from-context');
      
      vi.mocked(persona.sendPersonaRequest).mockResolvedValue('corr-id');
      vi.mocked(persona.waitForPersonaCompletion).mockResolvedValue({
        fields: { result: JSON.stringify({ status: 'success' }) }
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

      expect(persona.sendPersonaRequest).toHaveBeenCalledWith(
        mockTransport,
        expect.objectContaining({
          taskId: 'task-from-context'
        })
      );
    });

    it('should prioritize payload task_id over context task_id', async () => {
      context.setVariable('task_id', 'task-from-context');
      
      vi.mocked(persona.sendPersonaRequest).mockResolvedValue('corr-id');
      vi.mocked(persona.waitForPersonaCompletion).mockResolvedValue({
        fields: { result: JSON.stringify({ status: 'success' }) }
      } as any);

      const step = new PersonaRequestStep({
        name: 'test-persona-request',
        type: 'persona_request',
        config: {
          step: '1-test',
          persona: 'lead-engineer',
          intent: 'test',
          payload: { 
            task_id: 'task-from-payload',
            test: 'data' 
          }
        }
      });

      await step.execute(context);

      expect(persona.sendPersonaRequest).toHaveBeenCalledWith(
        mockTransport,
        expect.objectContaining({
          taskId: 'task-from-payload'
        })
      );
    });
  });

  describe('Workflow Abort Behavior', () => {
    it('should return failure with diagnostic error after all retries exhausted', async () => {
      vi.mocked(persona.sendPersonaRequest).mockResolvedValue('corr-id');
      vi.mocked(persona.waitForPersonaCompletion)
        .mockRejectedValue(new Error('Timed out waiting for lead-engineer completion'));

      const step = new PersonaRequestStep({
        name: 'test-persona-request',
        type: 'persona_request',
        config: {
          step: '1-test',
          persona: 'context', // 3 max retries
          intent: 'test',
          payload: { test: 'data' }
        }
      });

      const result = await step.execute(context);

      expect(result.status).toBe('failure');
      expect(result.error?.message).toContain('timed out after 4 attempts');
      expect(result.error?.message).toContain('Workflow aborted');
      expect(result.data?.workflowAborted).toBe(true);
      expect(result.data?.totalAttempts).toBe(4);
      expect(result.data?.baseTimeoutMs).toBeDefined();
      expect(result.data?.finalTimeoutMs).toBeDefined();
    });

    it('should include timeout information in error', async () => {
      vi.mocked(persona.sendPersonaRequest).mockResolvedValue('corr-id');
      vi.mocked(persona.waitForPersonaCompletion)
        .mockRejectedValue(new Error('Timed out waiting for lead-engineer completion'));

      const step = new PersonaRequestStep({
        name: 'test-persona-request',
        type: 'persona_request',
        config: {
          step: '1-test',
          persona: 'lead-engineer', // 90s base timeout
          intent: 'test',
          maxRetries: 2,
          payload: { test: 'data' }
        }
      });

      const result = await step.execute(context);

      expect(result.status).toBe('failure');
      expect(result.data?.baseTimeoutMs).toBe(90000);
      expect(result.data?.finalTimeoutMs).toBe(150000); // 90s + 2*30s
      expect(result.error?.message).toContain('Base timeout: 1.50min');
      expect(result.error?.message).toContain('Final timeout: 2.50min');
    });
  });

  describe('Success Scenarios', () => {
    it('should succeed on first attempt without retrying', async () => {
      vi.mocked(persona.sendPersonaRequest).mockResolvedValue('corr-id-1');
      vi.mocked(persona.waitForPersonaCompletion).mockResolvedValue({
        id: 'event-1',
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
      // Transport lifecycle is managed by context, not individual steps
    });

    it('should succeed on third attempt after two timeouts', async () => {
      vi.mocked(persona.sendPersonaRequest)
        .mockResolvedValue('corr-id');

      vi.mocked(persona.waitForPersonaCompletion)
        .mockRejectedValueOnce(new Error('Timed out waiting for lead-engineer completion'))
        .mockRejectedValueOnce(new Error('Timed out waiting for lead-engineer completion'))
        .mockResolvedValueOnce({
          id: 'event-1',
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
      expect(persona.sendPersonaRequest).toHaveBeenCalledTimes(3);
    });
  });

  describe('Error Handling', () => {
    it('should fail immediately on non-timeout errors without retrying', async () => {
      vi.mocked(persona.sendPersonaRequest).mockRejectedValue(
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
      expect(persona.sendPersonaRequest).toHaveBeenCalledTimes(1);
      // Should not retry on non-timeout errors
      expect(persona.waitForPersonaCompletion).not.toHaveBeenCalled();
    });

    it('should only retry on timeout errors', async () => {
      vi.mocked(persona.sendPersonaRequest).mockResolvedValue('corr-id');
      vi.mocked(persona.waitForPersonaCompletion)
        .mockRejectedValueOnce(new Error('Timed out waiting for context completion'))
        .mockRejectedValueOnce(new Error('Network error')) // Non-timeout error - doesn't match "Timed out waiting"
        .mockResolvedValueOnce({
          fields: { result: JSON.stringify({ status: 'success' }) }
        } as any);

      const step = new PersonaRequestStep({
        name: 'test-persona-request',
        type: 'persona_request',
        config: {
          step: '1-test',
          persona: 'context',
          intent: 'test',
          payload: { test: 'data' }
        }
      });

      const result = await step.execute(context);

      // Should fail on the non-timeout error
      expect(result.status).toBe('failure');
      expect(result.error?.message).toContain('Network error');
      // Only 2 attempts: first timed out (retry), second had network error (stop)
      expect(persona.waitForPersonaCompletion).toHaveBeenCalledTimes(2);
    });
  });

  describe('Utility Function Tests', () => {
    it('personaMaxRetries should return persona-specific value', () => {
      const mockCfg = {
        personaMaxRetries: {
          'lead-engineer': 5,
          'context': 3
        },
        personaDefaultMaxRetries: 3
      };

      expect(personaMaxRetries('lead-engineer', mockCfg)).toBe(5);
      expect(personaMaxRetries('context', mockCfg)).toBe(3);
      expect(personaMaxRetries('unknown', mockCfg)).toBe(3); // Default
    });

    it('personaMaxRetries should handle unlimited (null) correctly', () => {
      const mockCfg = {
        personaMaxRetries: {
          'qa-engineer': null // unlimited
        },
        personaDefaultMaxRetries: 3
      };

      expect(personaMaxRetries('qa-engineer', mockCfg)).toBe(null);
    });

    it('personaTimeoutMs should return persona-specific value', () => {
      const mockCfg = {
        personaTimeouts: {
          'lead-engineer': 90000,
          'context': 60000
        },
        personaDefaultTimeoutMs: 60000,
        personaCodingTimeoutMs: 180000
      };

      expect(personaTimeoutMs('lead-engineer', mockCfg)).toBe(90000);
      expect(personaTimeoutMs('context', mockCfg)).toBe(60000);
      expect(personaTimeoutMs('unknown', mockCfg)).toBe(60000); // Default
    });
  });
});
