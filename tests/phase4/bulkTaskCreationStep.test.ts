import { describe, it, expect, beforeEach, vi } from "vitest";
import { BulkTaskCreationStep } from "../../src/workflows/steps/BulkTaskCreationStep.js";
import { WorkflowContext } from "../../src/workflows/engine/WorkflowContext.js";
import { type EnrichedTask } from "../../src/workflows/steps/helpers/TaskEnricher.js";

describe("Phase 4 - BulkTaskCreationStep", () => {
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

  describe("Day 3: Retry Logic", () => {
    it("should retry with exponential backoff (1s, 2s, 4s)", async () => {
      const startTime = Date.now();
      let attempts = 0;

      const step = new BulkTaskCreationStep({
        name: "create_tasks",
        type: "BulkTaskCreationStep",
        config: {
          project_id: "1",
          tasks: [{ title: "Task 1", priority: "high" as const }],
          retry: {
            max_attempts: 3,
            initial_delay_ms: 100,
            backoff_multiplier: 2,
          },
        },
      });

      const originalMethod = (step as any).createTasksViaDashboard;
      (step as any).createTasksViaDashboard = async (...args: any[]) => {
        attempts++;
        if (attempts < 3) {
          return {
            tasks_created: 0,
            urgent_tasks_created: 0,
            deferred_tasks_created: 0,
            task_ids: [],
            duplicate_task_ids: [],
            skipped_duplicates: 0,
            errors: ["Network timeout"],
          };
        }
        return originalMethod.apply(step, args);
      };

      const _result = await step.execute(context);

      const duration = Date.now() - startTime;

      expect(attempts).toBe(3);

      expect(duration).toBeGreaterThanOrEqual(300);
    });

    it("should not retry on non-retryable errors", async () => {
      let attempts = 0;

      const step = new BulkTaskCreationStep({
        name: "create_tasks",
        type: "BulkTaskCreationStep",
        config: {
          project_id: "1",
          tasks: [{ title: "Task 1", priority: "high" as const }],
          retry: {
            max_attempts: 3,
          },
        },
      });

      (step as any).createTasksViaDashboard = async () => {
        attempts++;
        return {
          tasks_created: 0,
          urgent_tasks_created: 0,
          deferred_tasks_created: 0,
          task_ids: [],
          duplicate_task_ids: [],
          skipped_duplicates: 0,
          errors: ["Validation error: Invalid task title"],
        };
      };

      await step.execute(context);

      expect(attempts).toBe(1);
    });

    it("should detect retryable error patterns", async () => {
      const retryableErrors = [
        "timeout",
        "ETIMEDOUT",
        "ECONNRESET",
        "ECONNREFUSED",
        "network error",
        "rate limit exceeded",
        "HTTP 429",
        "HTTP 500",
        "HTTP 502",
        "HTTP 503",
        "HTTP 504",
      ];

      for (const errorMsg of retryableErrors) {
        let attempts = 0;

        const step = new BulkTaskCreationStep({
          name: "create_tasks",
          type: "BulkTaskCreationStep",
          config: {
            project_id: "1",
            tasks: [{ title: "Task 1", priority: "high" as const }],
            retry: {
              max_attempts: 2,
              initial_delay_ms: 1,
            },
          },
        });

        (step as any).createTasksViaDashboard = async () => {
          attempts++;
          if (attempts === 1) {
            return {
              tasks_created: 0,
              urgent_tasks_created: 0,
              deferred_tasks_created: 0,
              task_ids: [],
              duplicate_task_ids: [],
              skipped_duplicates: 0,
              errors: [errorMsg],
            };
          }

          return {
            tasks_created: 1,
            urgent_tasks_created: 1,
            deferred_tasks_created: 0,
            task_ids: ["task-1"],
            duplicate_task_ids: [],
            skipped_duplicates: 0,
            errors: [],
          };
        };

        const result = await step.execute(context);

        expect(attempts).toBe(2);
        expect(result.status).toBe("success");
      }
    });
  });

  describe("Day 3: Workflow Abort Signal", () => {
    it("should set abort signal on partial failure with abort_on_partial_failure=true", async () => {
      const step = new BulkTaskCreationStep({
        name: "create_tasks",
        type: "BulkTaskCreationStep",
        config: {
          project_id: "1",
          tasks: [
            { title: "Task 1", priority: "high" as const },
            { title: "Task 2", priority: "high" as const },
          ],
          retry: {
            max_attempts: 1,
          },
          options: {
            abort_on_partial_failure: true,
          },
        },
      });

      (step as any).createTasksViaDashboard = async () => ({
        tasks_created: 1,
        urgent_tasks_created: 1,
        deferred_tasks_created: 0,
        task_ids: ["task-1"],
        duplicate_task_ids: [],
        skipped_duplicates: 0,
        errors: ["Failed to create Task 2"],
      });

      const result = await step.execute(context);

      expect(result.status).toBe("failure");
      expect(result.outputs?.workflow_abort_requested).toBe(true);
      expect(context.getVariable("workflow_abort_requested")).toBe(true);
      expect(context.getVariable("workflow_abort_reason")).toContain(
        "tasks failed after retries",
      );
    });

    it("should not abort on partial failure with abort_on_partial_failure=false", async () => {
      const step = new BulkTaskCreationStep({
        name: "create_tasks",
        type: "BulkTaskCreationStep",
        config: {
          project_id: "1",
          tasks: [
            { title: "Task 1", priority: "high" as const },
            { title: "Task 2", priority: "high" as const },
          ],
          retry: {
            max_attempts: 1,
          },
          options: {
            abort_on_partial_failure: false,
          },
        },
      });

      (step as any).createTasksViaDashboard = async () => ({
        tasks_created: 1,
        urgent_tasks_created: 1,
        deferred_tasks_created: 0,
        task_ids: ["task-1"],
        duplicate_task_ids: [],
        skipped_duplicates: 0,
        errors: ["Failed to create Task 2"],
      });

      const result = await step.execute(context);

      expect(result.status).toBe("failure");
      expect(result.outputs?.workflow_abort_requested).toBeUndefined();
      expect(context.getVariable("workflow_abort_requested")).toBeUndefined();
    });
  });

  describe("Day 3: Enhanced Duplicate Detection", () => {
    it("should detect duplicates with match scoring and overlap percentages", async () => {
      const existingTasks = [
        {
          id: "task-100",
          title: "Fix authentication bug",
          status: "todo",
          milestone_slug: "sprint-1",
        },
      ];

      const step = new BulkTaskCreationStep({
        name: "create_tasks",
        type: "BulkTaskCreationStep",
        config: {
          project_id: "1",
          tasks: [
            {
              title: "Fix auth bug",
              priority: "high" as const,
              milestone_slug: "sprint-1",
            },
          ],
          options: {
            check_duplicates: true,
            existing_tasks: existingTasks,
            duplicate_match_strategy: "title_and_milestone" as const,
          },
        },
      });

      const result = await step.execute(context);

      expect(result.status).toBe("success");
      expect(result.outputs?.skipped_duplicates).toBe(1);
      expect(result.outputs?.tasks_created).toBe(0);
    });

    it("should use external_id match strategy (100% match)", async () => {
      const existingTasks = [
        {
          id: "task-100",
          title: "Some Task",
          status: "todo",
          external_id: "wf-abc:create_tasks:0",
        },
      ];

      const step = new BulkTaskCreationStep({
        name: "create_tasks",
        type: "BulkTaskCreationStep",
        config: {
          project_id: "1",
          tasks: [
            {
              title: "Different Title",
              priority: "high" as const,
              external_id: "wf-abc:create_tasks:0",
            },
          ],
          options: {
            check_duplicates: true,
            existing_tasks: existingTasks,
            duplicate_match_strategy: "external_id" as const,
          },
        },
      });

      const result = await step.execute(context);

      expect(result.outputs?.skipped_duplicates).toBe(1);
      expect(result.outputs?.tasks_created).toBe(0);
    });
  });

  describe("Day 4: Idempotency (external_id)", () => {
    it("should auto-generate external_id when upsert_by_external_id=true", async () => {
      const step = new BulkTaskCreationStep({
        name: "create_tasks_bulk",
        type: "BulkTaskCreationStep",
        config: {
          project_id: "1",
          workflow_run_id: "wf-550e8400-e29b",
          tasks: [
            { title: "Task 1", priority: "high" as const },
            { title: "Task 2", priority: "medium" as const },
          ],
          options: {
            upsert_by_external_id: true,
          },
        },
      });

      const createTasksSpy = vi.spyOn(step as any, "createTasksViaDashboard");
      createTasksSpy.mockResolvedValue({
        tasks_created: 2,
        urgent_tasks_created: 2,
        deferred_tasks_created: 0,
        task_ids: ["task-1", "task-2"],
        duplicate_task_ids: [],
        skipped_duplicates: 0,
        errors: [],
      });

      await step.execute(context);

      expect(createTasksSpy).toHaveBeenCalled();
      const enrichedTasks = createTasksSpy.mock.calls[0][1] as EnrichedTask[];

      expect(enrichedTasks).toBeDefined();
      expect(enrichedTasks[0]?.external_id).toBe(
        "wf-550e8400-e29b:create_tasks_bulk:0",
      );
      expect(enrichedTasks[1]?.external_id).toBe(
        "wf-550e8400-e29b:create_tasks_bulk:1",
      );
    });

    it("should use custom external_id template", async () => {
      const step = new BulkTaskCreationStep({
        name: "create_qa_tasks",
        type: "BulkTaskCreationStep",
        config: {
          project_id: "1",
          workflow_run_id: "wf-abc123",
          tasks: [
            {
              title: "Fix Login Bug",
              priority: "critical" as const,
              milestone_slug: "sprint-1",
            },
            {
              title: "Add Tests",
              priority: "high" as const,
              milestone_slug: "sprint-1",
            },
          ],
          options: {
            external_id_template:
              "${workflow_run_id}:${task.priority}:${task_index}",
          },
        },
      });

      const createTasksSpy = vi.spyOn(step as any, "createTasksViaDashboard");
      createTasksSpy.mockResolvedValue({
        tasks_created: 2,
        urgent_tasks_created: 2,
        deferred_tasks_created: 0,
        task_ids: ["task-1", "task-2"],
        duplicate_task_ids: [],
        skipped_duplicates: 0,
        errors: [],
      });

      await step.execute(context);

      const enrichedTasks = createTasksSpy.mock.calls[0][1] as EnrichedTask[];

      expect(enrichedTasks[0]?.external_id).toBe("wf-abc123:critical:0");
      expect(enrichedTasks[1]?.external_id).toBe("wf-abc123:high:1");
    });

    it("should support all template variables", async () => {
      const step = new BulkTaskCreationStep({
        name: "create_tasks",
        type: "BulkTaskCreationStep",
        config: {
          project_id: "1",
          workflow_run_id: "wf-test",
          tasks: [
            {
              title: "Fix Bug in Auth Module",
              priority: "high" as const,
              milestone_slug: "sprint-1",
            },
          ],
          options: {
            external_id_template:
              "${workflow_run_id}:${step_name}:${task.priority}:${task.milestone_slug}:${task_index}",
          },
        },
      });

      const createTasksSpy = vi.spyOn(step as any, "createTasksViaDashboard");
      createTasksSpy.mockResolvedValue({
        tasks_created: 1,
        urgent_tasks_created: 1,
        deferred_tasks_created: 0,
        task_ids: ["task-1"],
        duplicate_task_ids: [],
        skipped_duplicates: 0,
        errors: [],
      });

      await step.execute(context);

      const enrichedTasks = createTasksSpy.mock.calls[0][1] as EnrichedTask[];

      expect(enrichedTasks[0]?.external_id).toBe(
        "wf-test:create_tasks:high:sprint-1:0",
      );
    });

    it("should preserve existing external_id if provided", async () => {
      const step = new BulkTaskCreationStep({
        name: "create_tasks",
        type: "BulkTaskCreationStep",
        config: {
          project_id: "1",
          workflow_run_id: "wf-test",
          tasks: [
            {
              title: "Task with external_id",
              priority: "high" as const,
              external_id: "custom-external-id-123",
            },
          ],
          options: {
            upsert_by_external_id: true,
          },
        },
      });

      const createTasksSpy = vi.spyOn(step as any, "createTasksViaDashboard");
      createTasksSpy.mockResolvedValue({
        tasks_created: 1,
        urgent_tasks_created: 1,
        deferred_tasks_created: 0,
        task_ids: ["task-1"],
        duplicate_task_ids: [],
        skipped_duplicates: 0,
        errors: [],
      });

      await step.execute(context);

      const enrichedTasks = createTasksSpy.mock.calls[0][1] as EnrichedTask[];

      expect(enrichedTasks[0]?.external_id).toBe("custom-external-id-123");
    });
  });

  describe("Integration: All Phase 4 Features", () => {
    it("should handle retry + idempotency + duplicate detection together", async () => {
      let attempts = 0;

      const step = new BulkTaskCreationStep({
        name: "create_tasks",
        type: "BulkTaskCreationStep",
        config: {
          project_id: "1",
          workflow_run_id: "wf-integration-test",
          tasks: [
            { title: "Task 1", priority: "critical" as const },
            { title: "Task 2", priority: "high" as const },
            { title: "Task 3", priority: "medium" as const },
          ],
          priority_mapping: {
            critical: 1500,
            high: 1200,
            medium: 800,
            low: 50,
          },
          retry: {
            max_attempts: 2,
            initial_delay_ms: 10,
          },
          options: {
            upsert_by_external_id: true,
            check_duplicates: true,
            duplicate_match_strategy: "external_id" as const,
            existing_tasks: [],
            abort_on_partial_failure: false,
          },
        },
      });

      (step as any).createTasksViaDashboard = async () => {
        attempts++;
        if (attempts === 1) {
          return {
            tasks_created: 0,
            urgent_tasks_created: 0,
            deferred_tasks_created: 0,
            task_ids: [],
            duplicate_task_ids: [],
            skipped_duplicates: 0,
            errors: ["timeout"],
          };
        }
        return {
          tasks_created: 3,
          urgent_tasks_created: 2,
          deferred_tasks_created: 1,
          task_ids: ["task-1", "task-2", "task-3"],
          duplicate_task_ids: [],
          skipped_duplicates: 0,
          errors: [],
        };
      };

      const result = await step.execute(context);

      expect(attempts).toBe(2);
      expect(result.status).toBe("success");
      expect(result.outputs?.tasks_created).toBe(3);
      expect(result.outputs?.urgent_tasks_created).toBe(2);
      expect(result.outputs?.deferred_tasks_created).toBe(1);
    });
  });
});
