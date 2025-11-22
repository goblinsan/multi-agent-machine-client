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
      {} as any,
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

    it("should keep PM titles while copying milestone info and review metadata", async () => {
      context.setVariable("milestone_context", {
        id: 42,
        name: "Foundation & Config",
        slug: "foundation-config",
      });
      context.setVariable("task", {
        id: 36,
        title: "Config loader",
      });

      const step = new PMDecisionParserStep({
        name: "parse_pm_decision",
        type: "PMDecisionParserStep",
        config: {
          input: JSON.stringify({
            decision: "immediate_fix",
            follow_up_tasks: [
              {
                title: "Finish validation",
                description: "Ensure schema matches",
                priority: "high",
              },
            ],
          }),
          normalize: true,
          review_type: "code_review",
        },
      });

      const result = await step.execute(context);
      expect(result.status).toBe("success");
      const followUps = result.outputs?.pm_decision?.follow_up_tasks;
      expect(followUps).toHaveLength(1);
      const task = followUps?.[0];
      expect(task?.title).toBe("Finish validation");
      expect(task?.description).toContain("task #36");
      expect(task?.milestone_id).toBe(42);
      expect(task?.milestone_slug).toBe("foundation-config");
      expect(task?.metadata?.labels).toEqual(
        expect.arrayContaining([
          "review-follow-up",
          "code_review-follow-up",
          "urgent",
        ]),
      );
      expect(task?.metadata?.review_type).toBe("code_review");
      expect(task?.metadata?.review_label).toBe("Code Review");
      expect(task?.metadata?.original_pm_title).toBe("Finish validation");
    });

    it("should generate fallback titles when PM omits them", async () => {
      context.setVariable("milestone_context", {
        id: 5,
        name: "Stability",
        slug: "stability",
      });
      context.setVariable("task", { id: 88, title: "Integration tests" });

      const step = new PMDecisionParserStep({
        name: "parse_pm_decision",
        type: "PMDecisionParserStep",
        config: {
          input: JSON.stringify({
            decision: "immediate_fix",
            follow_up_tasks: [
              {
                title: "",
                description: "Patch config",
                priority: "medium",
              },
            ],
          }),
          normalize: true,
          review_type: "code_review",
        },
      });

      const result = await step.execute(context);
      expect(result.status).toBe("success");
      const fallbackTask = result.outputs?.pm_decision?.follow_up_tasks?.[0];
      expect(fallbackTask?.title).toMatch(/\[CODE REVIEW\]/);
      expect(fallbackTask?.metadata?.generated_title_reason).toBe(
        "missing_pm_title",
      );
      expect(fallbackTask?.metadata?.original_pm_title).toBeNull();
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
        { name: "test", version: "1.0", steps: [] },
        {} as any,
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
        { name: "test", version: "1.0", steps: [] },
        {} as any,
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

    it("should parse follow_up_tasks from raw persona response", async () => {
      const rawResponse = `Persona summary\n\n\`\`\`json\n{\n  "details": "Implement config loader",\n  "follow_up_tasks": [\n    {\n      "title": "Define defaults",\n      "description": "Set default values for config",\n      "priority": "high"\n    },\n    {\n      "title": "Generate example env",\n      "description": "Create .example.env template",\n      "priority": "medium"\n    }\n  ]\n}\n\`\`\`\n\nAdditional notes.`;

      const step = new PMDecisionParserStep({
        name: "parse_pm_decision",
        type: "PMDecisionParserStep",
        config: {
          input: { raw: rawResponse },
          normalize: true,
          review_type: "security_review",
        },
      });

      const result = await step.execute(context);

      expect(result.status).toBe("success");
      expect(result.outputs?.pm_decision?.follow_up_tasks).toHaveLength(2);
      expect(result.outputs?.pm_decision?.follow_up_tasks[0].title).toContain(
        "Define defaults",
      );
      expect(result.outputs?.pm_decision?.follow_up_tasks[1].title).toContain(
        "Generate example env",
      );
    });

    it("should accept camelCase followUpTasks arrays", async () => {
      const step = new PMDecisionParserStep({
        name: "parse_pm_decision",
        type: "PMDecisionParserStep",
        config: {
          input: JSON.stringify({
            decision: "immediate_fix",
            followUpTasks: [
              { title: "Task A", description: "A", priority: "high" },
              { title: "Task B", description: "B", priority: "low" },
            ],
          }),
          normalize: true,
          review_type: "code_review",
        },
      });

      const result = await step.execute(context);

      expect(result.status).toBe("success");
      expect(result.outputs?.pm_decision?.follow_up_tasks).toHaveLength(2);
    });

    it("should promote milestone_updates when follow_up_tasks missing", async () => {
      const step = new PMDecisionParserStep({
        name: "parse_pm_decision",
        type: "PMDecisionParserStep",
        config: {
          input: JSON.stringify({
            decision: "immediate_fix",
            milestone_updates: [
              {
                title: "Milestone A",
                description: "Details",
                priority: "medium",
              },
              {
                title: "Milestone B",
                description: "Details",
              },
            ],
          }),
          normalize: true,
        },
      });

      const result = await step.execute(context);

      expect(result.status).toBe("success");
      expect(result.outputs?.pm_decision?.follow_up_tasks).toHaveLength(2);
    });

    it("should recover follow_up_tasks from raw field when structured payload missing", async () => {
      const raw = `\`\`\`json\n{\n  "follow_up_tasks": [\n    {\n      "title": "Task from raw",\n      "description": "Parsed",\n      "priority": "medium"\n    }\n  ]\n}\n\`\`\``;

      const step = new PMDecisionParserStep({
        name: "parse_pm_decision",
        type: "PMDecisionParserStep",
        config: {
          input: {
            decision: "immediate_fix",
            follow_up_tasks: [],
            raw,
          },
          normalize: true,
        },
      });

      const result = await step.execute(context);

      expect(result.status).toBe("success");
      expect(result.outputs?.pm_decision?.follow_up_tasks).toHaveLength(1);
      expect(result.outputs?.pm_decision?.follow_up_tasks[0].title).toBe(
        "Task from raw",
      );
    });

    it("should parse follow_up_tasks from nested output object", async () => {
      const step = new PMDecisionParserStep({
        name: "parse_pm_decision",
        type: "PMDecisionParserStep",
        config: {
          input: {
            output: {
              follow_up_tasks: [
                { title: "Nested Task", description: "Nested", priority: "high" },
                {
                  title: "Nested Task 2",
                  description: "Nested",
                  priority: "low",
                },
              ],
              decision: "immediate_fix",
              reasoning: "Nested payload",
            },
            duration_ms: 1200,
          },
          normalize: true,
        },
      });

      const result = await step.execute(context);

      expect(result.status).toBe("success");
      expect(result.outputs?.pm_decision?.follow_up_tasks).toHaveLength(2);
    });

    it("should parse follow_up_tasks from stringified output payload", async () => {
      const step = new PMDecisionParserStep({
        name: "parse_pm_decision",
        type: "PMDecisionParserStep",
        config: {
          input: {
            output:
              "```json\n{\n  \"decision\": \"immediate_fix\",\n  \"follow_up_tasks\": [\n    {\n      \"title\": \"String Task\",\n      \"description\": \"From string\",\n      \"priority\": \"medium\"\n    }\n  ]\n}\n```",
            duration_ms: 900,
          },
          normalize: true,
        },
      });

      const result = await step.execute(context);

      expect(result.status).toBe("success");
      expect(result.outputs?.pm_decision?.follow_up_tasks).toHaveLength(1);
      expect(result.outputs?.pm_decision?.follow_up_tasks[0].title).toBe(
        "String Task",
      );
    });
  });
});
