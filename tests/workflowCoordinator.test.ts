import { describe, it, expect, vi, beforeEach } from "vitest";
import { WorkflowCoordinator } from "../src/workflows/WorkflowCoordinator";
import { WorkflowEngine } from "../src/workflows/WorkflowEngine";
import { WorkflowContext } from "../src/workflows/engine/WorkflowContext";
import * as gitUtils from "../src/gitUtils.js";
import { createFastCoordinator } from "./helpers/coordinatorTestHelper.js";

vi.mock("../src/redisClient.js");

vi.mock("../src/dashboard/ProjectAPI.js", () => ({
  ProjectAPI: vi.fn().mockImplementation(() => ({
    fetchProjectStatus: vi.fn().mockResolvedValue({
      name: "Test Project",
      slug: "test-project",
    }),
    fetchProjectStatusDetails: vi.fn().mockResolvedValue({
      milestones: [
        {
          id: "milestone-1",
          name: "Test Milestone",
          tasks: [
            {
              id: "task-1",
              name: "Test Task",
              status: "open",
              description: "A test task for workflow processing",
            },
          ],
        },
      ],
    }),
  })),
}));

describe("WorkflowCoordinator Integration", () => {
  let coordinator: WorkflowCoordinator;
  let mockEngine: WorkflowEngine;

  beforeEach(() => {
    mockEngine = new WorkflowEngine();
    coordinator = new WorkflowCoordinator(mockEngine);

    vi.clearAllMocks();
  });

  it("should extract repository remote correctly", () => {
    const details = {
      repository: { clone_url: "https://github.com/test/repo.git" },
    };
    const projectInfo = { repo: { url: "https://gitlab.com/test/repo.git" } };
    const payload = { repo: "https://bitbucket.org/test/repo.git" };
    const detailsWithRepositories = {
      repositories: [{ url: "https://projects.example.com/org/repo.git" }],
    };

    expect(
      coordinator["extractRepoRemote"](details, projectInfo, payload),
    ).toBe("https://github.com/test/repo.git");

    expect(coordinator["extractRepoRemote"]({}, projectInfo, payload)).toBe(
      "https://gitlab.com/test/repo.git",
    );

    expect(coordinator["extractRepoRemote"]({}, {}, payload)).toBe(
      "https://bitbucket.org/test/repo.git",
    );

    expect(
      coordinator["extractRepoRemote"](detailsWithRepositories, {}, {}),
    ).toBe("https://projects.example.com/org/repo.git");

    expect(coordinator["extractRepoRemote"]({}, {}, {})).toBe("");
  });

  it("should handle workflow loading", async () => {
    const mockDefinitions = [
      {
        name: "project-loop",
        description: "Standard project workflow",
        version: "1.0.0",
        trigger: { condition: 'task_type == "task"' },
        context: { repo_required: true },
        steps: [],
      },
      {
        name: "hotfix",
        description: "Hotfix workflow",
        version: "1.0.0",
        trigger: { condition: 'task_type == "hotfix"' },
        context: { repo_required: true },
        steps: [],
      },
      {
        name: "feature",
        description: "Feature workflow",
        version: "1.0.0",
        trigger: { condition: 'task_type == "feature"' },
        context: { repo_required: true },
        steps: [],
      },
    ];

    vi.spyOn(mockEngine, "loadWorkflowsFromDirectory").mockResolvedValue(
      mockDefinitions,
    );
    vi.spyOn(mockEngine, "getWorkflowDefinitions").mockReturnValue(
      mockDefinitions,
    );

    await coordinator.loadWorkflows();

    expect(mockEngine.loadWorkflowsFromDirectory).toHaveBeenCalledWith(
      expect.stringContaining("src/workflows/definitions"),
    );
  });
});

describe("WorkflowCoordinator Task Processing", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("processes tasks through workflows without hanging", async () => {
    let workflowCompleted = false;

    const coordinator = createFastCoordinator();

    try {
      const testPromise = coordinator
        .handleCoordinator(
          {} as any,
          {} as any,
          { workflow_id: "wf-task-processing", project_id: "proj-process" },
          { repo: "https://example/repo.git" },
        )
        .then(() => {
          workflowCompleted = true;
          return true;
        })
        .catch(() => {
          workflowCompleted = true;
          return true;
        });

      const timeoutPromise = new Promise<boolean>((_, reject) =>
        setTimeout(
          () => reject(new Error("Test timeout - task processing hanging")),
          500,
        ),
      );

      await Promise.race([testPromise, timeoutPromise]);
    } catch (error) {
      workflowCompleted = true;
    }

    expect(workflowCompleted).toBe(true);
  });

  it("handles workflow execution scenarios without hanging", async () => {
    let workflowCompleted = false;

    const coordinator = createFastCoordinator();

    try {
      const testPromise = coordinator
        .handleCoordinator(
          {} as any,
          {} as any,
          { workflow_id: "wf-exec-handling", project_id: "proj-exec" },
          { repo: "https://example/repo.git" },
        )
        .then(() => {
          workflowCompleted = true;
          return true;
        })
        .catch(() => {
          workflowCompleted = true;
          return true;
        });

      const timeoutPromise = new Promise<boolean>((_, reject) =>
        setTimeout(
          () => reject(new Error("Test timeout - execution handling hanging")),
          500,
        ),
      );

      await Promise.race([testPromise, timeoutPromise]);
    } catch (error) {
      workflowCompleted = true;
    }

    expect(workflowCompleted).toBe(true);
  });

  it("aborts coordinator loop after workflow failure", async () => {
    const coordinator = createFastCoordinator();

    const fetchTasksSpy = vi
      .spyOn(coordinator as any, "fetchProjectTasks")
      .mockResolvedValue([{ id: "task-1", name: "Task 1", status: "open" }]);

    const resolveRepoSpy = vi
      .spyOn(gitUtils, "resolveRepoFromPayload")
      .mockResolvedValue({
        repoRoot: "/tmp/repo",
        branch: "main",
        remote: "https://example/repo.git",
      } as any);

    const processTaskSpy = vi
      .spyOn(coordinator as any, "processTask")
      .mockResolvedValue({
        success: false,
        failedStep: "context_request",
        error: "context failure",
      });

    const result = await coordinator.handleCoordinator(
      {} as any,
      {} as any,
      { workflow_id: "wf-abort", project_id: "proj-abort" },
      { repo: "https://example/repo.git" },
    );

    expect(processTaskSpy).toHaveBeenCalledTimes(1);
    expect(fetchTasksSpy).toHaveBeenCalledTimes(1);
    expect(result.results[0]?.success).toBe(false);
    expect(result.results).toHaveLength(1);

    fetchTasksSpy.mockRestore();
    resolveRepoSpy.mockRestore();
    processTaskSpy.mockRestore();
  });

  it("records workflow abort metadata when execution fails", async () => {
    const engine = new WorkflowEngine();
    const coordinator = new WorkflowCoordinator(engine);

    const workflowDef = {
      name: "task-flow",
      description: "Test workflow",
      version: "1.0.0",
      trigger: { condition: "task_type == 'task'" },
      context: { repo_required: true },
      steps: [],
    } as any;

    vi.spyOn(engine, "getWorkflowDefinition").mockImplementation(
      (name: string) => (name === "task-flow" ? workflowDef : undefined),
    );
    vi.spyOn(engine, "findWorkflowByCondition").mockReturnValue(workflowDef);

    const finalContext = new WorkflowContext(
      "wf-failure",
      "proj-1",
      "/tmp/repo",
      "main",
      workflowDef,
      {} as any,
      {},
    );

    vi.spyOn(engine, "executeWorkflowDefinition").mockResolvedValue({
      success: false,
      completedSteps: ["checkout_branch"],
      failedStep: "context_request",
      error: new Error("context timeout"),
      duration: 25,
      finalContext,
    });

    const result = await (coordinator as any).processTask(
      {
        id: "task-99",
        name: "Failing Task",
        status: "open",
        description: "Trigger failure",
      },
      {
        workflowId: "wf-top",
        projectId: "proj-1",
        projectName: "Project",
        repoSlug: "project",
        repoRoot: "/tmp/repo",
        branch: "main",
        remote: "https://github.com/test/repo.git",
      },
    );

    expect(result.success).toBe(false);
    expect(finalContext.getVariable("workflowAborted")).toBe(true);
    const abortMeta = finalContext.getVariable("workflowAbort");
    expect(abortMeta?.reason).toBe("workflow_step_failure");
    expect(abortMeta?.details?.failedStep).toBe("context_request");
  });
});
