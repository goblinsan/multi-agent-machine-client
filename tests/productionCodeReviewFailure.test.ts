/**
 * ⚠️ DEPRECATED TEST - Superseded by Phase 4-5
 * 
 * Test for actual production bug: workflowId 9ca72852-6cf4-49ad-8f84-79a67ff92d9a
 * PM returned response with both backlog and follow_up_tasks, but 0 tasks were created
 * 
 * This test suite validates ReviewFailureTasksStep which was replaced by:
 * - Phase 4: BulkTaskCreationStep with proper array handling
 * - Phase 5: Dashboard backend with idempotent task creation
 * 
 * Current equivalent tests:
 * - tests/phase4/bulkTaskCreationStep.test.ts - Handles task arrays correctly
 * - tests/phase5/dashboardIntegration.test.ts - Real HTTP API integration
 * 
 * Skip Reason: Superseded by Phase 4-5 workflow system
 * Date Skipped: October 20, 2025
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { WorkflowContext } from '../src/workflows/engine/WorkflowContext.js';
import { ReviewFailureTasksStep } from '../src/workflows/steps/ReviewFailureTasksStep.js';
import type { ReviewFailureTasksStepConfig } from '../src/workflows/steps/ReviewFailureTasksStep.js';

// Mock dependencies
vi.mock('../src/dashboard.js', () => ({
  createDashboardTask: vi.fn().mockImplementation((options) => {
    return Promise.resolve({
      id: `task-${Date.now()}`,
      ok: true,
      createdId: `task-${Date.now()}`,
      status: 'success'
    });
  }),
  fetchProjectTasks: vi.fn().mockResolvedValue([])
}));

vi.mock('../src/redisClient.js', () => ({
  getRedisClient: vi.fn().mockResolvedValue({
    xAdd: vi.fn().mockResolvedValue('msg-id'),
    quit: vi.fn().mockResolvedValue(undefined)
  })
}));

vi.mock('../src/tasks/taskManager.js', () => ({
  updateTask: vi.fn().mockResolvedValue({ ok: true }),
  getTask: vi.fn().mockResolvedValue({ ok: true, data: { status: 'in-progress' } })
}));

describe.skip('Production Code Review Failure Bug [DEPRECATED - Superseded by Phase 4-5]', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('should create tasks from PM response with both backlog and follow_up_tasks', async () => {
    // This is the EXACT response from production (workflowId: 9ca72852)
    const pmResponse = {
      "status": "pass",
      "details": "Code review failures evaluated for task in milestone null.",
      "milestone_updates": [],
      "backlog": [
        {
          "title": "Address medium findings in ingestion module",
          "description": "Review and address medium findings in the ingestion module to ensure code quality before merge.",
          "priority": "high"
        },
        {
          "title": "Refactor fileIngest.ts to improve maintainability",
          "description": "Improve maintainability of fileIngest.ts by addressing low findings and refactoring the code.",
          "priority": "medium"
        }
      ],
      "follow_up_tasks": [
        {
          "title": "Implement automated testing for ingestion module",
          "description": "Automate testing for the ingestion module to ensure it is thoroughly tested before merge.",
          "priority": "high"
        }
      ]
    };

    const definition = {
      name: 'test-workflow',
      steps: []
    };

    const context = new WorkflowContext(
      '9ca72852-6cf4-49ad-8f84-79a67ff92d9a',
      '1808e304-fc52-49f6-9a42-71044b4cb4b5',
      '/Users/jamescoghlan/code/machine-client-log-summarizer',
      'milestone/local-log-ingestion',
      definition,
      {
        projectId: '1808e304-fc52-49f6-9a42-71044b4cb4b5',
        milestoneId: 'test-milestone-id',
        task: { id: '004c60d8-68a8-4060-ab5c-e8a364fb085c' },
        pm_code_review_decision: pmResponse
      }
    );

    const step = new ReviewFailureTasksStep({
      name: 'create_code_review_followup_tasks',
      type: 'review_failure_tasks',
      reviewType: 'code_review',
      pmDecisionVariable: 'pm_code_review_decision',
      urgentPriorityScore: 1000,
      deferredPriorityScore: 50,
      backlogMilestoneSlug: 'future-enhancements'
    });

    const result = await step.execute(context);

    // The bug: This should be 3 (1 follow_up_task + 2 backlog), but production showed 0
    console.log('Result:', JSON.stringify(result, null, 2));
    
    expect(result.status).toBe('success');
    expect(result.outputs.tasks_created).toBeGreaterThan(0);
    
    // PM returned follow_up_tasks with 1 item (high priority)
    // PM also returned backlog with 2 items (high + medium priority)
    // We should create tasks from follow_up_tasks since it exists and is not empty
    // Question: Should we ALSO create tasks from backlog? Or does follow_up_tasks override it?
    
    // Based on the code, if follow_up_tasks exists and is not empty, we DON'T map backlog
    // So we should only get 1 task (from follow_up_tasks)
    expect(result.outputs.tasks_created).toBe(1);
    expect(result.outputs.urgent_tasks_created).toBe(0); // high priority goes to deferred
    expect(result.outputs.deferred_tasks_created).toBe(1);
  });

  it('should show debug logs for the parsing process', async () => {
    const pmResponse = {
      "status": "pass",
      "backlog": [{ "title": "Task 1", "description": "Desc 1", "priority": "high" }],
      "follow_up_tasks": [{ "title": "Task 2", "description": "Desc 2", "priority": "high" }]
    };

    const definition = { name: 'test-workflow', steps: [] };
    const context = new WorkflowContext(
      'test-workflow-id',
      'test-project-id',
      '/test/repo',
      'test-branch',
      definition,
      {
        projectId: 'test-project-id',
        milestoneId: 'test-milestone-id',
        task: { id: 'test-task-id' },
        pm_code_review_decision: pmResponse
      }
    );

    const step = new ReviewFailureTasksStep({
      name: 'create_code_review_followup_tasks',
      type: 'review_failure_tasks',
      reviewType: 'code_review',
      pmDecisionVariable: 'pm_code_review_decision',
      urgentPriorityScore: 1000,
      deferredPriorityScore: 50
    });

    const result = await step.execute(context);
    
    console.log('Debug test result:', JSON.stringify(result, null, 2));
    
    // With follow_up_tasks present and non-empty, we should get 1 task
    expect(result.outputs.tasks_created).toBe(1);
  });
});
