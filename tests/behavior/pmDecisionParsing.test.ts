import { describe, it, expect, beforeEach } from "vitest";
import { PMDecisionParserStep } from "../../src/workflows/steps/PMDecisionParserStep.js";
import { WorkflowContext } from "../../src/workflows/WorkflowEngine.js";

describe("PM Decision Parsing", () => {
  let parser: PMDecisionParserStep;

  beforeEach(() => {
    parser = new PMDecisionParserStep({
      persona: "lead-engineer",
      prompt_template: "pm-prioritize-qa-failures",
    });
  });

  describe("Format 1: Clean JSON with follow_up_tasks array", () => {
    it("should parse standard JSON response correctly", async () => {
      const pmResponse = JSON.stringify({
        immediate_fix: true,
        explanation: "Test failures must be fixed immediately",
        follow_up_tasks: [
          {
            title: "🚨 [QA] Fix authentication test",
            description: "Tests are failing due to incorrect mock setup",
            priority: "critical",
            assignee_persona: "implementation-planner",
          },
        ],
      });

      const context: WorkflowContext = {
        pm_response: pmResponse,
        milestone_id: "milestone-123",
        task_id: "task-456",
      };

      const result = await parser.execute(context);

      expect(result.context.pm_decision).toMatchObject({
        immediate_fix: true,
        explanation: "Test failures must be fixed immediately",
        follow_up_tasks: [
          {
            title: "🚨 [QA] Fix authentication test",
            priority: 1200,
            milestone_id: "milestone-123",
            assignee_persona: "implementation-planner",
          },
        ],
      });
    });
  });

  describe("Format 2: Nested JSON wrapper", () => {
    it("should extract decision from nested json field", async () => {
      const pmResponse = JSON.stringify({
        json: {
          immediate_fix: false,
          explanation: "Low priority code style issue",
          follow_up_tasks: [
            {
              title: "📋 [Code] Refactor validation logic",
              description: "Extract duplicated validation code",
              priority: "low",
              assignee_persona: "implementation-planner",
            },
          ],
        },
      });

      const context: WorkflowContext = {
        pm_response: pmResponse,
        milestone_id: "milestone-123",
        backlog_milestone_id: "backlog-milestone",
      };

      const result = await parser.execute(context);

      expect(result.context.pm_decision).toMatchObject({
        immediate_fix: false,
        follow_up_tasks: [
          {
            title: "📋 [Code] Refactor validation logic",
            priority: 50,
            milestone_id: "backlog-milestone",
            assignee_persona: "implementation-planner",
          },
        ],
      });
    });
  });

  describe("Format 3: Text with embedded JSON", () => {
    it("should extract JSON from markdown code blocks", async () => {
      const pmResponse = `
Looking at the security findings, we need immediate action.

\`\`\`json
{
  "immediate_fix": true,
  "explanation": "SQL injection vulnerability is critical",
  "follow_up_tasks": [
    {
      "title": "🚨 [Security] Fix SQL injection in query builder",
      "description": "Use parameterized queries",
      "priority": "critical",
      "assignee_persona": "implementation-planner"
    }
  ]
}
\`\`\`

This should be addressed before deployment.
      `;

      const context: WorkflowContext = {
        pm_response: pmResponse,
        milestone_id: "milestone-123",
      };

      const result = await parser.execute(context);

      expect(result.context.pm_decision).toMatchObject({
        immediate_fix: true,
        follow_up_tasks: [
          {
            title: "🚨 [Security] Fix SQL injection in query builder",
            priority: 1000,
            milestone_id: "milestone-123",
          },
        ],
      });
    });
  });

  describe("Format 4: Backlog field (deprecated)", () => {
    it("should move backlog tasks to follow_up_tasks with warning", async () => {
      const pmResponse = JSON.stringify({
        immediate_fix: false,
        explanation: "Minor improvements can be deferred",
        backlog: [
          {
            title: "📋 [Code] Add JSDoc comments",
            description: "Improve code documentation",
            priority: "low",
            assignee_persona: "implementation-planner",
          },
        ],
      });

      const context: WorkflowContext = {
        pm_response: pmResponse,
        backlog_milestone_id: "backlog-milestone",
      };

      const result = await parser.execute(context);

      expect(result.context.pm_decision.follow_up_tasks).toHaveLength(1);
      expect(result.context.pm_decision.backlog).toBeUndefined();

      expect(result.warnings).toContainEqual(
        expect.stringContaining('PM used deprecated "backlog" field'),
      );
    });
  });

  describe("Format 5: Production Bug - Both backlog AND follow_up_tasks", () => {
    it("should merge both arrays when PM returns both fields", async () => {
      const pmResponse = JSON.stringify({
        immediate_fix: true,
        explanation: "Multiple issues found",
        backlog: [
          {
            title: "📋 [Code] Refactor error handling",
            description: "Consolidate error handling logic",
            priority: "medium",
            assignee_persona: "implementation-planner",
          },
        ],
        follow_up_tasks: [
          {
            title: "🚨 [QA] Fix test timeout",
            description: "Tests timing out in CI",
            priority: "critical",
            assignee_persona: "implementation-planner",
          },
          {
            title: "🚨 [Security] Update dependency",
            description: "Security vulnerability in lodash",
            priority: "high",
            assignee_persona: "implementation-planner",
          },
        ],
      });

      const context: WorkflowContext = {
        pm_response: pmResponse,
        milestone_id: "milestone-123",
        backlog_milestone_id: "backlog-milestone",
      };

      const result = await parser.execute(context);

      expect(result.context.pm_decision.follow_up_tasks).toHaveLength(3);

      const tasks = result.context.pm_decision.follow_up_tasks;
      expect(tasks.find((t) => t.title.includes("QA"))).toMatchObject({
        priority: 1200,
        milestone_id: "milestone-123",
      });
      expect(tasks.find((t) => t.title.includes("Security"))).toMatchObject({
        priority: 1000,
        milestone_id: "milestone-123",
      });
      expect(tasks.find((t) => t.title.includes("Refactor"))).toMatchObject({
        priority: 50,
        milestone_id: "backlog-milestone",
      });

      expect(result.warnings).toContainEqual(
        expect.stringContaining(
          'PM returned both "backlog" and "follow_up_tasks"',
        ),
      );
    });
  });

  describe("Format 6: status vs decision field", () => {
    it('should handle "status" field (instead of "decision")', async () => {
      const pmResponse = JSON.stringify({
        status: "immediate_fix_required",
        immediate_fix: true,
        explanation: "Critical bug blocking release",
        follow_up_tasks: [
          {
            title: "🚨 [QA] Fix regression in payment flow",
            priority: "critical",
            assignee_persona: "implementation-planner",
          },
        ],
      });

      const context: WorkflowContext = {
        pm_response: pmResponse,
        milestone_id: "milestone-123",
      };

      const result = await parser.execute(context);

      expect(result.context.pm_decision).toMatchObject({
        immediate_fix: true,
        follow_up_tasks: expect.arrayContaining([
          expect.objectContaining({
            title: "🚨 [QA] Fix regression in payment flow",
            priority: 1200,
          }),
        ]),
      });
    });
  });

  describe("Format 7: Plain text (fallback)", () => {
    it("should handle plain text without JSON", async () => {
      const pmResponse = `
The code review findings are minor style issues that don't block deployment.
We can create a follow-up task to address these in the next sprint.
No immediate action required.
      `;

      const context: WorkflowContext = {
        pm_response: pmResponse,
        milestone_id: "milestone-123",
      };

      const result = await parser.execute(context);

      expect(result.context.pm_decision.immediate_fix).toBe(false);

      expect(result.context.pm_decision.follow_up_tasks).toEqual([]);
    });
  });

  describe("Priority Validation", () => {
    it("should map QA critical/high to priority 1200", async () => {
      const pmResponse = JSON.stringify({
        immediate_fix: true,
        follow_up_tasks: [
          {
            title: "🚨 [QA] Critical test failure",
            priority: "critical",
            assignee_persona: "implementation-planner",
          },
          {
            title: "🚨 [QA] High priority test failure",
            priority: "high",
            assignee_persona: "implementation-planner",
          },
        ],
      });

      const context: WorkflowContext = {
        pm_response: pmResponse,
        milestone_id: "milestone-123",
      };

      const result = await parser.execute(context);

      result.context.pm_decision.follow_up_tasks.forEach((task) => {
        expect(task.priority).toBe(1200);
      });
    });

    it("should map Code/Security/DevOps critical/high to priority 1000", async () => {
      const pmResponse = JSON.stringify({
        immediate_fix: true,
        follow_up_tasks: [
          {
            title: "🚨 [Code] Critical refactor needed",
            priority: "critical",
            assignee_persona: "implementation-planner",
          },
          {
            title: "🚨 [Security] High risk vulnerability",
            priority: "high",
            assignee_persona: "implementation-planner",
          },
          {
            title: "🚨 [DevOps] Build failing",
            priority: "critical",
            assignee_persona: "implementation-planner",
          },
        ],
      });

      const context: WorkflowContext = {
        pm_response: pmResponse,
        milestone_id: "milestone-123",
      };

      const result = await parser.execute(context);

      result.context.pm_decision.follow_up_tasks.forEach((task) => {
        expect(task.priority).toBe(1000);
      });
    });

    it("should map medium/low to priority 50 (deferred)", async () => {
      const pmResponse = JSON.stringify({
        immediate_fix: false,
        follow_up_tasks: [
          {
            title: "📋 [Code] Medium: Refactor duplicated code",
            priority: "medium",
            assignee_persona: "implementation-planner",
          },
          {
            title: "📋 [Security] Low: Update documentation",
            priority: "low",
            assignee_persona: "implementation-planner",
          },
        ],
      });

      const context: WorkflowContext = {
        pm_response: pmResponse,
        backlog_milestone_id: "backlog-milestone",
      };

      const result = await parser.execute(context);

      result.context.pm_decision.follow_up_tasks.forEach((task) => {
        expect(task.priority).toBe(50);
        expect(task.milestone_id).toBe("backlog-milestone");
      });
    });
  });

  describe("Milestone Routing", () => {
    it("should route critical/high to parent milestone (same milestone)", async () => {
      const pmResponse = JSON.stringify({
        immediate_fix: true,
        follow_up_tasks: [
          {
            title: "🚨 [QA] Critical failure",
            priority: "critical",
            assignee_persona: "implementation-planner",
          },
        ],
      });

      const context: WorkflowContext = {
        pm_response: pmResponse,
        milestone_id: "milestone-123",
        parent_task_milestone_id: "milestone-123",
      };

      const result = await parser.execute(context);

      expect(result.context.pm_decision.follow_up_tasks[0]).toMatchObject({
        milestone_id: "milestone-123",
        priority: 1200,
      });
    });

    it("should route medium/low to backlog milestone", async () => {
      const pmResponse = JSON.stringify({
        immediate_fix: false,
        follow_up_tasks: [
          {
            title: "📋 [Code] Low priority refactor",
            priority: "low",
            assignee_persona: "implementation-planner",
          },
        ],
      });

      const context: WorkflowContext = {
        pm_response: pmResponse,
        milestone_id: "milestone-123",
        backlog_milestone_id: "backlog-999",
      };

      const result = await parser.execute(context);

      expect(result.context.pm_decision.follow_up_tasks[0]).toMatchObject({
        milestone_id: "backlog-999",
        priority: 50,
      });
    });

    it("should handle missing parent milestone (edge case)", async () => {
      const pmResponse = JSON.stringify({
        immediate_fix: true,
        follow_up_tasks: [
          {
            title: "🚨 [QA] Critical failure",
            priority: "critical",
            assignee_persona: "implementation-planner",
          },
        ],
      });

      const context: WorkflowContext = {
        pm_response: pmResponse,
        milestone_id: null,
        backlog_milestone_id: "backlog-999",
      };

      const result = await parser.execute(context);

      expect(result.context.pm_decision.follow_up_tasks[0].milestone_id).toBe(
        "backlog-999",
      );
      expect(result.warnings).toContainEqual(
        expect.stringContaining("Parent milestone not found"),
      );
    });
  });

  describe("Assignee Validation", () => {
    it("should always set assignee_persona to implementation-planner", async () => {
      const pmResponse = JSON.stringify({
        immediate_fix: true,
        follow_up_tasks: [
          {
            title: "🚨 [QA] Test failure",
            priority: "critical",
            assignee_persona: "tester-qa",
          },
          {
            title: "🚨 [Code] Code issue",
            priority: "high",
          },
        ],
      });

      const context: WorkflowContext = {
        pm_response: pmResponse,
        milestone_id: "milestone-123",
      };

      const result = await parser.execute(context);

      result.context.pm_decision.follow_up_tasks.forEach((task) => {
        expect(task.assignee_persona).toBe("implementation-planner");
      });
    });
  });

  describe("Empty follow_up_tasks with immediate_fix=true", () => {
    it("should warn when immediate_fix=true but no tasks provided", async () => {
      const pmResponse = JSON.stringify({
        immediate_fix: true,
        explanation: "Critical issue but no tasks defined",
        follow_up_tasks: [],
      });

      const context: WorkflowContext = {
        pm_response: pmResponse,
        milestone_id: "milestone-123",
      };

      const result = await parser.execute(context);

      expect(result.warnings).toContainEqual(
        expect.stringContaining(
          "PM set immediate_fix=true but provided no tasks",
        ),
      );
    });
  });
});
