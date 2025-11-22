import { describe, it, expect, beforeEach, vi } from "vitest";
import { RegisterBlockedDependenciesStep } from "../../src/workflows/steps/RegisterBlockedDependenciesStep.js";
import { WorkflowContext } from "../../src/workflows/engine/WorkflowContext.js";

const mocks = vi.hoisted(() => ({
  fetchTaskMock: vi.fn(),
  updateBlockedDependenciesMock: vi.fn().mockResolvedValue({ ok: true }),
}));

vi.mock("../../src/dashboard/TaskAPI.js", () => ({
  TaskAPI: vi.fn().mockImplementation(() => ({
    fetchTask: mocks.fetchTaskMock,
    updateBlockedDependencies: mocks.updateBlockedDependenciesMock,
  })),
}));

describe("RegisterBlockedDependenciesStep", () => {
  let context: WorkflowContext;
  const { fetchTaskMock, updateBlockedDependenciesMock } = mocks;

  beforeEach(() => {
    const transport: any = {};
    context = new WorkflowContext(
      "wf-test",
      "proj-test",
      "/tmp/repo",
      "main",
      { name: "test", version: "1.0.0", steps: [] },
      transport,
    );

    fetchTaskMock.mockReset();
    updateBlockedDependenciesMock.mockReset();
  });

  it("merges new dependency ids with existing ones", async () => {
    fetchTaskMock.mockResolvedValue({
      id: "parent-1",
      blocked_dependencies: ["101"],
    });

    const step = new RegisterBlockedDependenciesStep({
      name: "register",
      type: "RegisterBlockedDependenciesStep",
      config: {
        project_id: "proj-1",
        parent_task_id: "parent-1",
        dependency_task_ids: ["102", "101", "103"],
      },
    });

    const result = await step.execute(context);

    expect(result.status).toBe("success");
    expect(updateBlockedDependenciesMock).toHaveBeenCalledWith(
      "parent-1",
      "proj-1",
      ["101", "102", "103"],
    );
  });

  it("skips when no dependency ids are provided", async () => {
    const step = new RegisterBlockedDependenciesStep({
      name: "register",
      type: "RegisterBlockedDependenciesStep",
      config: {
        project_id: "proj-1",
        parent_task_id: "parent-1",
        dependency_task_ids: [],
      },
    });

    const result = await step.execute(context);

    expect(result.status).toBe("success");
    expect(fetchTaskMock).not.toHaveBeenCalled();
    expect(updateBlockedDependenciesMock).not.toHaveBeenCalled();
  });

  it("clears dependencies when allow_clear is true", async () => {
    const step = new RegisterBlockedDependenciesStep({
      name: "clear",
      type: "RegisterBlockedDependenciesStep",
      config: {
        project_id: "proj-1",
        parent_task_id: "parent-1",
        dependency_task_ids: [],
        allow_clear: true,
      },
    });

    const result = await step.execute(context);

    expect(result.status).toBe("success");
    expect(fetchTaskMock).not.toHaveBeenCalled();
    expect(updateBlockedDependenciesMock).toHaveBeenCalledWith(
      "parent-1",
      "proj-1",
      [],
    );
  });

  it("fails if parent task cannot be loaded", async () => {
    fetchTaskMock.mockResolvedValue(null);

    const step = new RegisterBlockedDependenciesStep({
      name: "register",
      type: "RegisterBlockedDependenciesStep",
      config: {
        project_id: "proj-1",
        parent_task_id: "missing",
        dependency_task_ids: ["201"],
      },
    });

    const result = await step.execute(context);

    expect(result.status).toBe("failure");
    expect(updateBlockedDependenciesMock).not.toHaveBeenCalled();
  });
});
