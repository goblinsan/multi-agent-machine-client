/**
 * Phase 2: Remove Coordination Persona LLM Call
 * 
 * REQUIREMENT: Coordinator should fetch tasks from dashboard and route directly
 * to workflows WITHOUT calling the coordination persona LLM.
 * 
 * CURRENT BEHAVIOR: Coordinator calls coordination persona (~24s wasted per run)
 * EXPECTED BEHAVIOR: Direct task fetch → sort by priority → execute workflow
 * 
 * These tests will FAIL until WorkflowCoordinator.handleCoordinator() removes
 * the coordination persona LLM call.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { WorkflowCoordinator } from '../src/workflows/WorkflowCoordinator.js';
import { ProjectAPI } from '../src/dashboard/ProjectAPI.js';
import { makeTempRepo } from './makeTempRepo.js';
import * as persona from '../src/agents/persona.js';

// Mock dependencies
vi.mock('../src/dashboard/ProjectAPI.js');
vi.mock('../src/agents/persona.js');
vi.mock('../src/gitUtils.js', () => ({
  resolveRepoFromPayload: vi.fn().mockResolvedValue({
    repoRoot: '/test/repo',
    remote: 'git@github.com:test/repo.git',
    branch: 'main'
  }),
  runGit: vi.fn().mockResolvedValue('')
}));
vi.mock('../src/logger.js', () => ({
  logger: {
    info: vi.fn(),
    debug: vi.fn(),
    warn: vi.fn(),
    error: vi.fn()
  }
}));

describe('Phase 2: Remove Coordination Persona LLM Call', () => {
  let coordinator: WorkflowCoordinator;
  let mockTransport: any;
  let repoRoot: string;

  beforeEach(async () => {
    repoRoot = await makeTempRepo();

    coordinator = new WorkflowCoordinator();

    mockTransport = {
      xAdd: vi.fn().mockResolvedValue('1-0'),
      xGroupCreate: vi.fn().mockResolvedValue(null),
      xReadGroup: vi.fn().mockResolvedValue({}),
      xAck: vi.fn().mockResolvedValue(null),
      disconnect: vi.fn().mockResolvedValue(null)
    };

    // Mock project API responses
    vi.mocked(ProjectAPI.prototype.fetchProjectStatus).mockResolvedValue({
      id: '1',
      name: 'Test Project',
      slug: 'test-project',
      repository: {
        clone_url: 'git@github.com:test/repo.git'
      }
    });

    vi.mocked(ProjectAPI.prototype.fetchProjectStatusDetails).mockResolvedValue({
      milestones: []
    });

    // Mock fetchProjectTasks to return empty (no pending tasks)
    vi.spyOn(coordinator, 'fetchProjectTasks').mockResolvedValue([]);

    vi.clearAllMocks();
  });

  describe('Coordinator Startup', () => {
    it('should NOT call coordination persona on startup', async () => {
      // ARRANGE
      const msg = {
        workflow_id: 'wf-coord-test',
        project_id: '1',
        step: '00',
        from: 'user',
        to_persona: 'coordination',
        intent: 'orchestrate_milestone',
        corr_id: 'corr-123'
      };

      const payload = {
        project_id: '1'
      };

      // ACT
      await coordinator.handleCoordinator(mockTransport, {}, msg, payload);

      // ASSERT - CRITICAL: No coordination persona should be called
      expect(persona.sendPersonaRequest).not.toHaveBeenCalled();
      expect(persona.waitForPersonaCompletion).not.toHaveBeenCalled();
    });

    it('should fetch tasks directly from dashboard', async () => {
      // ARRANGE
      const mockTasks = [
        { id: 1, status: 'open', priority_score: 100 },
        { id: 2, status: 'in_progress', priority_score: 200 }
      ];

      vi.spyOn(coordinator, 'fetchProjectTasks').mockResolvedValue(mockTasks);

      const msg = {
        workflow_id: 'wf-coord-test',
        project_id: '1'
      };

      const payload = {
        project_id: '1'
      };

      // ACT
      await coordinator.handleCoordinator(mockTransport, {}, msg, payload);

      // ASSERT
      expect(coordinator.fetchProjectTasks).toHaveBeenCalledWith('1');
      expect(persona.sendPersonaRequest).not.toHaveBeenCalled();
    });
  });

  describe('Task Priority Selection', () => {
    it('should select highest priority_score task without LLM', async () => {
      // ARRANGE
      const mockTasks = [
        { id: 1, status: 'open', priority_score: 100, name: 'Low priority' },
        { id: 2, status: 'open', priority_score: 500, name: 'High priority' },
        { id: 3, status: 'open', priority_score: 200, name: 'Medium priority' }
      ];

      // Mock workflow engine to prevent actual execution
      const mockWorkflow = { name: 'task-flow', version: '3.0.0', steps: [], trigger: { condition: "task_type == 'task' || task_type == 'feature'" } };
      const mockEngine = {
        loadWorkflowsFromDirectory: vi.fn().mockResolvedValue([mockWorkflow]),
        getWorkflowDefinitions: vi.fn().mockReturnValue([mockWorkflow]),
        getWorkflowDefinition: vi.fn().mockReturnValue(null),
        findWorkflowByCondition: vi.fn().mockReturnValue(mockWorkflow),
        executeWorkflowDefinition: vi.fn().mockResolvedValue({
          success: true,
          completedSteps: [],
          duration: 0
        })
      };

      // Create coordinator with mock engine FIRST
      coordinator = new WorkflowCoordinator(mockEngine as any);
      
      // THEN set up the spy for fetchProjectTasks
      // First call returns tasks, second call returns empty (all done)
      vi.spyOn(coordinator, 'fetchProjectTasks')
        .mockResolvedValueOnce(mockTasks)
        .mockResolvedValueOnce([]);  // Second iteration returns empty

      const msg = { workflow_id: 'wf-test', project_id: '1' };
      const payload = { project_id: '1' };

      // ACT
      await coordinator.handleCoordinator(mockTransport, {}, msg, payload);

      // ASSERT
      // Should execute workflow for task 2 (highest priority_score: 500)
      expect(mockEngine.executeWorkflowDefinition).toHaveBeenCalled();
      const executeCall = vi.mocked(mockEngine.executeWorkflowDefinition).mock.calls[0];
      const initialVars = executeCall[5];  // 6th argument is initialVariables
      expect(initialVars.task.id).toBe(2);  // Highest priority task
      expect(initialVars.taskName).toBe('High priority');
      
      // CRITICAL: No LLM coordination call
      expect(persona.sendPersonaRequest).not.toHaveBeenCalled();
    });

    it('should prioritize blocked/in_review over open tasks', async () => {
      // ARRANGE
      // Test that priority_score is primary, but status is secondary tie-breaker
      const mockTasks = [
        { id: 1, status: 'open', priority_score: 100 },  // Same score as task 2
        { id: 2, status: 'blocked', priority_score: 100 },  // Same score but blocked (higher priority)
        { id: 3, status: 'in_review', priority_score: 50 }  // Lower score
      ];

      const mockWorkflow = { name: 'task-flow', version: '3.0.0', steps: [], trigger: { condition: "task_type == 'task' || task_type == 'feature'" } };
      const mockEngine = {
        loadWorkflowsFromDirectory: vi.fn().mockResolvedValue([]),
        getWorkflowDefinitions: vi.fn().mockReturnValue([mockWorkflow]),
        getWorkflowDefinition: vi.fn().mockReturnValue(null),
        findWorkflowByCondition: vi.fn().mockReturnValue(mockWorkflow),
        executeWorkflowDefinition: vi.fn().mockResolvedValue({
          success: true,
          completedSteps: [],
          duration: 0
        })
      };

      // Create coordinator with mock engine FIRST
      coordinator = new WorkflowCoordinator(mockEngine as any);
      
      // THEN set up the spy
      // First call returns tasks, second call returns empty (all done)
      vi.spyOn(coordinator, 'fetchProjectTasks')
        .mockResolvedValueOnce(mockTasks)
        .mockResolvedValueOnce([]);

      const msg = { workflow_id: 'wf-test', project_id: '1' };
      const payload = { project_id: '1' };

      // ACT
      await coordinator.handleCoordinator(mockTransport, {}, msg, payload);

      // ASSERT
      // Should execute workflow for task 2 (blocked status takes priority)
      expect(mockEngine.executeWorkflowDefinition).toHaveBeenCalled();
      const executeCall = vi.mocked(mockEngine.executeWorkflowDefinition).mock.calls[0];
      const initialVars = executeCall[5];  // 6th argument is initialVariables
      expect(initialVars.task.id).toBe(2);  // Blocked task (highest priority by status)
      
      // No coordination LLM call
      expect(persona.sendPersonaRequest).not.toHaveBeenCalled();
    });
  });

  describe('Performance Validation', () => {
    it('should complete coordinator startup in < 1 second (no LLM overhead)', async () => {
      // ARRANGE
      vi.spyOn(coordinator, 'fetchProjectTasks').mockResolvedValue([]);

      const msg = { workflow_id: 'wf-perf-test', project_id: '1' };
      const payload = { project_id: '1' };

      // ACT
      const start = Date.now();
      await coordinator.handleCoordinator(mockTransport, {}, msg, payload);
      const duration = Date.now() - start;

      // ASSERT
      // Without LLM call, coordinator should be fast (< 1000ms)
      // With LLM call, it would be ~24000ms (24 seconds)
      expect(duration).toBeLessThan(1000);
      expect(persona.sendPersonaRequest).not.toHaveBeenCalled();
    });
  });

  describe('Engineering Work Validation', () => {
    it('should NOT invoke planning loop at coordinator level', async () => {
      // ARRANGE
      const mockTasks = [
        { id: 1, status: 'open', name: 'Test task' }
      ];

      const mockWorkflow = { name: 'task-flow', version: '3.0.0', steps: [], trigger: { condition: "task_type == 'task' || task_type == 'feature'" } };
      const mockEngine = {
        loadWorkflowsFromDirectory: vi.fn().mockResolvedValue([]),
        getWorkflowDefinitions: vi.fn().mockReturnValue([mockWorkflow]),
        getWorkflowDefinition: vi.fn().mockReturnValue(null),
        findWorkflowByCondition: vi.fn().mockReturnValue(mockWorkflow),
        executeWorkflowDefinition: vi.fn().mockResolvedValue({
          success: true,
          completedSteps: [],
          duration: 0
        })
      };

      // Create coordinator with mock engine FIRST
      coordinator = new WorkflowCoordinator(mockEngine as any);
      
      // THEN set up the spy
      vi.spyOn(coordinator, 'fetchProjectTasks')
        .mockResolvedValueOnce(mockTasks)
        .mockResolvedValueOnce([]);

      const msg = { workflow_id: 'wf-test', project_id: '1' };
      const payload = { project_id: '1' };

      // ACT
      await coordinator.handleCoordinator(mockTransport, {}, msg, payload);

      // ASSERT
      // Coordinator should only route to task-flow.yaml workflow
      // Planning loop happens INSIDE task-flow.yaml, not at coordinator level
      expect(mockEngine.executeWorkflowDefinition).toHaveBeenCalledTimes(1);
      
      // No personas called at coordinator level
      expect(persona.sendPersonaRequest).not.toHaveBeenCalled();
    });
  });
});
