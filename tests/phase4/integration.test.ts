/**
 * ⚠️ DEPRECATED TEST - Superseded by Phase 5
 * 
 * This test suite validates Phase 4 integration with ReviewFailureTasksStep.
 * ReviewFailureTasksStep was replaced by BulkTaskCreationStep in Phase 5.
 * 
 * Current equivalent tests:
 * - tests/phase4/bulkTaskCreationStep.test.ts - Modern task creation step tests
 * - tests/phase4/pmDecisionParserStep.test.ts - PM decision parsing (still valid)
 * - scripts/test-dashboard-integration.ts - E2E integration tests (7/7 passing)
 * 
 * Why deprecated:
 * - Uses ReviewFailureTasksStep (replaced by BulkTaskCreationStep)
 * - Tests workflow YAML with deprecated step configuration
 * - Phase 5 dashboard integration provides superior test coverage
 * 
 * Skip Reason: Workflow step deprecated in Phase 5
 * Date Skipped: October 20, 2025
 * Revisit: Not needed - BulkTaskCreationStep + Dashboard tests cover this
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { WorkflowEngine } from '../../src/workflows/engine/WorkflowEngine.js';
import { PMDecisionParserStep } from '../../src/workflows/steps/PMDecisionParserStep.js';
import { ReviewFailureTasksStep } from '../../src/workflows/steps/ReviewFailureTasksStep.js';
import { BulkTaskCreationStep } from '../../src/workflows/steps/BulkTaskCreationStep.js';
import { WorkflowStepFactory } from '../../src/workflows/engine/WorkflowStep.js';
import { WorkflowContext } from '../../src/workflows/engine/WorkflowContext.js';
import fs from 'fs/promises';
import path from 'path';
import os from 'os';

describe.skip('Phase 4 - End-to-End Integration Tests [DEPRECATED - ReviewFailureTasksStep removed]', () => {
  let tempDir: string;

  beforeEach(async () => {
    // Register steps
    WorkflowStepFactory.registerStep('PMDecisionParserStep', PMDecisionParserStep);
    WorkflowStepFactory.registerStep('ReviewFailureTasksStep', ReviewFailureTasksStep);
    WorkflowStepFactory.registerStep('BulkTaskCreationStep', BulkTaskCreationStep);

    // Create temp directory for test workflows
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'phase4-test-'));
  });

  describe('Complete Review Failure Workflow', () => {
    it('should execute PM parsing → task creation with all Phase 4 features', async () => {
      // Create test workflow YAML
      const workflowYaml = `
name: test-review-failure-workflow
version: 1.0
trigger:
  on: review_failure

steps:
  - name: parse_pm_decision
    type: PMDecisionParserStep
    config:
      input: |
        {
          "decision": "immediate_fix",
          "reasoning": "Test failures block milestone",
          "immediate_issues": ["Test failure in auth module", "Security vulnerability"],
          "deferred_issues": ["Code style improvements"],
          "backlog": [
            {"title": "Refactor legacy code", "description": "Tech debt", "priority": "medium"}
          ],
          "follow_up_tasks": [
            {"title": "Fix auth test failure", "description": "Test failing in CI", "priority": "critical"},
            {"title": "Patch security bug", "description": "XSS vulnerability", "priority": "high"}
          ]
        }
      normalize: true
      review_type: "qa"
    outputs:
      pm_decision: parsed_decision

  - name: create_follow_up_tasks
    type: ReviewFailureTasksStep
    depends_on: [parse_pm_decision]
    config:
      pmDecisionVariable: "pm_decision"
      reviewType: "qa"
      urgentPriorityScore: 1200
      deferredPriorityScore: 50
      backlogMilestoneSlug: "future-enhancements"
`;

      const workflowPath = path.join(tempDir, 'test-workflow.yml');
      await fs.writeFile(workflowPath, workflowYaml);

      const engine = new WorkflowEngine(tempDir);
      const result = await engine.executeWorkflow(
        'test-workflow.yml',
        'test-project-1',
        '/tmp/test-repo',
        'main',
        {
          variables: {
            projectId: '1',
            milestoneId: 'milestone-1'
          }
        }
      );

      expect(result.status).toBe('completed');
      expect(result.executionSummary.completedSteps).toBe(2);
      expect(result.executionSummary.failedSteps).toBe(0);

      // Verify PM decision was parsed correctly
      const pmDecision = result.context.getVariable('pm_decision');
      expect(pmDecision).toBeDefined();
      expect(pmDecision.follow_up_tasks).toHaveLength(3); // 2 from follow_up_tasks + 1 from backlog
      expect(pmDecision.decision).toBe('immediate_fix');

      // Verify tasks were created
      const stepOutput = result.context.getStepOutput('create_follow_up_tasks');
      expect(stepOutput).toBeDefined();
      expect(stepOutput.urgent_tasks_created).toBe(2); // critical + high
      expect(stepOutput.deferred_tasks_created).toBe(1); // medium from backlog
    });

    it('should handle workflow abort signal on partial failure', async () => {
      const workflowYaml = `
name: test-abort-workflow
version: 1.0

steps:
  - name: create_tasks_with_abort
    type: BulkTaskCreationStep
    config:
      project_id: "1"
      workflow_run_id: "wf-abort-test"
      tasks:
        - title: "Task 1"
          priority: "high"
        - title: "Task 2"
          priority: "high"
      retry:
        max_attempts: 1
      options:
        abort_on_partial_failure: true
        upsert_by_external_id: true

  - name: should_not_execute
    type: PMDecisionParserStep
    depends_on: [create_tasks_with_abort]
    config:
      input: '{"decision": "defer", "follow_up_tasks": []}'
`;

      const workflowPath = path.join(tempDir, 'abort-workflow.yml');
      await fs.writeFile(workflowPath, workflowYaml);

      const engine = new WorkflowEngine(tempDir);
      
      // Mock BulkTaskCreationStep to fail partially
      const originalCreate = BulkTaskCreationStep.prototype.execute;
      BulkTaskCreationStep.prototype.execute = async function(context) {
        // Simulate partial failure
        context.setVariable('workflow_abort_requested', true);
        context.setVariable('workflow_abort_reason', 'Test: Partial failure');
        
        return {
          status: 'failure' as const,
          error: new Error('Partial failure'),
          outputs: {
            tasks_created: 1,
            workflow_abort_requested: true
          }
        };
      };

      const result = await engine.executeWorkflow(
        'abort-workflow.yml',
        'test-project-1',
        '/tmp/test-repo',
        'main'
      );

      // Restore original
      BulkTaskCreationStep.prototype.execute = originalCreate;

      expect(result.status).toBe('failed');
      expect(result.context.getVariable('workflow_abort_requested')).toBe(true);
      // Second step should not have executed
      expect(result.executionSummary.completedSteps).toBe(0); // Only failed step
    });

    it('should support idempotent workflow re-runs with external_id', async () => {
      const workflowYaml = `
name: test-idempotent-workflow
version: 1.0

steps:
  - name: create_tasks_idempotent
    type: BulkTaskCreationStep
    config:
      project_id: "1"
      workflow_run_id: "wf-idempotent-123"
      tasks:
        - title: "Idempotent Task 1"
          priority: "high"
        - title: "Idempotent Task 2"
          priority: "medium"
      options:
        upsert_by_external_id: true
        check_duplicates: true
        duplicate_match_strategy: "external_id"
        existing_tasks:
          - id: "task-existing"
            title: "Different Title"
            status: "todo"
            external_id: "wf-idempotent-123:create_tasks_idempotent:0"
`;

      const workflowPath = path.join(tempDir, 'idempotent-workflow.yml');
      await fs.writeFile(workflowPath, workflowYaml);

      const engine = new WorkflowEngine(tempDir);
      const result = await engine.executeWorkflow(
        'idempotent-workflow.yml',
        'test-project-1',
        '/tmp/test-repo',
        'main'
      );

      expect(result.status).toBe('completed');
      
      const stepOutput = result.context.getStepOutput('create_tasks_idempotent');
      // First task should be skipped (duplicate external_id)
      expect(stepOutput.skipped_duplicates).toBe(1);
      // Only second task should be created
      expect(stepOutput.tasks_created).toBeLessThan(2);
    });

    it('should retry with exponential backoff and eventually succeed', async () => {
      const workflowYaml = `
name: test-retry-workflow
version: 1.0

steps:
  - name: create_tasks_with_retry
    type: BulkTaskCreationStep
    config:
      project_id: "1"
      workflow_run_id: "wf-retry-test"
      tasks:
        - title: "Task 1"
          priority: "high"
      retry:
        max_attempts: 3
        initial_delay_ms: 10
        backoff_multiplier: 2
      options:
        upsert_by_external_id: true
`;

      const workflowPath = path.join(tempDir, 'retry-workflow.yml');
      await fs.writeFile(workflowPath, workflowYaml);

      const engine = new WorkflowEngine(tempDir);
      
      let attempts = 0;
      const originalCreate = BulkTaskCreationStep.prototype.execute;
      BulkTaskCreationStep.prototype.execute = async function(context) {
        attempts++;
        
        if (attempts < 2) {
          // Fail first attempt with retryable error
          return originalCreate.call(this, context);
        }
        
        // Succeed on second attempt
        return {
          status: 'success' as const,
          outputs: {
            tasks_created: 1,
            urgent_tasks_created: 1,
            deferred_tasks_created: 0,
            task_ids: ['task-1'],
            duplicate_task_ids: [],
            skipped_duplicates: 0
          }
        };
      };

      const result = await engine.executeWorkflow(
        'retry-workflow.yml',
        'test-project-1',
        '/tmp/test-repo',
        'main'
      );

      // Restore original
      BulkTaskCreationStep.prototype.execute = originalCreate;

      expect(result.status).toBe('completed');
      // Should have retried and succeeded
    });
  });

  describe('Priority Routing Integration', () => {
    it('should route tasks based on priority levels (critical/high → immediate, medium/low → deferred)', async () => {
      const context = new WorkflowContext(
        'test-workflow-id',
        'test-project-id',
        '/tmp/test-repo',
        'main',
        { name: 'test-workflow', version: '1.0', steps: [] },
        {
          projectId: '1',
          milestoneId: 'immediate-milestone'
        }
      );

      // Step 1: Parse PM decision
      const parserStep = new PMDecisionParserStep({
        name: 'parse_pm_decision',
        type: 'PMDecisionParserStep',
        config: {
          input: JSON.stringify({
            decision: 'immediate_fix',
            follow_up_tasks: [
              { title: 'Critical Security Fix', priority: 'critical' },
              { title: 'High Priority Bug', priority: 'high' },
              { title: 'Medium Tech Debt', priority: 'medium' },
              { title: 'Low Priority Polish', priority: 'low' }
            ]
          }),
          normalize: true
        }
      });

      const parseResult = await parserStep.execute(context);
      expect(parseResult.status).toBe('success');
      
      context.setVariable('pm_decision', parseResult.outputs?.pm_decision);

      // Step 2: Create tasks with priority routing
      const taskStep = new ReviewFailureTasksStep({
        name: 'create_tasks',
        type: 'ReviewFailureTasksStep',
        config: {
          pmDecisionVariable: 'pm_decision',
          reviewType: 'qa',
          urgentPriorityScore: 1200,
          deferredPriorityScore: 50,
          backlogMilestoneSlug: 'future-enhancements'
        }
      });

      const taskResult = await taskStep.execute(context);
      expect(taskResult.status).toBe('success');

      // Verify priority routing
      expect(taskResult.outputs?.urgent_tasks_created).toBe(2); // critical + high
      expect(taskResult.outputs?.deferred_tasks_created).toBe(2); // medium + low
    });
  });

  describe('Regression Tests', () => {
    it('should not break existing workflows without Phase 4 config', async () => {
      // Simulate legacy workflow without new Phase 4 features
      const context = new WorkflowContext(
        'legacy-workflow-id',
        'test-project-id',
        '/tmp/test-repo',
        'main',
        { name: 'legacy-workflow', version: '1.0', steps: [] },
        {}
      );

      // Old-style PM decision (no normalization)
      const parserStep = new PMDecisionParserStep({
        name: 'parse_pm_decision',
        type: 'PMDecisionParserStep',
        config: {
          input: JSON.stringify({
            decision: 'defer',
            follow_up_tasks: [
              { title: 'Task 1', priority: 'low' }
            ]
          })
          // normalize: false (default)
        }
      });

      const result = await parserStep.execute(context);
      
      expect(result.status).toBe('success');
      expect(result.outputs?.pm_decision).toBeDefined();
    });

    it('should handle backlog field gracefully (backward compatibility)', async () => {
      const context = new WorkflowContext(
        'compat-workflow-id',
        'test-project-id',
        '/tmp/test-repo',
        'main',
        { name: 'compat-workflow', version: '1.0', steps: [] },
        {}
      );

      const parserStep = new PMDecisionParserStep({
        name: 'parse_pm_decision',
        type: 'PMDecisionParserStep',
        config: {
          input: JSON.stringify({
            decision: 'defer',
            backlog: [
              { title: 'Old Backlog Task', priority: 'low' }
            ]
            // No follow_up_tasks (old format)
          }),
          normalize: true
        }
      });

      const result = await parserStep.execute(context);
      
      expect(result.status).toBe('success');
      expect(result.outputs?.pm_decision?.follow_up_tasks).toHaveLength(1);
      expect(result.outputs?.pm_decision?.follow_up_tasks[0].title).toBe('Old Backlog Task');
    });
  });
});
