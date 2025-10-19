import { describe, it, expect } from 'vitest';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { parse } from 'yaml';

/**
 * Test suite to validate the complete review flow:
 * QA pass → in_review status → code review → security review → done
 * 
 * With failure handling:
 * - Code review fail → PM prioritization
 * - Security review fail → PM prioritization
 */
describe('Review Flow Validation', () => {
  async function loadWorkflowSteps() {
    const workflowPath = path.resolve(
      process.cwd(),
      'src/workflows/definitions/task-flow.yaml'  // Updated from legacy-compatible-task-flow.yaml
    );
    const fileContent = await readFile(workflowPath, 'utf-8');
    const workflow = parse(fileContent) as {
      steps: Array<{
        name: string;
        depends_on?: string[];
        condition?: string;
        config?: any;
        outputs?: string[];
      }>;
    };
    return Object.fromEntries(
      workflow.steps.map((step) => [step.name, step])
    );
  }

  it('validates workflow structure: QA pass → mark in_review → code review → security → done', async () => {
    const steps = await loadWorkflowSteps();

    // Validate QA pass leads to mark_task_in_review
    const markInReview = steps['mark_task_in_review'];
    expect(markInReview).toBeDefined();
    expect(markInReview?.depends_on).toEqual(['qa_request']);
    expect(markInReview?.condition).toBe("${qa_request_status} == 'pass'");
    expect(markInReview?.config?.status).toBe('in_review');

    // Validate code review depends on mark_in_review (not on QA status)
    const codeReview = steps['code_review_request'];
    expect(codeReview).toBeDefined();
    expect(codeReview?.depends_on).toEqual(['mark_task_in_review']);
    expect(codeReview?.condition).toBeUndefined(); // No condition - always runs after mark_in_review
    expect(codeReview?.outputs).toContain('code_review_request_status');

    // Validate PM handles code review failures (modern workflow uses SubWorkflowStep)
    const handleCodeReviewFailure = steps['handle_code_review_failure'];
    expect(handleCodeReviewFailure).toBeDefined();
    expect(handleCodeReviewFailure?.depends_on).toEqual(['code_review_request']);
    expect(handleCodeReviewFailure?.condition).toBe("${code_review_request_status} == 'fail' || ${code_review_request_status} == 'unknown'");
    expect(handleCodeReviewFailure?.config?.workflow).toBe('review-failure-handling');

    // Validate security depends on code review passing
    const security = steps['security_request'];
    expect(security).toBeDefined();
    expect(security?.depends_on).toEqual(['code_review_request']);
    expect(security?.condition).toBe("${code_review_request_status} == 'pass'");
    expect(security?.outputs).toContain('security_request_status');

    // Validate PM handles security failures (modern workflow uses SubWorkflowStep)
    const handleSecurityFailure = steps['handle_security_failure'];
    expect(handleSecurityFailure).toBeDefined();
    expect(handleSecurityFailure?.depends_on).toEqual(['security_request']);
    expect(handleSecurityFailure?.condition).toBe("${security_request_status} == 'fail' || ${security_request_status} == 'unknown'");
    expect(handleSecurityFailure?.config?.workflow).toBe('review-failure-handling');

    // Validate devops depends on security passing
    const devops = steps['devops_request'];
    expect(devops).toBeDefined();
    expect(devops?.depends_on).toEqual(['security_request']);
    expect(devops?.condition).toBe("${security_request_status} == 'pass'");

    // Validate PM handles DevOps failures (modern workflow)
    const handleDevOpsFailure = steps['handle_devops_failure'];
    expect(handleDevOpsFailure).toBeDefined();
    expect(handleDevOpsFailure?.depends_on).toEqual(['devops_request']);
    expect(handleDevOpsFailure?.condition).toBe("${devops_request_status} == 'fail' || ${devops_request_status} == 'unknown'");
    expect(handleDevOpsFailure?.config?.workflow).toBe('review-failure-handling');

    // Validate task marked done only when DevOps passes (modern workflow)
    const markDone = steps['mark_task_done'];
    expect(markDone).toBeDefined();
    expect(markDone?.depends_on).toEqual(['devops_request']);
    expect(markDone?.condition).toBe("${devops_request_status} == 'pass'");
    expect(markDone?.config?.status).toBe('done');
  });

  it('ensures QA failure handling does not block mark_in_review when skipped', async () => {
    const steps = await loadWorkflowSteps();

    const handleQaFailure = steps['handle_qa_failure'];
    const markInReview = steps['mark_task_in_review'];

    // QA failure handler only runs when QA fails or returns unknown status
    expect(handleQaFailure?.condition).toBe("${qa_request_status} == 'fail' || ${qa_request_status} == 'unknown'");

    // mark_in_review should NOT depend on handle_qa_failure
    // because handle_qa_failure may be skipped if QA passes first time
    expect(markInReview?.depends_on).toEqual(['qa_request']);
    expect(markInReview?.depends_on).not.toContain('handle_qa_failure');
  });

  it('validates review flow is sequential: code review → security → devops → done', async () => {
    const steps = await loadWorkflowSteps();

    const codeReview = steps['code_review_request'];
    const security = steps['security_request'];
    const devops = steps['devops_request'];
    const markDone = steps['mark_task_done'];

    // Code review runs first (after mark_in_review)
    expect(codeReview?.depends_on).toEqual(['mark_task_in_review']);

    // Security waits for code review to pass
    expect(security?.depends_on).toEqual(['code_review_request']);
    expect(security?.condition).toBe("${code_review_request_status} == 'pass'");

    // DevOps waits for security to pass
    expect(devops?.depends_on).toEqual(['security_request']);
    expect(devops?.condition).toBe("${security_request_status} == 'pass'");

    // Mark done waits for devops to pass (task-flow.yaml only checks devops since it's the last review)
    expect(markDone?.depends_on).toEqual(['devops_request']);
    expect(markDone?.condition).toBe("${devops_request_status} == 'pass'");
  });

  it('validates review failure handling steps exist for all review types', async () => {
    const steps = await loadWorkflowSteps();

    // All review failure handlers should exist (modern workflow pattern)
    expect(steps['handle_code_review_failure']).toBeDefined();
    expect(steps['handle_security_failure']).toBeDefined();
    expect(steps['handle_devops_failure']).toBeDefined();

    // All should use SubWorkflowStep calling review-failure-handling
    expect(steps['handle_code_review_failure']?.config?.workflow).toBe('review-failure-handling');
    expect(steps['handle_security_failure']?.config?.workflow).toBe('review-failure-handling');
    expect(steps['handle_devops_failure']?.config?.workflow).toBe('review-failure-handling');

    // All should have review_type input
    expect(steps['handle_code_review_failure']?.config?.inputs?.review_type).toBe('code_review');
    expect(steps['handle_security_failure']?.config?.inputs?.review_type).toBe('security_review');
    expect(steps['handle_devops_failure']?.config?.inputs?.review_type).toBe('devops');
  });

  it('validates workflow does not have circular dependencies in review flow', async () => {
    const steps = await loadWorkflowSteps();

    const visited = new Set<string>();
    const recursionStack = new Set<string>();

    function hasCycle(stepName: string): boolean {
      if (recursionStack.has(stepName)) {
        return true; // Found a cycle
      }
      if (visited.has(stepName)) {
        return false; // Already checked this path
      }

      visited.add(stepName);
      recursionStack.add(stepName);

      const step = steps[stepName];
      if (step?.depends_on) {
        for (const dep of step.depends_on) {
          if (hasCycle(dep)) {
            return true;
          }
        }
      }

      recursionStack.delete(stepName);
      return false;
    }

    // Check all steps for cycles
    for (const stepName of Object.keys(steps)) {
      expect(hasCycle(stepName)).toBe(false);
    }
  });
});
