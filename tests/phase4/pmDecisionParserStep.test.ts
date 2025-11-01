import { describe, it, expect, beforeEach } from "vitest";
import { PMDecisionParserStep } from "../../src/workflows/steps/PMDecisionParserStep.js";
import { WorkflowContext } from "../../src/workflows/engine/WorkflowContext.js";
import type { WorkflowStepConfig } from "../../src/workflows/engine/WorkflowStep.js";

describe("Phase 4 - PMDecisionParserStep", () => {
  let context: WorkflowContext;

  beforeEach(() => {
    context = new WorkflowContext(
      "test-workflow-id",
      "test-project-id",
      "/tmp/test-repo",
      "main",
      { name: "test-workflow", version: "1.0", steps: [] },
      {},
    );
  });

  describe("Day 1: Backlog Deprecation & Validation", () => {
    it("should merge backlog and follow_up_tasks arrays", async () => {
      const step = new PMDecisionParserStep({
        name: "parse_pm_decision",
        type: "PMDecisionParserStep",
        config: {
          input: JSON.stringify({
            decision: "immediate_fix",
            reasoning: "Test merge",
            backlog: [
              {
                title: "Backlog Task 1",
                description: "From backlog",
                priority: "low",
              },
              {
                title: "Backlog Task 2",
                description: "From backlog",
                priority: "medium",
              },
            ],
            follow_up_tasks: [
              {
                title: "Follow-up Task 1",
                description: "From follow_up",
                priority: "high",
              },
            ],
          }),
          normalize: true,
        },
      });

      const result = await step.execute(context);

      expect(result.status).toBe("success");
      expect(result.outputs?.pm_decision?.follow_up_tasks).toHaveLength(3);
      expect(result.outputs?.pm_decision?.follow_up_tasks[0].title).toBe(
        "Follow-up Task 1",
      );
      expect(result.outputs?.pm_decision?.follow_up_tasks[1].title).toBe(
        "Backlog Task 1",
      );
      expect(result.outputs?.pm_decision?.follow_up_tasks[2].title).toBe(
        "Backlog Task 2",
      );
    });

    it("should log warning when backlog field is present", async () => {
      const step = new PMDecisionParserStep({
        name: "parse_pm_decision",
        type: "PMDecisionParserStep",
        config: {
          input: JSON.stringify({
            decision: "immediate_fix",
            backlog: [{ title: "Task 1", priority: "low" }],
            follow_up_tasks: [],
          }),
          normalize: true,
        },
      });

      const result = await step.execute(context);

      expect(result.status).toBe("success");

      expect(result.outputs?.pm_decision?.follow_up_tasks).toHaveLength(1);
    });

    it("should auto-correct immediate_fix with empty follow_up_tasks to defer", async () => {
      const step = new PMDecisionParserStep({
        name: "parse_pm_decision",
        type: "PMDecisionParserStep",
        config: {
          input: JSON.stringify({
            decision: "immediate_fix",
            reasoning: "Should be auto-corrected",
            follow_up_tasks: [],
          }),
          normalize: true,
        },
      });

      const result = await step.execute(context);

      expect(result.status).toBe("success");
      expect(result.outputs?.pm_decision?.decision).toBe("defer");
    });

    it("should validate priority values and log warnings", async () => {
      const step = new PMDecisionParserStep({
        name: "parse_pm_decision",
        type: "PMDecisionParserStep",
        config: {
          input: JSON.stringify({
            decision: "immediate_fix",
            follow_up_tasks: [
              { title: "Critical QA", priority: "critical", review_type: "qa" },
              {
                title: "High Code",
                priority: "high",
                review_type: "code_review",
              },
              { title: "Invalid Priority", priority: "invalid" },
            ],
          }),
          normalize: true,
          review_type: "qa",
        },
      });

      const result = await step.execute(context);

      expect(result.status).toBe("success");
      expect(result.outputs?.pm_decision?.follow_up_tasks).toHaveLength(3);
    });

    it("should handle only backlog field (deprecated format)", async () => {
      const step = new PMDecisionParserStep({
        name: "parse_pm_decision",
        type: "PMDecisionParserStep",
        config: {
          input: JSON.stringify({
            decision: "defer",
            backlog: [
              { title: "Backlog Only 1", priority: "low" },
              { title: "Backlog Only 2", priority: "medium" },
            ],
          }),
          normalize: true,
        },
      });

      const result = await step.execute(context);

      expect(result.status).toBe("success");
      expect(result.outputs?.pm_decision?.follow_up_tasks).toHaveLength(2);
      expect(result.outputs?.pm_decision?.decision).toBe("defer");
    });

    it("should handle parent_milestone_id routing", async () => {
      context.setVariable("parent_milestone_id", 123);
      context.setVariable("backlog_milestone_id", 456);

      const step = new PMDecisionParserStep({
        name: "parse_pm_decision",
        type: "PMDecisionParserStep",
        config: {
          input: JSON.stringify({
            decision: "immediate_fix",
            follow_up_tasks: [
              { title: "Urgent Task", priority: "critical" },
              { title: "Deferred Task", priority: "low" },
            ],
          }),
          normalize: true,
          parent_milestone_id: 123,
        },
      });

      const result = await step.execute(context);

      expect(result.status).toBe("success");
    });
  });

  describe("Edge Cases", () => {
    it("should handle empty input", async () => {
      const config: WorkflowStepConfig = {
        name: "parse_pm_decision",
        type: "PMDecisionParserStep",
        config: {
          input: { decision: "immediate_fix", follow_up_tasks: [] },
          normalize: true,
        },
      };

      const step = new PMDecisionParserStep(config);
      const context = new WorkflowContext(
        "test-workflow-id",
        "test-project-1",
        "/tmp/test-repo",
        "main",
      );
      const result = await step.execute(context);

      expect(result.status).toBe("success");
      expect(result.outputs?.pm_decision?.decision).toBe("defer");
    });

    it("should handle malformed JSON", async () => {
      const config: WorkflowStepConfig = {
        name: "parse_pm_decision",
        type: "PMDecisionParserStep",
        config: {
          input: { decision: "defer", follow_up_tasks: [] },
          normalize: true,
        },
      };

      const step = new PMDecisionParserStep(config);
      const context = new WorkflowContext(
        "test-workflow-id",
        "test-project-1",
        "/tmp/test-repo",
        "main",
      );
      const result = await step.execute(context);

      expect(result.status).toBe("success");
      expect(result.outputs?.pm_decision?.decision).toBe("defer");
    });

    it("should handle both arrays empty", async () => {
      const step = new PMDecisionParserStep({
        name: "parse_pm_decision",
        type: "PMDecisionParserStep",
        config: {
          input: JSON.stringify({
            decision: "defer",
            backlog: [],
            follow_up_tasks: [],
          }),
          normalize: true,
        },
      });

      const result = await step.execute(context);

      expect(result.status).toBe("success");
      expect(result.outputs?.pm_decision?.follow_up_tasks).toHaveLength(0);
      expect(result.outputs?.pm_decision?.decision).toBe("defer");
    });
  });
});
