/**
 * Test: TDD Context in Review Payloads
 * 
 * Business Intent:
 * - Code and security reviewers should receive TDD context (tdd_aware, tdd_stage)
 * - Reviewers need to understand when failing tests are EXPECTED (write_failing_test, failing_test stages)
 * - This prevents reviewers from blocking tasks that intentionally have failing tests during TDD workflow
 * 
 * Context:
 * - PM evaluation already receives TDD context (verified in review-failure-handling.yaml)
 * - This test ensures initial reviewers also receive TDD context before failures occur
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import * as yaml from 'yaml';

describe('TDD Context in Review Payloads', () => {
  const taskFlowPath = join(__dirname, '../src/workflows/definitions/task-flow.yaml');
  const inReviewFlowPath = join(__dirname, '../src/workflows/definitions/in-review-task-flow.yaml');

  it('task-flow.yaml: code_review_request should include tdd_aware and tdd_stage', () => {
    const content = readFileSync(taskFlowPath, 'utf-8');
    const workflow = yaml.parse(content);

    const codeReviewStep = workflow.steps.find(
      (s: any) => s.name === 'code_review_request'
    );

    expect(codeReviewStep).toBeDefined();
    expect(codeReviewStep.type).toBe('PersonaRequestStep');
    expect(codeReviewStep.config.payload).toBeDefined();

    // Assert TDD context is included in payload
    expect(codeReviewStep.config.payload.tdd_aware).toBe('${tdd_aware}');
    expect(codeReviewStep.config.payload.tdd_stage).toBe('${tdd_stage}');
  });

  it('task-flow.yaml: security_request should include tdd_aware and tdd_stage', () => {
    const content = readFileSync(taskFlowPath, 'utf-8');
    const workflow = yaml.parse(content);

    const securityStep = workflow.steps.find(
      (s: any) => s.name === 'security_request'
    );

    expect(securityStep).toBeDefined();
    expect(securityStep.type).toBe('PersonaRequestStep');
    expect(securityStep.config.payload).toBeDefined();

    // Assert TDD context is included in payload
    expect(securityStep.config.payload.tdd_aware).toBe('${tdd_aware}');
    expect(securityStep.config.payload.tdd_stage).toBe('${tdd_stage}');
  });

  it('in-review-task-flow.yaml: code_review_request should include tdd_aware and tdd_stage', () => {
    const content = readFileSync(inReviewFlowPath, 'utf-8');
    const workflow = yaml.parse(content);

    const codeReviewStep = workflow.steps.find(
      (s: any) => s.name === 'code_review_request'
    );

    expect(codeReviewStep).toBeDefined();
    expect(codeReviewStep.type).toBe('PersonaRequestStep');
    expect(codeReviewStep.config.payload).toBeDefined();

    // Assert TDD context is included in payload
    expect(codeReviewStep.config.payload.tdd_aware).toBe('${tdd_aware}');
    expect(codeReviewStep.config.payload.tdd_stage).toBe('${tdd_stage}');
  });

  it('in-review-task-flow.yaml: security_request should include tdd_aware and tdd_stage', () => {
    const content = readFileSync(inReviewFlowPath, 'utf-8');
    const workflow = yaml.parse(content);

    const securityStep = workflow.steps.find(
      (s: any) => s.name === 'security_request'
    );

    expect(securityStep).toBeDefined();
    expect(securityStep.type).toBe('PersonaRequestStep');
    expect(securityStep.config.payload).toBeDefined();

    // Assert TDD context is included in payload
    expect(securityStep.config.payload.tdd_aware).toBe('${tdd_aware}');
    expect(securityStep.config.payload.tdd_stage).toBe('${tdd_stage}');
  });

  it('review-failure-handling.yaml: PM evaluation receives TDD context (regression test)', () => {
    const subWorkflowPath = join(__dirname, '../src/workflows/sub-workflows/review-failure-handling.yaml');
    const content = readFileSync(subWorkflowPath, 'utf-8');
    const workflow = yaml.parse(content);

    // Verify inputs are documented (YAML comments, not schema)
    expect(content).toContain('tdd_aware');
    expect(content).toContain('tdd_stage');

    // Verify PM evaluation step receives TDD context (with defaults)
    const pmEvalStep = workflow.steps.find(
      (s: any) => s.name === 'pm_evaluation'
    );

    expect(pmEvalStep).toBeDefined();
    expect(pmEvalStep.config.payload.tdd_aware).toBe('${tdd_aware || false}');
    expect(pmEvalStep.config.payload.tdd_stage).toBe("${tdd_stage || 'implementation'}");
  });
});
