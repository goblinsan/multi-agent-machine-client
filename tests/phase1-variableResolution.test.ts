/**
 * Phase 1: Variable Resolution in PersonaRequestStep
 * 
 * REQUIREMENT: Artifact paths with ${variable} placeholders must be resolved
 * before sending payloads to personas.
 * 
 * CURRENT BUG: Personas receive literal "${task.id}" instead of actual IDs
 * Expected: ".ma/tasks/42/03-plan-final.md"
 * Actual: ".ma/tasks/${task.id}/03-plan-final.md"
 * 
 * These tests will FAIL until PersonaRequestStep.execute() implements
 * payload variable resolution.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { PersonaRequestStep } from '../src/workflows/steps/PersonaRequestStep.js';
import { WorkflowContext } from '../src/workflows/engine/WorkflowContext.js';
import { makeTempRepo } from './makeTempRepo.js';
import * as persona from '../src/agents/persona.js';

// Mock persona module
vi.mock('../src/agents/persona.js', () => ({
  sendPersonaRequest: vi.fn().mockResolvedValue('corr-123'),
  waitForPersonaCompletion: vi.fn().mockResolvedValue({
    id: 'event-1',
    fields: {
      result: JSON.stringify({ status: 'success', normalizedStatus: 'pass' })
    }
  }),
  interpretPersonaStatus: vi.fn().mockReturnValue({
    status: 'pass',
    details: '',
    raw: ''
  })
}));

vi.mock('../src/logger.js', () => ({
  logger: {
    info: vi.fn(),
    debug: vi.fn(),
    warn: vi.fn(),
    error: vi.fn()
  }
}));

describe('Phase 1: Variable Resolution in Artifact Paths', () => {
  let repoRoot: string;
  let context: WorkflowContext;
  let mockTransport: any;

  beforeEach(async () => {
    repoRoot = await makeTempRepo();

    // Create mock transport
    mockTransport = {
      xAdd: vi.fn().mockResolvedValue('1-0'),
      xGroupCreate: vi.fn().mockResolvedValue(null),
      xReadGroup: vi.fn().mockResolvedValue({}),
      xAck: vi.fn().mockResolvedValue(null),
      disconnect: vi.fn().mockResolvedValue(null)
    };

    const mockConfig = {
      name: 'test-workflow',
      version: '1.0.0',
      steps: []
    };

    context = new WorkflowContext(
      'wf-test-001',
      '1',
      repoRoot,
      'main',
      mockConfig,
      mockTransport,
      {}
    );

    // CRITICAL: Disable persona bypass so we can spy on actual requests
    context.setVariable('SKIP_PERSONA_OPERATIONS', false);
    
    // Set required repo_remote for persona requests
    context.setVariable('repo_remote', 'git@github.com:test/repo.git');
    
    vi.clearAllMocks();
  });

  describe('Simple Variable Resolution', () => {
    it('should resolve ${task.id} in plan_artifact path', async () => {
      // ARRANGE
      context.setVariable('task', {
        id: 42,
        name: 'Implement feature',
        description: 'Add new feature'
      });

      const config = {
        name: 'implementation_request',
        type: 'PersonaRequestStep',
        config: {
          step: '2-implementation',
          persona: 'lead-engineer',
          intent: 'implementation',
          payload: {
            task: '${task}',
            plan_artifact: '.ma/tasks/${task.id}/03-plan-final.md',
            repo: '${repo_remote}'
          }
        },
        outputs: ['implementation_request_result']
      };

      const step = new PersonaRequestStep(config);

      // ACT
      await step.execute(context);

      // ASSERT
      expect(persona.sendPersonaRequest).toHaveBeenCalled();
      const callArgs = vi.mocked(persona.sendPersonaRequest).mock.calls[0];
      const requestOpts = callArgs[1];
      
      // CRITICAL: plan_artifact must have resolved ID, not template
      expect(requestOpts.payload.plan_artifact).toBe('.ma/tasks/42/03-plan-final.md');
      expect(requestOpts.payload.plan_artifact).not.toContain('${task.id}');
    });

    it('should resolve ${task.id} in multiple artifact paths', async () => {
      context.setVariable('task', { id: 99 });

      const config = {
        name: 'qa_request',
        type: 'PersonaRequestStep',
        config: {
          step: '3-qa',
          persona: 'tester-qa',
          intent: 'qa',
          payload: {
            plan_artifact: '.ma/tasks/${task.id}/03-plan-final.md',
            qa_result_artifact: '.ma/tasks/${task.id}/05-qa-result.md'
          }
        },
        outputs: ['qa_request_result']
      };

      const step = new PersonaRequestStep(config);
      await step.execute(context);

      const callArgs = vi.mocked(persona.sendPersonaRequest).mock.calls[0];
      const requestOpts = callArgs[1];
      
      expect(requestOpts.payload.plan_artifact).toBe('.ma/tasks/99/03-plan-final.md');
      expect(requestOpts.payload.qa_result_artifact).toBe('.ma/tasks/99/05-qa-result.md');
    });
  });

  describe('Nested Variable Resolution', () => {
    it('should resolve ${milestone.slug} in artifact paths', async () => {
      context.setVariable('task', { id: 10 });
      context.setVariable('milestone', {
        id: 'm1',
        name: 'Phase 1',
        slug: 'phase-1'
      });

      const config = {
        name: 'test_step',
        type: 'PersonaRequestStep',
        config: {
          step: '2-plan',
          persona: 'implementation-planner',
          intent: 'planning',
          payload: {
            plan_artifact: '.ma/milestones/${milestone.slug}/tasks/${task.id}/plan.md',
            milestone_name: '${milestone.name}'
          }
        }
      };

      const step = new PersonaRequestStep(config);
      await step.execute(context);

      const callArgs = vi.mocked(persona.sendPersonaRequest).mock.calls[0];
      const requestOpts = callArgs[1];
      
      expect(requestOpts.payload.plan_artifact).toBe('.ma/milestones/phase-1/tasks/10/plan.md');
      expect(requestOpts.payload.milestone_name).toBe('Phase 1');
    });

    it('should resolve deeply nested ${task.milestone.slug}', async () => {
      context.setVariable('task', {
        id: 5,
        milestone: {
          slug: 'sprint-2',
          name: 'Sprint 2'
        }
      });

      const config = {
        name: 'test_step',
        type: 'PersonaRequestStep',
        config: {
          step: '1-test',
          persona: 'context',
          intent: 'test',
          payload: {
            artifact_path: '.ma/tasks/${task.id}/milestone-${task.milestone.slug}.md'
          }
        }
      };

      const step = new PersonaRequestStep(config);
      await step.execute(context);

      const callArgs = vi.mocked(persona.sendPersonaRequest).mock.calls[0];
      const requestOpts = callArgs[1];
      
      expect(requestOpts.payload.artifact_path).toBe('.ma/tasks/5/milestone-sprint-2.md');
    });
  });

  describe('Real-World Task Flow Scenarios', () => {
    it('should resolve task-flow.yaml implementation_request payload', async () => {
      context.setVariable('task', {
        id: 1,
        name: 'Implement user authentication',
        description: 'Add JWT-based authentication'
      });
      context.setVariable('repo_remote', 'git@github.com:user/repo.git');
      context.setVariable('projectId', '123');

      const config = {
        name: 'implementation_request',
        type: 'PersonaRequestStep',
        config: {
          step: '2-implementation',
          persona: 'lead-engineer',
          intent: 'implementation',
          payload: {
            task: '${task}',
            plan_artifact: '.ma/tasks/${task.id}/03-plan-final.md',
            repo: '${repo_remote}',
            project_id: '${projectId}'
          }
        },
        outputs: ['implementation_request_result']
      };

      const step = new PersonaRequestStep(config);
      await step.execute(context);

      const callArgs = vi.mocked(persona.sendPersonaRequest).mock.calls[0];
      const requestOpts = callArgs[1];
      
      expect(requestOpts.payload.plan_artifact).toBe('.ma/tasks/1/03-plan-final.md');
      expect(requestOpts.payload.repo).toBe('git@github.com:user/repo.git');
      expect(requestOpts.payload.project_id).toBe('123');
      expect(requestOpts.payload.task).toEqual({
        id: 1,
        name: 'Implement user authentication',
        description: 'Add JWT-based authentication'
      });
    });

    it('should resolve task-flow.yaml qa_request payload', async () => {
      context.setVariable('task', { id: 2 });
      context.setVariable('repo_remote', 'git@github.com:user/repo.git');
      context.setVariable('projectId', '456');
      context.setVariable('implementation_request_result', 'Implementation complete');

      const config = {
        name: 'qa_request',
        type: 'PersonaRequestStep',
        config: {
          step: '3-qa',
          persona: 'tester-qa',
          intent: 'qa',
          payload: {
            task: '${task}',
            plan_artifact: '.ma/tasks/${task.id}/03-plan-final.md',
            implementation: '${implementation_request_result}',
            repo: '${repo_remote}',
            project_id: '${projectId}'
          }
        },
        outputs: ['qa_request_result']
      };

      const step = new PersonaRequestStep(config);
      await step.execute(context);

      const callArgs = vi.mocked(persona.sendPersonaRequest).mock.calls[0];
      const requestOpts = callArgs[1];
      
      expect(requestOpts.payload.plan_artifact).toBe('.ma/tasks/2/03-plan-final.md');
      expect(requestOpts.payload.implementation).toBe('Implementation complete');
    });
  });

  describe('Fallback Behavior', () => {
    it('should preserve template if variable not found', async () => {
      context.setVariable('task', { id: 20 });
      // Note: milestone NOT set

      const config = {
        name: 'test_step',
        type: 'PersonaRequestStep',
        config: {
          step: '1-test',
          persona: 'context',
          intent: 'test',
          payload: {
            plan_artifact: '.ma/tasks/${task.id}/plan.md',
            milestone_artifact: '.ma/milestones/${milestone.id}/info.md'
          }
        }
      };

      const step = new PersonaRequestStep(config);
      await step.execute(context);

      const callArgs = vi.mocked(persona.sendPersonaRequest).mock.calls[0];
      const requestOpts = callArgs[1];
      
      expect(requestOpts.payload.plan_artifact).toBe('.ma/tasks/20/plan.md');
      // Should preserve template for undefined variables
      expect(requestOpts.payload.milestone_artifact).toBe('.ma/milestones/${milestone.id}/info.md');
    });
  });
});
