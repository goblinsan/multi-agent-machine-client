import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { makeTempRepo } from './makeTempRepo.js';
import { WorkflowContext } from '../src/workflows/engine/WorkflowContext.js';
import { ReviewFailureTasksStep } from '../src/workflows/steps/ReviewFailureTasksStep.js';
import fs from 'fs/promises';

/**
 * ⚠️ DEPRECATED INTEGRATION TEST - Superseded by Phase 4-5
 * 
 * This test suite validates ReviewFailureTasksStep which was replaced by:
 * - Phase 4: BulkTaskCreationStep with retry logic, idempotency, and priority mapping
 * - Phase 5: Dashboard backend HTTP API with external_id uniqueness constraints
 * 
 * Current equivalent tests:
 * - tests/phase4/bulkTaskCreationStep.test.ts - Task creation with retries and error handling
 * - tests/phase5/dashboardIntegration.test.ts - Real HTTP integration tests
 * - scripts/test-dashboard-integration.ts - E2E idempotency tests (7/7 passing)
 * 
 * Original test goals (now covered by Phase 4-5):
 * 1. ✅ ReviewFailureTasksStep handles PM responses → BulkTaskCreationStep handles task arrays
 * 2. ✅ PM response with backlog creates tasks → bulk API handles arrays of tasks
 * 3. ✅ PM response with follow_up_tasks → standard input format for BulkTaskCreationStep
 * 4. ✅ createDashboardTask() called correctly → DashboardClient.bulkCreateTasks()
 * 5. ✅ Created tasks have readable titles → validated in Phase 5 integration tests
 * 6. ✅ createdCount > 0 → BulkTaskCreateResponse.summary.created
 * 7. ✅ Works for fail/unknown statuses → workflow engine handles all review statuses
 * 
 * Skip Reason: Superseded by Phase 4-5 workflow system with superior implementation
 * Date Skipped: October 20, 2025
 * Revisit: Post-deployment if regression testing needed
 */

// Mock dashboard and Redis
vi.mock('../src/dashboard.js', () => ({
  fetchProjectStatus: vi.fn().mockResolvedValue({
    id: 'test-project',
    name: 'Test Project',
    status: 'active'
  }),
  fetchProjectStatusDetails: vi.fn().mockResolvedValue({
    tasks: [],
    repositories: []
  }),
  fetchProjectTasks: vi.fn().mockResolvedValue([]),
  updateTaskStatus: vi.fn().mockResolvedValue({ ok: true }),
  createDashboardTask: vi.fn().mockImplementation((options) => {
    return Promise.resolve({ 
      id: `task-${Date.now()}`, 
      ok: true,
      createdId: `task-${Date.now()}`,
      status: 'success'
    });
  })
}));

vi.mock('../src/redisClient.js', () => ({
  makeRedis: vi.fn().mockResolvedValue({
    disconnect: vi.fn().mockResolvedValue(undefined),
    xAdd: vi.fn().mockResolvedValue('123'),
    xRevRange: vi.fn().mockResolvedValue([]),
    xRead: vi.fn().mockResolvedValue([])
  })
}));

describe.skip('Code Review Failure Task Creation Integration Tests [DEPRECATED - Superseded by Phase 4-5]', () => {
  let repoCleanup: (() => Promise<void>) | null = null;
  let repoRoot: string;

  beforeEach(async () => {
    repoRoot = await makeTempRepo();
    repoCleanup = null; // makeTempRepo now returns string path, cleanup handled by afterEach
    
    // Clear all mocks before each test
    vi.clearAllMocks();
  });

  afterEach(async () => {
    if (repoRoot) {
      await fs.rm(repoRoot, { recursive: true, force: true });
    }
  });

  it('creates dashboard tasks when PM returns {status: "pass", backlog: [...]} format', async () => {
    // This is the ACTUAL format the PM persona returned in production
    const pmDecisionWithStatusField = {
      status: "pass",
      details: "Context summary loaded successfully",
      milestone_updates: [],
      backlog: [
        {
          title: "Address MEDIUM findings in production/beta stage",
          description: "Review code_review_result JSON and create tasks for MEDIUM findings that require fixing before merge.",
          priority: "high"
        },
        {
          title: "Add LOW findings to backlog as future improvements",
          description: "Create tasks for LOW findings to add to the backlog for future refactoring opportunities.",
          priority: "low"
        }
      ],
      follow_up_tasks: [
        {
          title: "Code Review Failure Analysis Report",
          description: "Generate a report detailing the code review failure analysis, including severity counts and recommendations for improvement.",
          priority: "high"
        }
      ]
    };

    const context = new WorkflowContext(
      'test-workflow-status-field',
      'test-project',
      repoRoot,
      'test-branch',
      {
        name: 'test-workflow',
        description: 'Test code review task creation',
        version: '1.0.0',
        steps: [],
        trigger: { condition: 'task_type == "task"' },
        context: { repo_required: true }
      },
      {}
    );

    // Set the PM decision in context (this is what PersonaRequestStep would do)
    context.setVariable('pm_code_review_decision', pmDecisionWithStatusField);
    context.setVariable('task', {
      id: 'test-task-123',
      title: 'Implement feature X',
      description: 'Build the feature'
    });
    context.setVariable('projectId', 'test-project');
    context.setVariable('milestone', 'milestone-1');

    const step = new ReviewFailureTasksStep({
      name: 'create_code_review_followup_tasks',
      type: 'ReviewFailureTasksStep',
      config: {
        pmDecisionVariable: 'pm_code_review_decision',
        reviewType: 'code_review',
        urgentPriorityScore: 1000,
        deferredPriorityScore: 50
      }
    });

    const result = await step.execute(context);

    // Verify step succeeded
    expect(result.status).toBe('success');

    // Verify tasks were created
    expect(result.outputs!.tasks_created).toBeGreaterThan(0);
    
    // Verify createDashboardTask was called
    const { createDashboardTask } = await import('../src/dashboard.js');
    expect(createDashboardTask).toHaveBeenCalled();
    
    // Verify task titles are readable (not stringified JSON)
    const calls = (createDashboardTask as any).mock.calls;
    expect(calls.length).toBeGreaterThan(0);
    
    for (const call of calls) {
      const options = call[0]; // First argument is the options object
      expect(options.title).toBeDefined();
      expect(options.title).not.toMatch(/^\{.*"output"/); // Not stringified JSON
      expect(options.title).toMatch(/Code Review|Address|Add/); // Readable title
    }

    console.log(`✅ Created ${result.outputs!.tasks_created} tasks from PM response with 'status' field`);
  });

  it('creates dashboard tasks when PM returns {decision: "defer", follow_up_tasks: [...]} format', async () => {
    // This is the EXPECTED format according to the workflow prompt
    const pmDecisionWithDecisionField = {
      decision: "defer",
      reasoning: "Only MEDIUM and LOW findings present. Can defer to backlog for future improvements.",
      immediate_issues: [],
      deferred_issues: [
        "Complex nested logic in fileIngest.ts line 10",
        "Unused interface property 'data' in logEntry.ts"
      ],
      follow_up_tasks: [
        {
          title: "Simplify nested logic in fileIngest.ts",
          description: "Refactor complex conditional statements at line 10 into smaller functions for better readability.",
          priority: "medium"
        },
        {
          title: "Remove unused properties in logEntry.ts",
          description: "Clean up unused interface properties to improve maintainability.",
          priority: "low"
        }
      ]
    };

    const context = new WorkflowContext(
      'test-workflow-decision-field',
      'test-project',
      repoRoot,
      'test-branch',
      {
        name: 'test-workflow',
        description: 'Test code review task creation',
        version: '1.0.0',
        steps: [],
        trigger: { condition: 'task_type == "task"' },
        context: { repo_required: true }
      },
      {}
    );

    context.setVariable('pm_code_review_decision', pmDecisionWithDecisionField);
    context.setVariable('task', {
      id: 'test-task-456',
      title: 'Refactor module Y',
      description: 'Clean up code'
    });
    context.setVariable('projectId', 'test-project');
    context.setVariable('milestone', 'milestone-1');

    const step = new ReviewFailureTasksStep({
      name: 'create_code_review_followup_tasks',
      type: 'ReviewFailureTasksStep',
      config: {
        pmDecisionVariable: 'pm_code_review_decision',
        reviewType: 'code_review',
        urgentPriorityScore: 1000,
        deferredPriorityScore: 50
      }
    });

    const result = await step.execute(context);

    // Verify step succeeded
    expect(result.status).toBe('success');

    // Verify tasks were created
    expect(result.outputs!.tasks_created).toBeGreaterThan(0);
    
    // Verify createDashboardTask was called
    const { createDashboardTask } = await import('../src/dashboard.js');
    expect(createDashboardTask).toHaveBeenCalled();
    
    console.log(`✅ Created ${result.outputs!.tasks_created} tasks from PM response with 'decision' field`);
  });

  it('creates urgent tasks when PM returns {decision: "immediate_fix", immediate_issues: [...]}', async () => {
    // This format indicates SEVERE/HIGH findings that need immediate attention
    const pmDecisionImmediateFix = {
      decision: "immediate_fix",
      reasoning: "SEVERE and HIGH findings present that must be addressed before merge.",
      immediate_issues: [
        "Potential bug: Unhandled promise rejection in ingestion.ts line 4",
        "Inconsistent naming convention causing confusion"
      ],
      deferred_issues: [],
      follow_up_tasks: [
        {
          title: "Fix unhandled promise rejection in ingestion.ts",
          description: "Add error handling for Promise.all() and fileIngest.readJsonFile() to prevent unhandled rejections.",
          priority: "critical"
        },
        {
          title: "Fix inconsistent naming: ingestion.ts should be ingest.ts",
          description: "Rename the file to ingest.ts for consistency with other modules.",
          priority: "high"
        }
      ]
    };

    const context = new WorkflowContext(
      'test-workflow-immediate-fix',
      'test-project',
      repoRoot,
      'test-branch',
      {
        name: 'test-workflow',
        description: 'Test code review task creation',
        version: '1.0.0',
        steps: [],
        trigger: { condition: 'task_type == "task"' },
        context: { repo_required: true }
      },
      {}
    );

    context.setVariable('pm_code_review_decision', pmDecisionImmediateFix);
    context.setVariable('task', {
      id: 'test-task-789',
      title: 'Fix critical bugs',
      description: 'Address urgent issues'
    });
    context.setVariable('projectId', 'test-project');
    context.setVariable('milestone', 'milestone-1');

    const step = new ReviewFailureTasksStep({
      name: 'create_code_review_followup_tasks',
      type: 'ReviewFailureTasksStep',
      config: {
        pmDecisionVariable: 'pm_code_review_decision',
        reviewType: 'code_review',
        urgentPriorityScore: 1000,
        deferredPriorityScore: 50
      }
    });

    const result = await step.execute(context);

    // Verify step succeeded
    expect(result.status).toBe('success');

    // Verify urgent tasks were created
    expect(result.outputs!.tasks_created).toBeGreaterThan(0);
    expect(result.outputs!.urgent_tasks_created).toBeGreaterThan(0);
    
    // Verify createDashboardTask was called with urgent priority
    const { createDashboardTask } = await import('../src/dashboard.js');
    expect(createDashboardTask).toHaveBeenCalled();
    
    const calls = (createDashboardTask as any).mock.calls;
    for (const call of calls) {
      const options = call[0]; // First argument is the options object
      // Urgent tasks should have high priority score
      expect(options.priorityScore).toBeGreaterThanOrEqual(1000);
    }
    
    console.log(`✅ Created ${result.outputs!.urgent_tasks_created} URGENT tasks from PM immediate_fix decision`);
  });

  it('handles PM response with missing fields gracefully', async () => {
    // Edge case: PM returns minimal response
    const minimalPmDecision = {
      // No decision, no status, no follow_up_tasks
      reasoning: "All checks passed"
    };

    const context = new WorkflowContext(
      'test-workflow-minimal',
      'test-project',
      repoRoot,
      'test-branch',
      {
        name: 'test-workflow',
        description: 'Test code review task creation',
        version: '1.0.0',
        steps: [],
        trigger: { condition: 'task_type == "task"' },
        context: { repo_required: true }
      },
      {}
    );

    context.setVariable('pm_code_review_decision', minimalPmDecision);
    context.setVariable('task', {
      id: 'test-task-minimal',
      title: 'Test minimal response',
      description: 'Handle edge case'
    });
    context.setVariable('projectId', 'test-project');
    context.setVariable('milestone', 'milestone-1');

    const step = new ReviewFailureTasksStep({
      name: 'create_code_review_followup_tasks',
      type: 'ReviewFailureTasksStep',
      config: {
        pmDecisionVariable: 'pm_code_review_decision',
        reviewType: 'code_review',
        urgentPriorityScore: 1000,
        deferredPriorityScore: 50
      }
    });

    const result = await step.execute(context);

    // Should succeed even with minimal response
    expect(result.status).toBe('success');
    
    // May create 0 tasks if no follow_up_tasks provided
    expect(result.outputs!.tasks_created).toBeGreaterThanOrEqual(0);
    
    console.log(`✅ Handled minimal PM response gracefully (created ${result.outputs!.tasks_created} tasks)`);
  });

  it('handles code review UNKNOWN status by creating tasks', async () => {
    // Simulate the workflow condition: code_review_request_status == 'unknown'
    // This would trigger PM evaluation, which then creates tasks
    
    const pmDecisionForUnknownStatus = {
      status: "pass", // PM evaluated and created backlog tasks
      backlog: [
        {
          title: "Investigate code review parsing failure",
          description: "Code review returned UNKNOWN status. Investigate why parsing failed and fix the issue.",
          priority: "high"
        }
      ],
      follow_up_tasks: []
    };

    const context = new WorkflowContext(
      'test-workflow-unknown-status',
      'test-project',
      repoRoot,
      'test-branch',
      {
        name: 'test-workflow',
        description: 'Test code review task creation',
        version: '1.0.0',
        steps: [],
        trigger: { condition: 'task_type == "task"' },
        context: { repo_required: true }
      },
      {}
    );

    context.setVariable('pm_code_review_decision', pmDecisionForUnknownStatus);
    context.setVariable('code_review_request_status', 'unknown'); // This is the trigger
    context.setVariable('task', {
      id: 'test-task-unknown',
      title: 'Test unknown status handling',
      description: 'Ensure tasks created for unknown status'
    });
    context.setVariable('projectId', 'test-project');
    context.setVariable('milestone', 'milestone-1');

    const step = new ReviewFailureTasksStep({
      name: 'create_code_review_followup_tasks',
      type: 'ReviewFailureTasksStep',
      config: {
        pmDecisionVariable: 'pm_code_review_decision',
        reviewType: 'code_review',
        urgentPriorityScore: 1000,
        deferredPriorityScore: 50
      }
    });

    const result = await step.execute(context);

    // Verify step succeeded
    expect(result.status).toBe('success');

    // Verify tasks were created for unknown status
    expect(result.outputs!.tasks_created).toBeGreaterThan(0);
    
    const { createDashboardTask } = await import('../src/dashboard.js');
    expect(createDashboardTask).toHaveBeenCalled();
    
    console.log(`✅ Created ${result.outputs!.tasks_created} tasks for UNKNOWN code review status`);
  });

  it('regression test: does NOT create tasks with stringified JSON as title', async () => {
    // This is the BUG we're preventing regression on
    // The old code would stringify the entire payload, creating garbage titles
    
    const pmDecision = {
      status: "pass",
      backlog: [
        {
          title: "Fix critical security issue",
          description: "SQL injection vulnerability in user input handling",
          priority: "critical"
        }
      ]
    };

    const context = new WorkflowContext(
      'test-regression-stringify',
      'test-project',
      repoRoot,
      'test-branch',
      {
        name: 'test-workflow',
        description: 'Test code review task creation',
        version: '1.0.0',
        steps: [],
        trigger: { condition: 'task_type == "task"' },
        context: { repo_required: true }
      },
      {}
    );

    context.setVariable('pm_code_review_decision', pmDecision);
    context.setVariable('task', {
      id: 'test-task-regression',
      title: 'Regression test',
      description: 'Prevent stringified JSON titles'
    });
    context.setVariable('projectId', 'test-project');
    context.setVariable('milestone', 'milestone-1');

    const step = new ReviewFailureTasksStep({
      name: 'create_code_review_followup_tasks',
      type: 'ReviewFailureTasksStep',
      config: {
        pmDecisionVariable: 'pm_code_review_decision',
        reviewType: 'code_review',
        urgentPriorityScore: 1000,
        deferredPriorityScore: 50
      }
    });

    const result = await step.execute(context);

    expect(result.status).toBe('success');
    expect(result.outputs!.tasks_created).toBeGreaterThan(0);
    
    const { createDashboardTask } = await import('../src/dashboard.js');
    const calls = (createDashboardTask as any).mock.calls;
    
    for (const call of calls) {
      const options = call[0]; // First argument is the options object
      
      // CRITICAL ASSERTIONS: Ensure NO stringified JSON in titles
      expect(options.title).not.toMatch(/^\{.*"output":/);
      expect(options.title).not.toMatch(/^\{.*"status":/);
      expect(options.title).not.toMatch(/^\{.*"details":/);
      expect(options.title).not.toContain('{"output"');
      expect(options.title).not.toContain('\\"status\\"');
      
      // Title should be human-readable
      expect(options.title).toMatch(/Fix|Address|Code Review|Security/i);
    }
    
    console.log('✅ REGRESSION TEST PASSED: No stringified JSON in task titles');
  });
});
