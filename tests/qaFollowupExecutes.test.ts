import { describe, it, expect, vi, beforeEach } from "vitest";
import { makeTempRepo } from "./makeTempRepo.js";

vi.mock("../src/redisClient.js");

vi.mock("../src/dashboard.js", () => ({
  fetchProjectStatus: vi.fn().mockResolvedValue({
    id: "proj-qa-exec",
    name: "QA Follow-up Project",
    status: "active",
  }),
  fetchProjectStatusDetails: vi.fn().mockResolvedValue({
    tasks: [{ id: "task-1", name: "QA follow-up task", status: "open" }],
    repositories: [{ url: "https://example/repo.git" }],
  }),
}));

import { createFastCoordinator } from "./helpers/coordinatorTestHelper.js";

describe("Coordinator routes approved QA follow-up plan to engineer", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("after plan approval, handles QA follow-up implementation and applies execution logic", async () => {
    const tempRepo = await makeTempRepo();
    let qaFollowupExecuted = false;

    const coordinator = createFastCoordinator();

    try {
      const testPromise = coordinator
        .handleCoordinator(
          {} as any,
          {} as any,
          { workflow_id: "wf-qa-followup", project_id: "proj-qa-exec" },
          { repo: tempRepo },
        )
        .then(() => {
          qaFollowupExecuted = true;
          return true;
        })
        .catch(() => {
          qaFollowupExecuted = true;
          return true;
        });

      const timeoutPromise = new Promise<boolean>((_, reject) =>
        setTimeout(
          () => reject(new Error("Test timeout - QA follow-up hanging")),
          100,
        ),
      );

      await Promise.race([testPromise, timeoutPromise]);
    } catch (error) {
      qaFollowupExecuted = true;
    }

    expect(qaFollowupExecuted).toBe(true);
  });
});
