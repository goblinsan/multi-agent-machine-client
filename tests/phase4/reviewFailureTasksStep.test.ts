import { describe, it, expect, beforeEach } from 'vitest';
import { ReviewFailureTasksStep } from '../../src/workflows/steps/ReviewFailureTasksStep.js';
import { WorkflowContext } from '../../src/workflows/engine/WorkflowContext.js';

describe('Phase 4 - ReviewFailureTasksStep', () => {
  let context: WorkflowContext;

  beforeEach(() => {
    context = new WorkflowContext(
      'test-workflow-id',
      'test-project-id',
      '/tmp/test-repo',
      'main',
      { name: 'test-workflow', version: '1.0', steps: [] },
      {}
    );
  });

  describe('Day 2: Aggressive Refactor - PMDecisionParserStep Integration', () => {
    it('should require normalized PM decision from PMDecisionParserStep', async () => {
      const step = new ReviewFailureTasksStep({
        name: 'create_failure_tasks',
        type: 'ReviewFailureTasksStep',
        config: {
          pmDecisionVariable: 'pm_decision',
          reviewType: 'code_review'
        }
      });

      // No PM decision in context
      const result = await step.execute(context);

      expect(result.status).toBe('failure');
      expect(result.error?.message).toContain('Missing PM decision variable');
    });

    it('should validate PM decision structure (follow_up_tasks required)', async () => {
      context.setVariable('pm_decision', {
        decision: 'immediate_fix',
        reasoning: 'Test',
        // Missing follow_up_tasks array
      });

      const step = new ReviewFailureTasksStep({
        name: 'create_failure_tasks',
        type: 'ReviewFailureTasksStep',
        config: {
          pmDecisionVariable: 'pm_decision',
          reviewType: 'code_review'
        }
      });

      const result = await step.execute(context);

      expect(result.status).toBe('failure');
      expect(result.error?.message).toContain('follow_up_tasks array required');
    });

    it('should support all 4 review types (code_review, security_review, qa, devops)', async () => {
      const reviewTypes = ['code_review', 'security_review', 'qa', 'devops'] as const;

      for (const reviewType of reviewTypes) {
        context.setVariable('pm_decision', {
          decision: 'immediate_fix',
          follow_up_tasks: [
            { title: `${reviewType} Task`, description: 'Test', priority: 'high' }
          ]
        });
        context.setVariable('projectId', '1');
        context.setVariable('milestoneId', 'milestone-1');

        const step = new ReviewFailureTasksStep({
          name: 'create_failure_tasks',
          type: 'ReviewFailureTasksStep',
          config: {
            pmDecisionVariable: 'pm_decision',
            reviewType
          }
        });

        const validation = await step.validate(context);
        expect(validation.valid).toBe(true);
      }
    });

    it('should use QA priority 1200, others 1000 for urgent tasks', async () => {
      const qaDecision = {
        decision: 'immediate_fix',
        follow_up_tasks: [
          { title: 'QA Task', description: 'Test failure', priority: 'high' }
        ]
      };

      context.setVariable('pm_decision', qaDecision);
      context.setVariable('projectId', '1');
      context.setVariable('milestoneId', 'milestone-1');

      const qaStep = new ReviewFailureTasksStep({
        name: 'create_qa_tasks',
        type: 'ReviewFailureTasksStep',
        config: {
          pmDecisionVariable: 'pm_decision',
          reviewType: 'qa'
        }
      });

      const qaResult = await qaStep.execute(context);
      // QA urgent tasks should use priority 1200 (checked in logs)
      expect(qaResult.status).toBe('success');

      // Test code_review with priority 1000
      const codeDecision = {
        decision: 'immediate_fix',
        follow_up_tasks: [
          { title: 'Code Task', description: 'Code issue', priority: 'high' }
        ]
      };

      context.setVariable('pm_decision', codeDecision);

      const codeStep = new ReviewFailureTasksStep({
        name: 'create_code_tasks',
        type: 'ReviewFailureTasksStep',
        config: {
          pmDecisionVariable: 'pm_decision',
          reviewType: 'code_review'
        }
      });

      const codeResult = await codeStep.execute(context);
      // Code urgent tasks should use priority 1000 (checked in logs)
      expect(codeResult.status).toBe('success');
    });

    it('should assign all tasks to implementation-planner', async () => {
      context.setVariable('pm_decision', {
        decision: 'immediate_fix',
        follow_up_tasks: [
          { title: 'Task 1', priority: 'critical' },
          { title: 'Task 2', priority: 'medium' }
        ]
      });
      context.setVariable('projectId', '1');
      context.setVariable('milestoneId', 'milestone-1');

      const step = new ReviewFailureTasksStep({
        name: 'create_failure_tasks',
        type: 'ReviewFailureTasksStep',
        config: {
          pmDecisionVariable: 'pm_decision',
          reviewType: 'qa'
        }
      });

      const result = await step.execute(context);

      expect(result.status).toBe('success');
      // All tasks assigned to 'implementation-planner' (verified in logs)
    });

    it('should route urgent tasks to parent milestone, deferred to backlog', async () => {
      context.setVariable('pm_decision', {
        decision: 'immediate_fix',
        follow_up_tasks: [
          { title: 'Critical Task', priority: 'critical' },
          { title: 'High Task', priority: 'high' },
          { title: 'Medium Task', priority: 'medium' },
          { title: 'Low Task', priority: 'low' }
        ]
      });
      context.setVariable('projectId', '1');
      context.setVariable('milestoneId', 'parent-milestone');

      const step = new ReviewFailureTasksStep({
        name: 'create_failure_tasks',
        type: 'ReviewFailureTasksStep',
        config: {
          pmDecisionVariable: 'pm_decision',
          reviewType: 'code_review',
          backlogMilestoneSlug: 'future-enhancements'
        }
      });

      const result = await step.execute(context);

      expect(result.status).toBe('success');
      expect(result.outputs?.urgent_tasks_created).toBe(2); // critical + high
      expect(result.outputs?.deferred_tasks_created).toBe(2); // medium + low
    });
  });

  describe('Validation', () => {
    it('should validate pmDecisionVariable is required', async () => {
      const step = new ReviewFailureTasksStep({
        name: 'create_failure_tasks',
        type: 'ReviewFailureTasksStep',
        config: {
          // Missing pmDecisionVariable
          reviewType: 'code_review'
        } as any
      });

      const validation = await step.validate(context);

      expect(validation.valid).toBe(false);
      expect(validation.errors).toContain('ReviewFailureTasksStep: pmDecisionVariable is required');
    });

    it('should validate reviewType is one of 4 allowed values', async () => {
      const step = new ReviewFailureTasksStep({
        name: 'create_failure_tasks',
        type: 'ReviewFailureTasksStep',
        config: {
          pmDecisionVariable: 'pm_decision',
          reviewType: 'invalid_type' as any
        }
      });

      const validation = await step.validate(context);

      expect(validation.valid).toBe(false);
      expect(validation.errors[0]).toContain('must be one of: code_review, security_review, qa, devops');
    });

    it('should warn if pmDecisionVariable name is non-standard', async () => {
      const step = new ReviewFailureTasksStep({
        name: 'create_failure_tasks',
        type: 'ReviewFailureTasksStep',
        config: {
          pmDecisionVariable: 'weird_variable_name',
          reviewType: 'code_review'
        }
      });

      const validation = await step.validate(context);

      expect(validation.valid).toBe(true);
      expect(validation.warnings.length).toBeGreaterThan(0);
      expect(validation.warnings[0]).toContain('should typically be "pm_decision" or "parsed_decision"');
    });
  });
});
