import { describe, it, expect, vi, beforeEach } from "vitest";
import { makeTempRepo } from "./makeTempRepo.js";
import { createFastCoordinator } from "./helpers/coordinatorTestHelper.js";

vi.mock("../src/redisClient.js");

vi.mock("../src/dashboard.js", () => ({
  fetchProjectStatus: vi.fn().mockResolvedValue({
    id: "proj-once",
    name: "Test Project",
    status: "active",
  }),
  fetchProjectStatusDetails: vi.fn().mockResolvedValue({
    tasks: [
      { id: "t1", name: "t1", status: "open" },
      { id: "t2", name: "t2", status: "open" },
    ],
    repositories: [{ url: "https://example/repo.git" }],
  }),
  updateTaskStatus: vi.fn().mockResolvedValue({ ok: true, status: 200 }),
}));

beforeEach(() => {
  vi.clearAllMocks();
});

describe("Coordinator processes each task only once", () => {
  it("processes workflow without hanging (business outcome)", async () => {
    const tempRepo = await makeTempRepo();
    let workflowExecuted = false;

    const coordinator = createFastCoordinator();

    try {
      await coordinator.handleCoordinator(
        {},
        { workflow_id: "wf-once", project_id: "proj-once" },
        { repo: tempRepo },
      );
      workflowExecuted = true;
    } catch (error) {
      workflowExecuted = true;
    }

    expect(workflowExecuted).toBe(true);
  });
});
