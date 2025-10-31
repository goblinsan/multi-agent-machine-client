import { describe, it, expect, beforeEach, vi } from 'vitest';
import { WorkflowContext } from '../src/workflows/engine/WorkflowContext.js';
import { PersonaRequestStep } from '../src/workflows/steps/PersonaRequestStep.js';

// Mock persona operations
vi.mock('../src/agents/persona.js', () => ({
  sendPersonaRequest: vi.fn().mockResolvedValue('corr-123'),
  waitForPersonaCompletion: vi.fn().mockResolvedValue({
    id: 'event-1',
    fields: {
      result: JSON.stringify({ status: 'success' })
    }
  })
}));

describe('Conditional Step Execution', () => {
  let context: WorkflowContext;
  const mockTransport = {
    xAdd: vi.fn().mockResolvedValue('1-0'),
    disconnect: vi.fn().mockResolvedValue(null)
  } as any;

  beforeEach(() => {
    vi.clearAllMocks();
    
    context = new WorkflowContext(
      'test-workflow-id',
      'test-project-id',
      '/test/repo',
      'main',
      { name: 'test', version: '1.0', steps: [] },
      mockTransport,
      {}
    );
  });

  describe('Boolean inequality conditions', () => {
    it('should skip step when condition evaluates to false (reused_existing == true)', async () => {
      // Set up step output with reused_existing flag
      context.setStepOutput('context_scan', {
        reused_existing: true,
        fileCount: 10
      });

      const step = new PersonaRequestStep({
        name: 'context_request',
        type: 'PersonaRequestStep',
        condition: '${context_scan.reused_existing} != true',
        config: {
          persona: 'context',
          payload: {}
        }
      });

      const shouldExecute = await step.shouldExecute(context);
      expect(shouldExecute).toBe(false);
    });

    it('should execute step when condition evaluates to true (reused_existing == false)', async () => {
      // Set up step output with reused_existing flag
      context.setStepOutput('context_scan', {
        reused_existing: false,
        fileCount: 10
      });

      const step = new PersonaRequestStep({
        name: 'context_request',
        type: 'PersonaRequestStep',
        condition: '${context_scan.reused_existing} != true',
        config: {
          persona: 'context',
          payload: {}
        }
      });

      const shouldExecute = await step.shouldExecute(context);
      expect(shouldExecute).toBe(true);
    });

    it('should execute step when condition evaluates to true (reused_existing undefined)', async () => {
      // Set up step output WITHOUT reused_existing flag
      context.setStepOutput('context_scan', {
        fileCount: 10
      });

      const step = new PersonaRequestStep({
        name: 'context_request',
        type: 'PersonaRequestStep',
        condition: '${context_scan.reused_existing} != true',
        config: {
          persona: 'context',
          payload: {}
        }
      });

      const shouldExecute = await step.shouldExecute(context);
      expect(shouldExecute).toBe(true);
    });
  });

  describe('String equality conditions', () => {
    it('should skip step when string condition is false', async () => {
      context.setVariable('plan_status', 'fail');

      const step = new PersonaRequestStep({
        name: 'next_step',
        type: 'PersonaRequestStep',
        condition: "plan_status == 'pass'",
        config: {
          persona: 'lead-engineer',
          payload: {}
        }
      });

      const shouldExecute = await step.shouldExecute(context);
      expect(shouldExecute).toBe(false);
    });

    it('should execute step when string condition is true', async () => {
      context.setVariable('plan_status', 'pass');

      const step = new PersonaRequestStep({
        name: 'next_step',
        type: 'PersonaRequestStep',
        condition: "plan_status == 'pass'",
        config: {
          persona: 'lead-engineer',
          payload: {}
        }
      });

      const shouldExecute = await step.shouldExecute(context);
      expect(shouldExecute).toBe(true);
    });
  });

  describe('Dot notation in conditions', () => {
    it('should resolve step outputs with dot notation', async () => {
      context.setStepOutput('context_scan', {
        metadata: {
          fileCount: 10,
          totalBytes: 5000
        },
        reused_existing: false
      });

      const step = new PersonaRequestStep({
        name: 'test_step',
        type: 'PersonaRequestStep',
        condition: '${context_scan.reused_existing} == false',
        config: {
          persona: 'context',
          payload: {}
        }
      });

      const shouldExecute = await step.shouldExecute(context);
      expect(shouldExecute).toBe(true);
    });
  });

  describe('Template syntax handling', () => {
    it('should handle conditions with ${} template syntax', async () => {
      context.setStepOutput('context_scan', {
        reused_existing: true
      });

      const step = new PersonaRequestStep({
        name: 'test_step',
        type: 'PersonaRequestStep',
        condition: '${context_scan.reused_existing} == true',
        config: {
          persona: 'context',
          payload: {}
        }
      });

      const shouldExecute = await step.shouldExecute(context);
      expect(shouldExecute).toBe(true);
    });

    it('should handle conditions without ${} template syntax', async () => {
      context.setStepOutput('context_scan', {
        reused_existing: true
      });

      const step = new PersonaRequestStep({
        name: 'test_step',
        type: 'PersonaRequestStep',
        condition: 'context_scan.reused_existing == true',
        config: {
          persona: 'context',
          payload: {}
        }
      });

      const shouldExecute = await step.shouldExecute(context);
      expect(shouldExecute).toBe(true);
    });
  });
});
