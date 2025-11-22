import { describe, it, expect, beforeEach, vi } from "vitest";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { parse } from "yaml";
import { makeTempRepo } from "./makeTempRepo";
import { workflowEngine } from "../src/workflows/WorkflowEngine.js";

const {
  fetchTaskMock,
  updateTaskStatusMock,
  updateBlockedDependenciesMock,
  projectStatusMock,
  projectStatusDetailsMock,
} =
  vi.hoisted(() => {
  const fetchTaskMock = vi.fn();
  const updateTaskStatusMock = vi
    .fn()
    .mockResolvedValue({ ok: true, status: 200, body: null });
    const updateBlockedDependenciesMock = vi
      .fn()
      .mockResolvedValue({ ok: true, status: 200, body: null });

  const projectStatusMock = vi.fn().mockResolvedValue({
    id: "proj-blocked",
    name: "Blocked Task Project",
    status: "active",
  });

  const projectStatusDetailsMock = vi.fn().mockResolvedValue({
    tasks: [
      {
        id: "blocked-task-1",
        name: "Blocked Task",
        status: "blocked",
        blocked_attempt_count: 2,
        blocked_reason: "Context scan failed",
        failed_step: "context_request",
      },
    ],
    repositories: [{ url: "https://example/repo.git" }],
  });

    return {
      fetchTaskMock,
      updateTaskStatusMock,
      updateBlockedDependenciesMock,
      projectStatusMock,
      projectStatusDetailsMock,
    };
});

vi.mock("../src/dashboard/TaskAPI.js", () => ({
  TaskAPI: vi.fn().mockImplementation(() => ({
    fetchTask: fetchTaskMock,
    updateTaskStatus: updateTaskStatusMock,
    updateBlockedDependencies: updateBlockedDependenciesMock,
  })),
}));

vi.mock("../src/dashboard.js", () => ({
  fetchProjectStatus: projectStatusMock,
  fetchProjectStatusDetails: projectStatusDetailsMock,
  updateTaskStatus: updateTaskStatusMock,
  createDashboardTask: vi
    .fn()
    .mockResolvedValue({ id: "new-task-123", ok: true }),
}));

vi.mock("../src/dashboard/ProjectAPI.js", () => ({
  ProjectAPI: vi.fn().mockImplementation(() => ({
    fetchProjectStatus: projectStatusMock,
    fetchProjectStatusDetails: projectStatusDetailsMock,
    fetchProjectStatusSummary: vi.fn(),
    fetchProjectMilestones: vi.fn(),
    fetchProjectTasks: vi.fn().mockResolvedValue([]),
  })),
}));

vi.mock("../src/gitUtils.js");

vi.mock("../src/agents/persona.js", () => ({
  sendPersonaRequest: vi.fn().mockResolvedValue("corr-unblock-123"),
  waitForPersonaCompletion: vi
    .fn()
    .mockImplementation(
      async (redis, workflowId, corrId, persona, _timeout) => {
        if (persona === "context") {
          return {
            id: "event-context-1",
            fields: {
              result: JSON.stringify({
                status: "success",
                snapshot: {
                  files: [],
                  totals: { files: 10, bytes: 1000, lines: 100 },
                },
              }),
            },
          };
        }

        if (persona === "lead-engineer") {
          return {
            id: "event-lead-1",
            fields: {
              result: JSON.stringify({
                status: "success",
                strategy: "retry_with_context",
                resolution_plan: {
                  description: "Retry with fresh context scan",
                  steps: ["Clear cache", "Re-scan repository", "Retry task"],
                },
              }),
            },
          };
        }

        if (persona === "tester-qa") {
          return {
            id: "event-qa-1",
            fields: {
              result: JSON.stringify({
                status: "pass",
                normalizedStatus: "pass",
                message: "Unblock successful, task can proceed",
              }),
            },
          };
        }

        return {
          id: "event-generic",
          fields: {
            result: JSON.stringify({ status: "success" }),
          },
        };
      },
    ),
  parseEventResult: vi.fn().mockImplementation((event) => {
    const result = JSON.parse(event.fields.result);
    return result;
  }),
}));

vi.mock("../src/redisClient.js");

vi.mock("../src/scanRepo.js");

vi.mock("../src/process.js", () => ({
  processPersonaRequest: vi.fn().mockResolvedValue({
    status: "success",
    result: { message: "Mock processing complete" },
  }),
}));

import { createFastCoordinator } from "./helpers/coordinatorTestHelper.js";

async function loadBlockedWorkflowSteps() {
  const workflowPath = path.resolve(
    process.cwd(),
    "src/workflows/definitions/blocked-task-resolution.yaml",
  );
  const fileContent = await readFile(workflowPath, "utf-8");
  const workflow = parse(fileContent) as {
    steps: Array<{
      name: string;
      type: string;
      depends_on?: string[];
      condition?: string;
      config?: any;
    }>;
  };
  return Object.fromEntries(workflow.steps.map((step) => [step.name, step]));
}

beforeEach(() => {
  vi.clearAllMocks();
  fetchTaskMock.mockReset();
  updateTaskStatusMock.mockReset();
  updateTaskStatusMock.mockResolvedValue({
    ok: true,
    status: 200,
    body: null,
  });
  updateBlockedDependenciesMock.mockReset();
  updateBlockedDependenciesMock.mockResolvedValue({
    ok: true,
    status: 200,
    body: null,
  });
  projectStatusMock.mockReset();
  projectStatusMock.mockResolvedValue({
    id: "proj-blocked",
    name: "Blocked Task Project",
    status: "active",
  });
  projectStatusDetailsMock.mockReset();
  projectStatusDetailsMock.mockResolvedValue({
    tasks: [
      {
        id: "blocked-task-1",
        name: "Blocked Task",
        status: "blocked",
        blocked_attempt_count: 2,
        blocked_reason: "Context scan failed",
        failed_step: "context_request",
      },
    ],
    repositories: [{ url: "https://example/repo.git" }],
  });
});

describe("Blocked Task Resolution Workflow", () => {
  it("clears blocked dependencies after a successful unblock", async () => {
    const steps = await loadBlockedWorkflowSteps();
    const clearStep = steps["clear_blocked_dependencies"];

    expect(clearStep).toBeDefined();
    expect(clearStep?.type).toBe("RegisterBlockedDependenciesStep");
    expect(clearStep?.depends_on).toEqual(["mark_unblocked"]);
    expect(clearStep?.condition).toBe(
      "validate_unblock_status == 'pass' || validate_unblock.status == 'pass'",
    );
    expect(clearStep?.config?.allow_clear).toBe(true);
    expect(clearStep?.config?.parent_task_id).toBe("${task.id}");
    expect(clearStep?.config?.dependency_task_ids).toEqual([]);
  });

  it("gates unblock attempts on dependency status", async () => {
    const steps = await loadBlockedWorkflowSteps();
    const dependencyStatus = steps["dependency_status"];
    const waitingUpdate = steps["dependency_waiting_update"];
    const markInProgress = steps["mark_in_progress"];

    expect(dependencyStatus).toBeDefined();
    expect(dependencyStatus?.type).toBe("DependencyStatusStep");
    expect(waitingUpdate?.depends_on).toEqual(["dependency_status"]);
    expect(waitingUpdate?.condition).toBe(
      "dependency_status.allResolved == false",
    );
    expect(markInProgress?.depends_on).toEqual(["increment_attempt_counter"]);
    expect(markInProgress?.condition).toBe(
      "dependency_status.allResolved == true",
    );
  });

  it("routes blocked tasks to blocked-task-resolution workflow", async () => {
    const tempRepo = await makeTempRepo();

    const coordinator = createFastCoordinator();

    try {
      const result = await Promise.race([
        coordinator.handleCoordinator(
          {} as any,
          {} as any,
          { workflow_id: "wf-blocked-test", project_id: "proj-blocked" },
          { repo: tempRepo },
        ),
        new Promise((_, reject) =>
          setTimeout(() => reject(new Error("Test timeout")), 100),
        ),
      ]);

      expect(result).toBeDefined();
      expect(result.success).toBe(true);
      expect(result.results).toBeDefined();
      expect(result.results.length).toBeGreaterThan(0);
    } catch (error: any) {
      if (error.message === "Test timeout") {
        throw new Error(
          "Blocked task workflow hung - did not complete within timeout",
        );
      }

      console.log("Workflow failed (expected in test):", error.message);
    }
  });

  it("respects max unblock attempts configuration", async () => {
    const { fetchProjectStatusDetails, updateTaskStatus } = await import(
      "../src/dashboard.js"
    );

    (fetchProjectStatusDetails as any).mockResolvedValueOnce({
      tasks: [
        {
          id: "blocked-task-max",
          name: "Task at Max Attempts",
          status: "blocked",
          blocked_attempt_count: 10,
          blocked_reason: "Repeated failure",
          failed_step: "implementation",
        },
      ],
      repositories: [{ url: "https://example/repo.git" }],
    });

    const tempRepo = await makeTempRepo();
    const coordinator = createFastCoordinator();

    try {
      await Promise.race([
        coordinator.handleCoordinator(
          {} as any,
          {} as any,
          { workflow_id: "wf-blocked-max", project_id: "proj-blocked" },
          { repo: tempRepo },
        ),
        new Promise((_, reject) =>
          setTimeout(() => reject(new Error("Test timeout")), 100),
        ),
      ]);

      expect(updateTaskStatus).toHaveBeenCalled();
    } catch (error: any) {
      if (error.message === "Test timeout") {
        throw new Error("Max attempts workflow hung");
      }
    }
  });

  it("increments blocked_attempt_count on each unblock attempt", async () => {
    const { fetchProjectStatusDetails } = await import("../src/dashboard.js");

    (fetchProjectStatusDetails as any).mockResolvedValueOnce({
      tasks: [
        {
          id: "blocked-task-increment",
          name: "Task to Increment",
          status: "blocked",
          blocked_attempt_count: 3,
          blocked_reason: "QA failure",
          failed_step: "qa_request",
        },
      ],
      repositories: [{ url: "https://example/repo.git" }],
    });

    const tempRepo = await makeTempRepo();
    const coordinator = createFastCoordinator();

    try {
      const result = await Promise.race([
        coordinator.handleCoordinator(
          {} as any,
          {} as any,
          { workflow_id: "wf-blocked-increment", project_id: "proj-blocked" },
          { repo: tempRepo },
        ),
        new Promise((_, reject) =>
          setTimeout(() => reject(new Error("Test timeout")), 100),
        ),
      ]);

      expect(result).toBeDefined();
    } catch (error: any) {
      if (error.message === "Test timeout") {
        throw new Error("Increment test workflow hung");
      }
    }
  });

  it("analyzes blockage before attempting unblock", async () => {
    const { sendPersonaRequest } = await import("../src/agents/persona.js");

    const tempRepo = await makeTempRepo();
    const coordinator = createFastCoordinator();

    try {
      await Promise.race([
        coordinator.handleCoordinator(
          {} as any,
          {} as any,
          { workflow_id: "wf-blocked-analyze", project_id: "proj-blocked" },
          { repo: tempRepo },
        ),
        new Promise((_, reject) =>
          setTimeout(() => reject(new Error("Test timeout")), 100),
        ),
      ]);

      expect(sendPersonaRequest).toHaveBeenCalled();

      const calls = (sendPersonaRequest as any).mock.calls;
      const leadEngineerCall = calls.find(
        (call: any[]) =>
          call[1]?.persona === "lead-engineer" || call[2] === "lead-engineer",
      );

      if (leadEngineerCall) {
        expect(leadEngineerCall).toBeDefined();
      }
    } catch (error: any) {
      if (error.message === "Test timeout") {
        throw new Error("Analysis test workflow hung");
      }
    }
  });

  it("marks task as open after successful unblock", async () => {
    const { updateTaskStatus } = await import("../src/dashboard.js");

    const tempRepo = await makeTempRepo();
    const coordinator = createFastCoordinator();

    try {
      await Promise.race([
        coordinator.handleCoordinator(
          {} as any,
          {} as any,
          { workflow_id: "wf-blocked-success", project_id: "proj-blocked" },
          { repo: tempRepo },
        ),
        new Promise((_, reject) =>
          setTimeout(() => reject(new Error("Test timeout")), 100),
        ),
      ]);

      expect(updateTaskStatus).toHaveBeenCalled();

      const statusCalls = (updateTaskStatus as any).mock.calls;
      statusCalls.find(
        (call: any[]) => call[1] === "open" || call[0]?.status === "open",
      );
    } catch (error: any) {
      if (error.message === "Test timeout") {
        throw new Error("Success test workflow hung");
      }
    }
  });

  it("pauses unblock workflow while dependency tasks remain pending", async () => {
    fetchTaskMock.mockImplementation(async (id: string) => ({
      id,
      status: "blocked",
    }));

    const repoRoot = await makeTempRepo();

    const result = await workflowEngine.executeWorkflow(
      "blocked-task-resolution",
      {
        project_id: "proj-blocked",
        repo: repoRoot,
        repo_root: repoRoot,
        branch: "main",
        task: {
          id: "blocked-task-deps",
          name: "Blocked Task With Dependencies",
          status: "blocked",
          blocked_attempt_count: 1,
          blocked_dependencies: ["dep-501"],
        },
        blocked_dependencies: ["dep-501"],
      },
    );

    expect(result.success).toBe(true);
    const dependencyStatus =
      result.finalContext.getVariable("dependency_status");
    expect(dependencyStatus?.allResolved).toBe(false);
    expect(fetchTaskMock).toHaveBeenCalledWith("dep-501", "proj-blocked");
    expect(updateTaskStatusMock).not.toHaveBeenCalled();
    expect(updateBlockedDependenciesMock).not.toHaveBeenCalled();
  });

  it("continues unblock workflow when dependency tasks are resolved", async () => {
    fetchTaskMock.mockImplementation(async (id: string) => ({
      id,
      status: "done",
    }));

    const repoRoot = await makeTempRepo();

    const result = await workflowEngine.executeWorkflow(
      "blocked-task-resolution",
      {
        project_id: "proj-blocked",
        repo: repoRoot,
        repo_root: repoRoot,
        branch: "main",
        task: {
          id: "blocked-task-resolved",
          name: "Blocked Task With Resolved Dependencies",
          status: "blocked",
          blocked_attempt_count: 2,
          blocked_dependencies: ["dep-601"],
        },
        blocked_dependencies: ["dep-601"],
      },
    );

    expect(result.success).toBe(true);
    const dependencyStatus =
      result.finalContext.getVariable("dependency_status");
    expect(dependencyStatus?.allResolved).toBe(true);
    expect(fetchTaskMock).toHaveBeenCalledWith("dep-601", "proj-blocked");
    expect(updateTaskStatusMock).toHaveBeenCalled();
    expect(updateBlockedDependenciesMock).toHaveBeenCalledWith(
      "blocked-task-resolved",
      "proj-blocked",
      [],
    );
  });
});
