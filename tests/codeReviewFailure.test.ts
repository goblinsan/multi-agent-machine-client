import { describe, it, expect } from 'vitest';
import { ReviewFailureTasksStep } from '../src/workflows/steps/ReviewFailureTasksStep.js';

/**
 * ⚠️ DEPRECATED TEST SUITE - Superseded by Phase 4-5
 * 
 * This test suite validates ReviewFailureTasksStep which was replaced by:
 * - Phase 4: BulkTaskCreationStep with retry logic and idempotency
 * - Phase 5: Dashboard backend integration with external_id uniqueness
 * 
 * Current equivalent tests:
 * - tests/phase4/bulkTaskCreationStep.test.ts - Task creation with retries
 * - tests/phase5/dashboardIntegration.test.ts - Dashboard API integration
 * - scripts/test-dashboard-integration.ts - E2E integration tests (7/7 passing)
 * 
 * Original context preserved below for reference:
 * 
 * Production Bug (2025-10-19T03:33:17):
 * - Code reviewer returned fail status with SEVERE and HIGH findings
 * - PM was invoked and returned follow_up_tasks array with 2 tasks
 * - BUT: ReviewFailureTasksStep created 0 tasks
 * 
 * Root Cause:
 * - PM returns markdown-wrapped JSON: ```json\n{...}\n```
 * - PersonaRequestStep fails to JSON.parse it, stores as { raw: "..." }
 * - ReviewFailureTasksStep.parsePMDecision() receives { raw: "..." } object
 * - parsePMDecision() sees it's an object, returns it as-is
 * - But { raw: "..." } has no follow_up_tasks field!
 * 
 * Fix:
 * - parsePMDecision() now checks for raw field and extracts/parses it
 * 
 * Skip Reason: Superseded by Phase 4-5 workflow system
 * Date Skipped: October 20, 2025
 * Revisit: Post-deployment if regression testing needed
 */
describe.skip('Code Review Failure - PM Task Creation [DEPRECATED - Superseded by Phase 4-5]', () => {
  /**
   * Test validates workflow YAML conditions for code review failures
   */
  it('validates workflow YAML has code review failure handling', async () => {
    const { readFile } = await import('node:fs/promises');
    const path = await import('node:path');
    const { parse } = await import('yaml');
    
    const workflowPath = path.resolve(
      process.cwd(),
      'src/workflows/definitions/legacy-compatible-task-flow.yaml'
    );
    
    const workflowContent = await readFile(workflowPath, 'utf-8');
    const workflow = parse(workflowContent);
    
    // Find the code_review_request step
    const codeReviewStep = workflow.steps.find((s: any) => s.name === 'code_review_request');
    expect(codeReviewStep).toBeDefined();
    expect(codeReviewStep?.config?.persona).toBe('code-reviewer');
    
    // Find the pm_prioritize_code_review_failures step
    const pmStep = workflow.steps.find((s: any) => s.name === 'pm_prioritize_code_review_failures');
    expect(pmStep).toBeDefined();
    expect(pmStep?.config?.persona).toBe('project-manager');
    
    // CRITICAL: PM step must trigger on code review fail
    expect(pmStep.condition).toContain('code_review_request_status');
    expect(pmStep.condition).toContain('fail');
    
    // Find the create_code_review_followup_tasks step
    const createTasksStep = workflow.steps.find((s: any) => s.name === 'create_code_review_followup_tasks');
    expect(createTasksStep).toBeDefined();
    expect(createTasksStep?.type).toBe('ReviewFailureTasksStep');
    expect(createTasksStep?.config?.pmDecisionVariable).toBe('pm_code_review_decision');
  });

  /**
   * Test parsePMDecision handles markdown-wrapped JSON stored as { raw: "..." }
   * This is the production bug scenario
   */
  it('parsePMDecision extracts JSON from raw field', () => {
    const step = new ReviewFailureTasksStep({
      name: 'test',
      type: 'ReviewFailureTasksStep',
      config: {
        pmDecisionVariable: 'pm_decision',
        reviewType: 'code_review',
        urgentPriorityScore: 1000,
        deferredPriorityScore: 50
      }
    });

    // Simulate what PersonaRequestStep stores when JSON.parse fails on markdown-wrapped JSON
    const pmDecisionRaw = {
      raw: `\`\`\`json
{
  "status": "pass",
  "details": "Code review failures evaluated",
  "follow_up_tasks": [
    {
      "title": "Implement immediate fixes for SEVERE and HIGH findings",
      "description": "SEVERE and HIGH findings require immediate attention.",
      "priority": "high"
    },
    {
      "title": "Review project stage context for MEDIUM findings",
      "description": "MEDIUM findings should be addressed based on project stage context.",
      "priority": "medium"
    }
  ]
}
\`\`\``
    };

    // Access private method for testing
    const parsePMDecision = (step as any).parsePMDecision.bind(step);
    const parsed = parsePMDecision(pmDecisionRaw);

    // Verify parsing succeeded
    expect(parsed).toBeDefined();
    expect(parsed).not.toBeNull();
    
    // Verify follow_up_tasks array was extracted
    expect(parsed.follow_up_tasks).toBeDefined();
    expect(Array.isArray(parsed.follow_up_tasks)).toBe(true);
    expect(parsed.follow_up_tasks.length).toBe(2);
    
    // Verify task structure
    expect(parsed.follow_up_tasks[0]).toHaveProperty('title');
    expect(parsed.follow_up_tasks[0]).toHaveProperty('description');
    expect(parsed.follow_up_tasks[0]).toHaveProperty('priority');
  });

  /**
   * Test parsePMDecision handles backlog array (alternative PM response format)
   */
  it('parsePMDecision normalizes backlog to follow_up_tasks', () => {
    const step = new ReviewFailureTasksStep({
      name: 'test',
      type: 'ReviewFailureTasksStep',
      config: {
        pmDecisionVariable: 'pm_decision',
        reviewType: 'code_review',
        urgentPriorityScore: 1000,
        deferredPriorityScore: 50
      }
    });

    // PM response with backlog instead of follow_up_tasks
    const pmDecisionRaw = {
      raw: `\`\`\`json
{
  "status": "pass",
  "details": "Issues evaluated",
  "backlog": [
    {
      "title": "Address medium findings before merge",
      "description": "MEDIUM findings exist, should fix before merge.",
      "priority": "high"
    }
  ]
}
\`\`\``
    };

    const parsePMDecision = (step as any).parsePMDecision.bind(step);
    const parsed = parsePMDecision(pmDecisionRaw);

    // Verify backlog was normalized to follow_up_tasks
    expect(parsed).toBeDefined();
    expect(parsed.follow_up_tasks).toBeDefined();
    expect(Array.isArray(parsed.follow_up_tasks)).toBe(true);
    expect(parsed.follow_up_tasks.length).toBe(1);
    expect(parsed.follow_up_tasks[0].title).toContain('medium findings');
  });

  /**
   * Test parsePMDecision handles direct string input (no raw wrapper)
   */
  it('parsePMDecision handles markdown-wrapped JSON string', () => {
    const step = new ReviewFailureTasksStep({
      name: 'test',
      type: 'ReviewFailureTasksStep',
      config: {
        pmDecisionVariable: 'pm_decision',
        reviewType: 'code_review',
        urgentPriorityScore: 1000,
        deferredPriorityScore: 50
      }
    });

    // Direct string input (markdown-wrapped JSON)
    const pmDecisionRaw = `\`\`\`json
{
  "status": "pass",
  "follow_up_tasks": [
    {
      "title": "Fix the issue",
      "description": "Address the issue found",
      "priority": "high"
    }
  ]
}
\`\`\``;

    const parsePMDecision = (step as any).parsePMDecision.bind(step);
    const parsed = parsePMDecision(pmDecisionRaw);

    // Verify parsing succeeded
    expect(parsed).toBeDefined();
    expect(parsed.follow_up_tasks).toBeDefined();
    expect(Array.isArray(parsed.follow_up_tasks)).toBe(true);
    expect(parsed.follow_up_tasks.length).toBe(1);
  });

  /**
   * Test parsePMDecision handles already-parsed object
   */
  it('parsePMDecision handles already-parsed PM decision object', () => {
    const step = new ReviewFailureTasksStep({
      name: 'test',
      type: 'ReviewFailureTasksStep',
      config: {
        pmDecisionVariable: 'pm_decision',
        reviewType: 'code_review',
        urgentPriorityScore: 1000,
        deferredPriorityScore: 50
      }
    });

    // Already-parsed object (ideal case if PersonaRequestStep succeeds)
    const pmDecisionRaw = {
      status: "pass",
      follow_up_tasks: [
        {
          title: "Fix critical bugs",
          description: "Address critical issues",
          priority: "high"
        }
      ]
    };

    const parsePMDecision = (step as any).parsePMDecision.bind(step);
    const parsed = parsePMDecision(pmDecisionRaw);

    // Verify it's returned as-is
    expect(parsed).toBeDefined();
    expect(parsed.follow_up_tasks).toBeDefined();
    expect(parsed.follow_up_tasks.length).toBe(1);
  });
});
