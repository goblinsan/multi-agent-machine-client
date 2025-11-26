import { describe, it, expect, beforeEach } from "vitest";
import { WorkflowContext } from "../../src/workflows/engine/WorkflowContext.js";
import { ReviewFollowUpAutoSynthesisStep } from "../../src/workflows/steps/ReviewFollowUpAutoSynthesisStep.js";
import { ReviewFollowUpMergeStep } from "../../src/workflows/steps/ReviewFollowUpMergeStep.js";

describe("ReviewFollowUpAutoSynthesisStep", () => {
  let context: WorkflowContext;

  beforeEach(() => {
    context = new WorkflowContext(
      "wf-auto-followups",
      "proj-123",
      "/tmp/repo",
      "main",
      { name: "auto", version: "1.0.0", steps: [] },
      {},
      {},
    );
  });

  it("generates testing-focused follow-ups for blocking QA issues", async () => {
    const step = new ReviewFollowUpAutoSynthesisStep({
      name: "auto_follow_up_synthesis",
      type: "ReviewFollowUpAutoSynthesisStep",
      config: {
        review_type: "qa",
        normalized_review: {
          reviewType: "qa",
          blockingIssues: [
            {
              id: "qa-1",
              title: "No test framework detected",
              description: "QA reviewer could not run tests because no test framework exists",
              severity: "critical",
              blocking: true,
              labels: ["infra"],
            },
          ],
          hasBlockingIssues: true,
        },
        review_result: null,
        external_id_base: "qa-42",
      },
    });

    const result = await step.execute(context);

    expect(result.status).toBe("success");
    expect(result.outputs?.auto_follow_up_tasks).toHaveLength(1);
    const task = result.outputs?.auto_follow_up_tasks?.[0];
    expect(task?.metadata?.auto_generated).toBe(true);
    expect(task?.metadata?.flags?.testing_gap).toBe(true);
    expect(task?.labels).toContain("qa");
    expect(task?.labels).toContain("needs-pm-triage");
    expect(task?.priority).toBe("critical");
    expect(task?.external_id).toBe("qa-42-auto-qa-1");
  });

  it("derives follow-ups from root cause analyses when normalization is empty", async () => {
    const step = new ReviewFollowUpAutoSynthesisStep({
      name: "auto_follow_up_synthesis",
      type: "ReviewFollowUpAutoSynthesisStep",
      config: {
        review_type: "security_review",
        normalized_review: { reviewType: "security_review", blockingIssues: [] },
        review_result: {
          qa_root_cause_analyses: [
            {
              failing_capability: "Auth",
              qa_gaps: ["Missing CSRF coverage"],
            },
          ],
        },
      },
    });

    const result = await step.execute(context);

    expect(result.outputs?.auto_follow_up_tasks).toHaveLength(1);
    const [task] = result.outputs?.auto_follow_up_tasks ?? [];
    expect(task.labels).toContain("security_review");
    expect(task.labels).toContain("needs-pm-triage");
    expect(task.branch_locks?.[0]).toEqual({ branch: "main", policy: "block" });
  });
});

describe("ReviewFollowUpMergeStep", () => {
  let context: WorkflowContext;

  beforeEach(() => {
    context = new WorkflowContext(
      "wf-merge-followups",
      "proj-456",
      "/tmp/repo",
      "main",
      { name: "auto", version: "1.0.0", steps: [] },
      {},
      {},
    );
  });

  it("deduplicates identical titles and descriptions when merging", async () => {
    const step = new ReviewFollowUpMergeStep({
      name: "merge_follow_up_tasks",
      type: "ReviewFollowUpMergeStep",
      config: {
        auto_follow_up_tasks: [
          {
            title: "Restore vitest harness",
            description: "QA could not run tests",
            metadata: { fingerprint: "qa-1", auto_generated: true },
          },
        ],
        pm_follow_up_tasks: [
          {
            title: "Restore vitest harness",
            description: "QA could not run tests",
          },
        ],
      },
    });

    const result = await step.execute(context);

    expect(result.status).toBe("success");
    expect(result.outputs?.merged_tasks).toHaveLength(1);
    expect(result.outputs?.merged_tasks?.[0].title).toBe("Restore vitest harness");
  });
});
