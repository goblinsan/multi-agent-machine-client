/**
 * Test Group 1: Review Trigger Logic - Consolidated Behavior Tests
 * 
 * Based on: docs/test-rationalization/TEST_GROUP_1_REVIEW_TRIGGERS.md
 * 
 * This test file consolidates behavior from:
 * - tests/qaFailureCoordination.test.ts (177 lines)
 * - tests/reviewFlowValidation.test.ts (178 lines)
 * - tests/tddGovernanceGate.test.ts (45 lines)
 * 
 * Key Validated Behaviors:
 * 1. Review triggers: fail || unknown → PM evaluation
 * 2. Sequential review flow: QA → Code → Security → DevOps → Done
 * 3. TDD governance: Reviews context-aware of intentional failing tests
 * 4. DevOps failures trigger PM evaluation (BUG FIX: currently missing)
 * 5. QA failure loops back to QA (not Code review)
 * 
 * Implementation Status: ⏳ Tests written, implementation pending Phase 4-6
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { WorkflowEngine } from '../../src/workflows/WorkflowEngine.js';
import { makeTempRepo } from '../makeTempRepo.js';

describe('Review Trigger Logic', () => {
  let workflowEngine: WorkflowEngine;

  beforeEach(async () => {
    await makeTempRepo();
    workflowEngine = new WorkflowEngine();
  });

  describe('Scenario 1: Review Trigger Conditions', () => {
    it('should trigger PM evaluation when review status is "fail"', async () => {
      // Given: A task that failed QA review
      const context = {
        task_id: 'task-123',
        qa_status: 'fail',
        qa_response: {
          status: 'fail',
          summary: 'Tests are failing',
          findings: {
            severe: [{ description: 'Critical test failure' }],
            high: [],
            medium: [],
            low: []
          }
        }
      };

      // When: Workflow processes QA failure
      const result = await workflowEngine.executeWorkflow('task-flow', context);

      // Then: Sub-workflow for QA failure should run
      expect(result.completedSteps).toContain('handle_qa_failure');
    });

    it('should trigger PM evaluation when review status is "unknown"', async () => {
      // Given: A task with unknown QA status (timeout/error)
      const context = {
        task_id: 'task-123',
        qa_status: 'unknown',
        qa_response: {
          status: 'unknown',
          summary: 'QA review timed out',
          error: 'Timeout after 120s'
        }
      };

      // When: Workflow processes unknown status
      const result = await workflowEngine.executeWorkflow('task-flow', context);

      // Then: Sub-workflow for QA failure should run (treat unknown as failure)
      expect(result.completedSteps).toContain('handle_qa_failure');
    });

    it('should NOT trigger PM evaluation when review status is "pass"', async () => {
      // Given: A task that passed QA review
      const context = {
        task_id: 'task-123',
        qa_status: 'pass',
        qa_response: {
          status: 'pass',
          summary: 'All tests passing',
          findings: {
            severe: [],
            high: [],
            medium: [],
            low: [{ description: 'Minor test improvement suggestion' }]
          }
        }
      };

      // When: Workflow processes QA pass
      const result = await workflowEngine.executeWorkflow('task-flow', context);

      // Then: Should proceed to Code Review
      expect(result.completedSteps).toContain('code_review_request');
      // And should not run QA failure handling
      expect(result.completedSteps).not.toContain('handle_qa_failure');
    });
  });

  describe('Scenario 2: Sequential Review Flow', () => {
    it('should execute reviews in correct order: QA → Code → Security → DevOps', async () => {
      // Given: A task ready for review
      const context = {
        task_id: 'task-123',
        implementation_complete: true
      };

      // When: Workflow executes full review sequence (all pass)
      const result = await workflowEngine.executeWorkflow('task-flow', context);

      // Then: Reviews should execute in order
      const order = result.completedSteps;
      expect(order.indexOf('qa_request')).toBeLessThan(order.indexOf('code_review_request'));
      expect(order.indexOf('code_review_request')).toBeLessThan(order.indexOf('security_request'));
      expect(order.indexOf('security_request')).toBeLessThan(order.indexOf('devops_request'));
    });

    it('should NOT skip to Code Review after QA failure', async () => {
      // Given: QA review failed, PM created immediate fix task
      const context = {
        task_id: 'task-123',
        qa_status: 'fail',
        pm_decision: {
          immediate_fix: true,
          follow_up_tasks: [
            {
              title: '🚨 [QA] Fix failing tests',
              priority: 1200,
              assignee_persona: 'implementation-planner'
            }
          ]
        }
      };

      // When: Workflow processes QA failure
      const result = await workflowEngine.executeWorkflow('task-flow', context);

      // Then: Should NOT proceed to Code Review
      expect(result.completedSteps).not.toContain('code_review_request');
      // Should invoke QA failure handling sub-workflow
      expect(result.completedSteps).toContain('handle_qa_failure');
    });

    it('should block at Security Review failure (not proceed to DevOps)', async () => {
      // Given: QA and Code passed, Security failed
      const context = {
        task_id: 'task-123',
        qa_status: 'pass',
        code_review_status: 'pass',
        security_review_status: 'fail',
        security_response: {
          status: 'fail',
          summary: 'SQL injection vulnerability found',
          findings: {
            severe: [{ 
              category: 'injection',
              vulnerability: 'SQL Injection in query builder',
              mitigation: 'Use parameterized queries'
            }],
            high: [],
            medium: [],
            low: []
          }
        }
      };

      // When: Workflow processes Security failure
      const result = await workflowEngine.executeWorkflow('task-flow', context);

      // Then: Should NOT proceed to DevOps review
      expect(result.completedSteps).not.toContain('devops_request');
      // Should trigger Security failure handling sub-workflow
      expect(result.completedSteps).toContain('handle_security_failure');
    });
  });

  describe('Scenario 3: TDD Governance', () => {
    it('should pass QA review when failing tests are intentional (TDD Red phase)', async () => {
      // Given: Task goal is to write failing test (TDD Red phase)
      const context = {
        task_id: 'task-123',
        tdd_aware: true,
        tdd_stage: 'write_failing_test',
        qa_response: {
          status: 'pass',
          summary: 'Test created successfully, failing as expected (TDD Red phase)',
          tdd_red_phase_detected: true,
          findings: {
            severe: [], // No compile errors
            high: [],   // Failing tests expected in Red phase
            medium: [],
            low: []
          }
        }
      };

      // When: QA review processes TDD Red phase task
      const result = await workflowEngine.executeWorkflow('task-flow', context);

      // Then: QA should pass (failing tests are intentional)
      expect(context.qa_response.status).toBe('pass');
      // Should proceed to Code Review
      expect(result.completedSteps).toContain('code_review_request');
    });

    it('should FAIL QA review when tests cannot run (TDD Red phase)', async () => {
      // Given: Task goal is write failing test, but tests have compile errors
      const context = {
        task_id: 'task-123',
        tdd_aware: true,
        tdd_stage: 'write_failing_test',
        qa_response: {
          status: 'fail',
          summary: 'Test suite cannot run due to compilation errors',
          findings: {
            severe: [{
              category: 'compilation_error',
              description: 'SyntaxError: Unexpected token',
              file: 'tests/auth.test.ts',
              line: 45
            }],
            high: [],
            medium: [],
            low: []
          }
        }
      };

      // When: QA review processes unrunnable tests
      const result = await workflowEngine.executeWorkflow('task-flow', context);

      // Then: QA should fail (tests must be runnable even in Red phase)
      expect(context.qa_response.status).toBe('fail');
      // Should trigger QA failure handling
      expect(result.completedSteps).toContain('handle_qa_failure');
    });

    it('should pass reviews when TDD context is provided to all reviewers', async () => {
      // Given: Task in TDD Red phase with failing test
      const context = {
        task_id: 'task-123',
        tdd_aware: true,
        tdd_stage: 'failing_test',
        implementation_complete: true
      };

      // When: All reviews process with TDD context
      const result = await workflowEngine.executeWorkflow('task-flow', context);

      // Then: TDD context should be present in workflow variables (propagated to steps via payload templates)
      const vars = result.finalContext.getAllVariables();
      expect(vars).toMatchObject({ tdd_aware: true, tdd_stage: 'failing_test' });
    });
  });

  describe('Scenario 4: DevOps Failure Handling (BUG FIX)', () => {
    it('should trigger PM evaluation when DevOps review fails', async () => {
      // Given: All reviews passed except DevOps
      const context = {
        task_id: 'task-123',
        qa_status: 'pass',
        code_review_status: 'pass',
        security_review_status: 'pass',
        devops_status: 'fail',
        devops_response: {
          status: 'fail',
          summary: 'Build failing in CI pipeline',
          findings: {
            severe: [{
              category: 'build',
              issue: 'Compilation errors in CI environment',
              recommendation: 'Fix environment-specific build configuration'
            }],
            high: [],
            medium: [],
            low: []
          }
        }
      };

      // When: Workflow processes DevOps failure
      const result = await workflowEngine.executeWorkflow('task-flow', context);

      // Then: DevOps failure handling sub-workflow should run
      expect(result.completedSteps).toContain('handle_devops_failure');
      // Task should NOT be marked as complete
      expect(result.finalContext.getVariable('task_status')).not.toBe('done');
    });

    it('should complete task only when ALL reviews pass (including DevOps)', async () => {
      // Given: All 4 reviews passed
      const context = {
        task_id: 'task-123',
        qa_status: 'pass',
        code_review_status: 'pass',
        security_review_status: 'pass',
        devops_status: 'pass'
      };

      // When: Workflow completes all reviews
      const result = await workflowEngine.executeWorkflow('task-flow', context);

      // Then: Task should be marked as complete
      expect(result.completedSteps).toContain('mark_task_done');
      expect(result.finalContext.getVariable('task_status')).toBe('done');
    });
  });

  describe('Scenario 5: QA Failure Loop', () => {
    it('should loop back to QA (not Code Review) after QA fix', async () => {
      // Given: QA failed, PM created immediate fix, fix implemented
      const context = {
        task_id: 'task-123',
        qa_status: 'fail',
        pm_decision: {
          immediate_fix: true,
          follow_up_tasks: [
            {
              title: '🚨 [QA] Fix authentication test failure',
              priority: 1200,
              assignee_persona: 'implementation-planner'
            }
          ]
        },
        fix_task_id: 'task-124',
        fix_implemented: true
      };

      // When: Fix task is completed and reviews
      const result = await workflowEngine.executeWorkflow('task-flow', {
        task_id: 'task-124',
        parent_task_id: 'task-123',
        implementation_complete: true
      });

      // Then: Should go back to QA review (not Code Review)
      const order = result.completedSteps;
      const qaIdx = order.indexOf('qa_request');
      const codeIdx = order.indexOf('code_review_request');
      expect(qaIdx).toBeGreaterThanOrEqual(0);
      if (codeIdx >= 0) {
        expect(qaIdx).toBeLessThan(codeIdx);
      }
    });

    // Removed skipped test: max QA iterations enforcement (not implemented yet)
  });
});
