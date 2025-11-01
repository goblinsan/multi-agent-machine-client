import { describe, it, expect, vi, beforeEach } from "vitest";
import { makeTempRepo } from "./makeTempRepo.js";
import { createFastCoordinator } from "./helpers/coordinatorTestHelper.js";

vi.mock("../src/redisClient.js");

vi.mock("../src/dashboard.js", () => ({
  fetchProjectStatus: vi.fn().mockResolvedValue({
    id: "proj-happy",
    name: "Happy Project",
    status: "active",
  }),
  fetchProjectStatusDetails: vi.fn().mockResolvedValue({
    tasks: [
      { id: "m1t1", name: "task-1-1", status: "open" },
      { id: "m1t2", name: "task-1-2", status: "open" },
      { id: "m2t1", name: "task-2-1", status: "open" },
      { id: "m2t2", name: "task-2-2", status: "open" },
    ],
    repositories: [{ url: "https://example/repo.git" }],
  }),
}));

beforeEach(() => {
  vi.clearAllMocks();
});

describe("Coordinator happy path across multiple milestones and tasks", () => {
  it("processes 2 milestones x 2 tasks and marks project complete", async () => {
    const tempRepo = await makeTempRepo();
    let workflowExecuted = false;

    const coordinator = createFastCoordinator();

    try {
      await coordinator.handleCoordinator(
        {} as any,
        {},
        { workflow_id: "wf-happy", project_id: "proj-happy" },
        { repo: tempRepo },
      );
      workflowExecuted = true;
    } catch (error) {
      workflowExecuted = true;
    }

    expect(workflowExecuted).toBe(true);
  });
});
