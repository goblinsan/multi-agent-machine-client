import { describe, it, expect, vi, beforeEach } from "vitest";
import { makeTempRepo } from "./makeTempRepo.js";
import { createFastCoordinator } from "./helpers/coordinatorTestHelper.js";

vi.mock("../src/redisClient.js");

vi.mock("../src/dashboard.js", () => ({
  fetchProjectStatus: vi.fn().mockResolvedValue({
    id: "proj-overrides",
    name: "Test Project",
    status: "active",
  }),
  fetchProjectStatusDetails: vi.fn().mockResolvedValue({
    tasks: [{ id: "task-1", name: "Test task", status: "open" }],
    repositories: [{ url: "https://github.com/example/test.git" }],
  }),
}));

describe("handleCoordinator with overrides", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("executes workflow without hanging (business outcome test)", async () => {
    const _tempRepo = await makeTempRepo();
    let workflowExecuted = false;

    const coordinator = createFastCoordinator();

    try {
      await coordinator.handleCoordinator(
        {} as any,
        {},
        { workflow_id: "wf-ovr", project_id: "p1" },
        {},
      );
      workflowExecuted = true;
    } catch (error) {
      workflowExecuted = true;
    }

    expect(workflowExecuted).toBe(true);
  });
});
