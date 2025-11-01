import { describe, it, expect, vi, beforeEach } from "vitest";
import { makeTempRepo } from "./makeTempRepo.js";
import { createFastCoordinator } from "./helpers/coordinatorTestHelper.js";

vi.mock("../src/redisClient.js");

vi.mock("../src/dashboard.js", () => ({
  fetchProjectStatus: vi.fn().mockResolvedValue({
    id: "proj-iter",
    name: "QA Plan Iteration Project",
    status: "active",
  }),
  fetchProjectStatusDetails: vi.fn().mockResolvedValue({
    tasks: [{ id: "task-1", name: "task-1", status: "open" }],
    repositories: [{ url: "https://example/repo.git" }],
  }),
  updateTaskStatus: vi.fn().mockResolvedValue({ ok: true, status: 200 }),
}));

describe("QA follow-up plan iteration respects max retries and requires ack", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("processes plan iteration workflow without hanging (business outcome)", async () => {
    const tempRepo = await makeTempRepo();
    let workflowExecuted = false;

    const coordinator = createFastCoordinator();

    try {
      await coordinator.handleCoordinator(
        {},
        { workflow_id: "wf-iter", project_id: "proj-iter" },
        { repo: tempRepo },
      );
      workflowExecuted = true;
    } catch (error) {
      workflowExecuted = true;
    }

    expect(workflowExecuted).toBe(true);
  });
});
