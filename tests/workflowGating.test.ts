import { describe, it, expect } from 'vitest';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { parse } from 'yaml';

describe('legacy-compatible workflow gating', () => {
  it('requires QA success before downstream review personas run', async () => {
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
      }>;
    };

    const steps = Object.fromEntries(
      workflow.steps.map((step) => [step.name, step])
    );

  const planningLoopStep = steps['planning_loop'];
  const qaStep = steps['qa_request'];
  const markInProgressStep = steps['mark_task_in_progress'];
  const markInReviewStep = steps['mark_task_in_review'];
  
  expect(planningLoopStep).toBeDefined();
  expect(planningLoopStep?.depends_on).toEqual(['context_request']);
  expect(markInProgressStep).toBeDefined();
  expect(markInProgressStep?.depends_on).toEqual(['checkout_branch']);
  
  const codeReviewStep = steps['code_review_request'];
  const securityStep = steps['security_request'];
  const devopsStep = steps['devops_request'];
  const markDoneStep = steps['mark_task_done'];

    expect(qaStep).toBeDefined();
    expect(codeReviewStep).toBeDefined();
    expect(securityStep).toBeDefined();
    expect(devopsStep).toBeDefined();
    expect(markDoneStep).toBeDefined();
    expect(markInReviewStep).toBeDefined();

    // Mark in review happens when QA passes (depends only on qa_request, not qa_iteration_loop)
    // qa_iteration_loop may be skipped if QA passes first time, but that's OK because
    // the workflow engine now treats skipped steps as "executed" for dependency resolution
    expect(markInReviewStep?.depends_on).toEqual(['qa_request']);
    expect(markInReviewStep?.condition).toBe("${qa_request_status} == 'pass'");

    // Code review depends on mark_in_review and runs regardless of qa_request_status
    // (condition was removed since mark_in_review only runs when QA passes)
    expect(codeReviewStep?.depends_on).toEqual(['mark_task_in_review']);

    // Security depends on code review passing
    expect(securityStep?.depends_on).toEqual(['code_review_request']);
    expect(securityStep?.condition).toBe("${code_review_request_status} == 'pass'");

    // DevOps depends on security passing
    expect(devopsStep?.depends_on).toEqual(['security_request']);
    expect(devopsStep?.condition).toBe("${security_request_status} == 'pass'");

    // Mark done depends on security passing and devops completing
    expect(markDoneStep?.depends_on).toEqual(['devops_request']);
    expect(markDoneStep?.condition).toBe("${security_request_status} == 'pass'");
  });
});
