import { describe, it, expect, beforeEach, vi } from "vitest";
import { makeTempRepo } from "../makeTempRepo.js";
import { WorkflowContext } from "../../src/workflows/engine/WorkflowContext.js";
import { DependencyStatusStep } from "../../src/workflows/steps/DependencyStatusStep.js";

const { fetchTaskMock } = vi.hoisted(() => ({ fetchTaskMock: vi.fn() }));

vi.mock("../../src/dashboard/TaskAPI.js", () => ({
  TaskAPI: vi.fn().mockImplementation(() => ({
    fetchTask: fetchTaskMock,
  })),
}));

vi.mock("../../src/logger.js", () => ({
  logger: {
    info: vi.fn(),
    debug: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

describe("DependencyStatusStep", () => {
  let context: WorkflowContext;
  let repoRoot: string;
  let transport: any;

  beforeEach(async () => {
    repoRoot = await makeTempRepo();
    transport = {};
    fetchTaskMock.mockReset();

    context = new WorkflowContext(
      "wf-deps-001",
      "proj-123",
      repoRoot,
      "main",
      {
        name: "test",
        version: "1.0.0",
        steps: [],
      },
      transport,
      {},
    );

    context.setVariable("projectId", "proj-123");
    fetchTaskMock.mockReset();
  });

  it("reports allResolved when no dependencies exist", async () => {
    const step = new DependencyStatusStep({
      name: "dependency_status",
      type: "DependencyStatusStep",
      config: {},
    });

    const result = await step.execute(context);

    expect(result.status).toBe("success");
    expect(result.data?.allResolved).toBe(true);
    expect(result.data?.dependencyCount).toBe(0);
    expect(fetchTaskMock).not.toHaveBeenCalled();
    expect(context.getVariable("blocked_dependencies")).toEqual([]);
  });

  it("fetches dependency tasks and separates pending vs resolved", async () => {
    context.setVariable("blocked_dependencies", ["201", "202", "201"]);

    fetchTaskMock.mockImplementation(async (id: string) => {
      if (id === "201") {
        return { id: "201", status: "done" };
      }
      if (id === "202") {
        return { id: "202", status: "blocked" };
      }
      return null;
    });

    const step = new DependencyStatusStep({
      name: "dependency_status",
      type: "DependencyStatusStep",
      config: {
        dependency_variable: "blocked_dependencies",
      },
    });

    const result = await step.execute(context);

    expect(result.status).toBe("success");
    expect(fetchTaskMock).toHaveBeenCalledTimes(2);
    expect(result.data?.dependencyCount).toBe(2);
    expect(result.data?.resolvedCount).toBe(1);
    expect(result.data?.pendingCount).toBe(1);
    expect(result.data?.allResolved).toBe(false);

    const summary = context.getVariable("dependency_status");
    expect(summary.pending[0].id).toBe("202");
    expect(summary.resolved[0].id).toBe("201");
  });

  it("falls back to task.blocked_dependencies when context variable is empty", async () => {
    context.setVariable("task", { blocked_dependencies: ["301", "302"] });

    fetchTaskMock.mockImplementation(async (id: string) => ({
      id,
      status: id === "301" ? "done" : "open",
    }));

    const step = new DependencyStatusStep({
      name: "dependency_status",
      type: "DependencyStatusStep",
      config: {},
    });

    const result = await step.execute(context);

    expect(result.status).toBe("success");
    expect(fetchTaskMock).toHaveBeenCalledTimes(2);
    expect(context.getVariable("blocked_dependencies")).toEqual([
      "301",
      "302",
    ]);
    expect(result.data?.resolvedCount).toBe(1);
    expect(result.data?.pendingCount).toBe(1);
  });

  it("refreshes dependencies from TaskAPI when local snapshot is stale", async () => {
    context.setVariable("task", { id: "task-401", blocked_dependencies: [] });
    context.setVariable("taskId", "task-401");

    fetchTaskMock.mockImplementation(async (id: string) => {
      if (id === "task-401") {
        return { id, blocked_dependencies: ["401"] };
      }
      if (id === "401") {
        return { id: "401", status: "in_progress" };
      }
      return null;
    });

    const step = new DependencyStatusStep({
      name: "dependency_status",
      type: "DependencyStatusStep",
      config: {},
    });

    const result = await step.execute(context);

    expect(result.status).toBe("success");
    expect(result.data?.dependencyCount).toBe(1);
    expect(result.data?.allResolved).toBe(false);
    expect(fetchTaskMock).toHaveBeenCalledTimes(2);
    expect(context.getVariable("blocked_dependencies")).toEqual(["401"]);
  });

  it("normalizes metadata blocked dependency strings when refreshing", async () => {
    context.setVariable("task", { id: "task-501" });
    context.setVariable("taskId", "task-501");

    fetchTaskMock.mockImplementation(async (id: string) => {
      if (id === "task-501") {
        return {
          id,
          metadata: {
            blocked_dependencies: "501, 502",
          },
        };
      }
      return { id, status: id === "501" ? "done" : "blocked" };
    });

    const step = new DependencyStatusStep({
      name: "dependency_status",
      type: "DependencyStatusStep",
      config: {},
    });

    const result = await step.execute(context);

    expect(result.status).toBe("success");
    expect(result.data?.dependencyCount).toBe(2);
    expect(result.data?.pendingCount).toBe(1);
    expect(context.getVariable("blocked_dependencies")).toEqual([
      "501",
      "502",
    ]);
    expect(fetchTaskMock).toHaveBeenCalledTimes(3);
  });
});
