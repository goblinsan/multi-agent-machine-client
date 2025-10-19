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
      'src/workflows/definitions/legacy-compatible-task-flow.yaml'
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

    // Validate PM handles code review failures
    const pmCodeReview = steps['pm_prioritize_code_review_failures'];
    expect(pmCodeReview).toBeDefined();
    expect(pmCodeReview?.depends_on).toEqual(['code_review_request']);
    expect(pmCodeReview?.condition).toBe("${code_review_request_status} == 'fail'");
    expect(pmCodeReview?.config?.intent).toBe('prioritize_code_review_failures');

    // Validate security depends on code review passing
    const security = steps['security_request'];
    expect(security).toBeDefined();
    expect(security?.depends_on).toEqual(['code_review_request']);
    expect(security?.condition).toBe("${code_review_request_status} == 'pass'");
    expect(security?.outputs).toContain('security_request_status');

    // Validate PM handles security failures
    const pmSecurity = steps['pm_prioritize_security_failures'];
    expect(pmSecurity).toBeDefined();
    expect(pmSecurity?.depends_on).toEqual(['security_request']);
    expect(pmSecurity?.condition).toBe("${security_request_status} == 'fail'");
    expect(pmSecurity?.config?.intent).toBe('prioritize_security_failures');

    // Validate devops depends on security passing
    const devops = steps['devops_request'];
    expect(devops).toBeDefined();
    expect(devops?.depends_on).toEqual(['security_request']);
    expect(devops?.condition).toBe("${security_request_status} == 'pass'");

    // Validate task marked done only when security passes
    const markDone = steps['mark_task_done'];
    expect(markDone).toBeDefined();
    expect(markDone?.depends_on).toEqual(['devops_request']);
    expect(markDone?.condition).toBe("${security_request_status} == 'pass'");
    expect(markDone?.config?.status).toBe('done');
  });

  it('ensures QA iteration loop does not block mark_in_review when skipped', async () => {
    const steps = await loadWorkflowSteps();

    const qaIterationLoop = steps['qa_iteration_loop'];
    const markInReview = steps['mark_task_in_review'];

    // QA iteration loop only runs when QA fails
    expect(qaIterationLoop?.condition).toBe("${qa_request_status} == 'fail'");

    // mark_in_review should NOT depend on qa_iteration_loop
    // because qa_iteration_loop may be skipped if QA passes first time
    expect(markInReview?.depends_on).toEqual(['qa_request']);
    expect(markInReview?.depends_on).not.toContain('qa_iteration_loop');
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

    // Mark done waits for devops and security to pass
    expect(markDone?.depends_on).toEqual(['devops_request']);
    expect(markDone?.condition).toBe("${security_request_status} == 'pass'");
  });

  it('validates PM prioritization steps exist for review failures', async () => {
    const steps = await loadWorkflowSteps();

    // Both PM prioritization steps should exist
    expect(steps['pm_prioritize_code_review_failures']).toBeDefined();
    expect(steps['pm_prioritize_security_failures']).toBeDefined();

    // Both should use project-manager persona
    expect(steps['pm_prioritize_code_review_failures']?.config?.persona).toBe('project-manager');
    expect(steps['pm_prioritize_security_failures']?.config?.persona).toBe('project-manager');

    // Both should have appropriate intents
    expect(steps['pm_prioritize_code_review_failures']?.config?.intent).toBe('prioritize_code_review_failures');
    expect(steps['pm_prioritize_security_failures']?.config?.intent).toBe('prioritize_security_failures');
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
