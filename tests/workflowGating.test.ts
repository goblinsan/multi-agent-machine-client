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
  expect(planningLoopStep).toBeDefined();
  expect(planningLoopStep?.depends_on).toEqual(['context_request']);
    const codeReviewStep = steps['code_review_request'];
    const securityStep = steps['security_request'];
    const devopsStep = steps['devops_request'];
    const markDoneStep = steps['mark_task_done'];

    expect(qaStep).toBeDefined();
    expect(codeReviewStep).toBeDefined();
    expect(securityStep).toBeDefined();
    expect(devopsStep).toBeDefined();
    expect(markDoneStep).toBeDefined();

    // Code review depends on qa_request AND qa_iteration_loop (which runs if QA initially fails)
    expect(codeReviewStep?.depends_on).toEqual(['qa_request', 'qa_iteration_loop']);
    expect(codeReviewStep?.condition).toBe("${qa_request_status} == 'pass'");

    // Security also depends on both QA and potential iteration loop
    expect(securityStep?.depends_on).toEqual(['qa_request', 'qa_iteration_loop']);
    expect(securityStep?.condition).toBe("${qa_request_status} == 'pass'");

    expect(devopsStep?.depends_on).toEqual(['code_review_request', 'security_request']);
    expect(devopsStep?.condition).toBe("${qa_request_status} == 'pass'");

    expect(markDoneStep?.depends_on).toEqual([
      'security_request',
      'devops_request',
      'code_review_request'
    ]);
  });
});
