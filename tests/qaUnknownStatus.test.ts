import { describe, it, expect } from 'vitest';

describe('QA Unknown Status Handling', () => {
  /**
   * This test validates the workflow YAML conditions were fixed to handle unknown QA status.
   * 
   * Production scenario discovered on 2025-10-19:
   * - QA agent runs tests, all pass (3 passed, 0 failed)
   * - QA agent identifies issues and recommendations
   * - QA agent returns status: "UNKNOWN" (no explicit status field)
   * - System should trigger PM coordination to create follow-up tasks
   * 
   * Bug: workflow conditions only checked for 'fail', not 'unknown'
   * Fix: Updated conditions to include both 'fail' and 'unknown'
   */
  it('validates workflow YAML conditions include unknown status', async () => {
    const { readFile } = await import('node:fs/promises');
    const path = await import('node:path');
    const { parse } = await import('yaml');
    
    const workflowPath = path.resolve(
      process.cwd(),
      'src/workflows/definitions/legacy-compatible-task-flow.yaml'
    );
    
    const workflowContent = await readFile(workflowPath, 'utf-8');
    const workflow = parse(workflowContent);
    
    // Find the qa_failure_coordination step
    const qaFailureStep = workflow.steps.find((s: any) => s.name === 'qa_failure_coordination');
    expect(qaFailureStep).toBeDefined();
    expect(qaFailureStep?.condition).toBeDefined();
    
    // CRITICAL: Condition must include both 'fail' AND 'unknown'
    // This regex checks for the exact pattern we need
    const conditionPattern = /\$\{qa_request_status\}\s*==\s*'fail'\s*\|\|\s*\$\{qa_request_status\}\s*==\s*'unknown'/;
    expect(qaFailureStep.condition).toMatch(conditionPattern);
    
    // Find the qa_iteration_loop step
    const qaIterationLoop = workflow.steps.find((s: any) => s.name === 'qa_iteration_loop');
    expect(qaIterationLoop).toBeDefined();
    expect(qaIterationLoop?.condition).toBeDefined();
    
    // CRITICAL: Iteration loop must also include both 'fail' AND 'unknown'
    expect(qaIterationLoop.condition).toMatch(conditionPattern);
    
    // Verify the conditions contain 'unknown' (string search as additional validation)
    expect(qaFailureStep.condition).toContain('unknown');
    expect(qaIterationLoop.condition).toContain('unknown');
    
    // Verify the conditions contain 'fail'
    expect(qaFailureStep.condition).toContain('fail');
    expect(qaIterationLoop.condition).toContain('fail');
  });

  it('validates QA coordination is triggered for unknown but NOT for pass', async () => {
    const { readFile } = await import('node:fs/promises');
    const path = await import('node:path');
    const { parse } = await import('yaml');
    
    const workflowPath = path.resolve(
      process.cwd(),
      'src/workflows/definitions/legacy-compatible-task-flow.yaml'
    );
    
    const workflowContent = await readFile(workflowPath, 'utf-8');
    const workflow = parse(workflowContent);
    
    const qaFailureStep = workflow.steps.find((s: any) => s.name === 'qa_failure_coordination');
    const markInReviewStep = workflow.steps.find((s: any) => s.name === 'mark_task_in_review');
    
    // QA failure coordination should only run for fail or unknown, NOT pass
    expect(qaFailureStep.condition).not.toContain("== 'pass'");
    
    // mark_in_review should run after qa_request regardless of status
    expect(markInReviewStep?.depends_on).toContain('qa_request');
  });

  it('validates QAFailureCoordinationStep handles unknown status', async () => {
    const { readFile } = await import('node:fs/promises');
    const path = await import('node:path');
    
    const stepFilePath = path.resolve(
      process.cwd(),
      'src/workflows/steps/QAFailureCoordinationStep.ts'
    );
    
    const stepContent = await readFile(stepFilePath, 'utf-8');
    
    // Verify the TypeScript code treats unknown same as fail
    expect(stepContent).toMatch(/qaStatus\.status\s*!==\s*'fail'\s*&&\s*qaStatus\.status\s*!==\s*'unknown'/);
    
    // Verify it logs when unknown status is detected
    expect(stepContent).toContain('isUnknownStatus');
  });
});
