import { describe, it, expect, beforeEach, vi } from "vitest";
import { PrioritizeExistingTasksStep } from "../src/workflows/steps/PrioritizeExistingTasksStep.js";
import { WorkflowContext } from "../src/workflows/engine/WorkflowContext.js";

const updateTaskMock = vi.fn();
const getTaskMock = vi.fn();

vi.mock("../src/services/DashboardClient.js", () => {
  return {
    createDashboardClient: () => ({
      updateTask: updateTaskMock,
      getTask: getTaskMock,
    }),
  };
});

function buildContext() {
  return new WorkflowContext(
    "workflow-test",
    "1",
    "/tmp/repo",
    "main",
    { name: "analysis-task-flow", version: "1.0.0", steps: [] },
    {} as any,
  );
}

describe("PrioritizeExistingTasksStep", () => {
  beforeEach(() => {
    updateTaskMock.mockReset();
    getTaskMock.mockReset();
  });

  it("prioritizes duplicate follow-up tasks", async () => {
    getTaskMock.mockResolvedValue({ labels: ["qa_follow_up"] });
    updateTaskMock.mockResolvedValue({});

    const step = new PrioritizeExistingTasksStep({
      name: "prioritize_duplicates",
      type: "PrioritizeExistingTasksStep",
      config: {
        project_id: "1",
        task_ids: ["59"],
        priority_score: 1200,
        ensure_labels: ["analysis"],
        status: "open",
      },
    });

    const result = await step.execute(buildContext());

    expect(result.status).toBe("success");
    expect(updateTaskMock).toHaveBeenCalledWith(1, 59, {
      priority_score: 1200,
      status: "open",
      labels: ["qa_follow_up", "analysis"],
    });
    expect(result.outputs?.updated_task_ids).toEqual(["59"]);
  });

  it("skips gracefully when no task ids provided", async () => {
    const step = new PrioritizeExistingTasksStep({
      name: "prioritize_duplicates",
      type: "PrioritizeExistingTasksStep",
      config: {
        project_id: "1",
        task_ids: [],
        priority_score: 1000,
        ensure_labels: ["analysis"],
      },
    });

    const result = await step.execute(buildContext());

    expect(result.status).toBe("success");
    expect(updateTaskMock).not.toHaveBeenCalled();
    expect(result.outputs?.updated_task_ids).toEqual([]);
  });
});
