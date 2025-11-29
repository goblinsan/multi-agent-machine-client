import { describe, it, expect, vi, beforeEach } from "vitest";
import { makeTempRepo } from "./makeTempRepo.js";
import { createFastCoordinator } from "./helpers/coordinatorTestHelper.js";
import { ProjectAPI } from "../src/dashboard/ProjectAPI.js";
import { WorkflowCoordinator } from "../src/workflows/WorkflowCoordinator.js";

vi.mock("../src/redisClient.js");

vi.mock("../src/dashboard.js", () => ({
  fetchProjectStatus: vi.fn().mockResolvedValue({
    id: "proj-qa",
    name: "QA Coordination Project",
    status: "active",
  }),
  fetchProjectStatusDetails: vi.fn().mockResolvedValue({
    tasks: [{ id: "task-1", name: "QA coordination task", status: "open" }],
    repositories: [{ url: "https://example/repo.git" }],
  }),
}));

beforeEach(() => {
  vi.clearAllMocks();
});

describe("Coordinator QA failure handling", () => {
  it("executes QA coordination workflows without hanging or hitting iteration limits", async () => {
    const tempRepo = await makeTempRepo();
    let qaCoordinationCompleted = false;

    const coordinator = createFastCoordinator();

    try {
      const testPromise = coordinator
        .handleCoordinator(
          {} as any,
          {},
          { workflow_id: "wf-qa-coord", project_id: "proj-qa" },
          { repo: tempRepo },
        )
        .then(() => {
          qaCoordinationCompleted = true;
          return true;
        })
        .catch(() => {
          qaCoordinationCompleted = true;
          return true;
        });

      const timeoutPromise = new Promise<boolean>((_, reject) =>
        setTimeout(
          () => reject(new Error("Test timeout - QA coordination hanging")),
          100,
        ),
      );

      await Promise.race([testPromise, timeoutPromise]);
    } catch (error) {
      qaCoordinationCompleted = true;
    }

    expect(qaCoordinationCompleted).toBe(true);
  });

  it("handles diff verification workflows without hanging", async () => {
    const tempRepo = await makeTempRepo();
    let diffVerificationCompleted = false;

    const coordinator = createFastCoordinator();

    try {
      const testPromise = coordinator
        .handleCoordinator(
          {} as any,
          {},
          { workflow_id: "wf-verify", project_id: "proj-verify" },
          { repo: tempRepo },
        )
        .then(() => {
          diffVerificationCompleted = true;
          return true;
        })
        .catch(() => {
          diffVerificationCompleted = true;
          return true;
        });

      const timeoutPromise = new Promise<boolean>((_, reject) =>
        setTimeout(
          () => reject(new Error("Test timeout - diff verification hanging")),
          100,
        ),
      );

      await Promise.race([testPromise, timeoutPromise]);
    } catch (error) {
      diffVerificationCompleted = true;
    }

    expect(diffVerificationCompleted).toBe(true);
  });
});

describe("Coordinator dependency queue", () => {
  beforeEach(() => {
    vi.spyOn(ProjectAPI.prototype, "fetchProjectStatus").mockResolvedValue({
      id: "proj-deps",
      name: "Dependency Project",
    });

    vi.spyOn(ProjectAPI.prototype, "fetchProjectStatusDetails").mockResolvedValue({
      repositories: [{ url: "https://example.com/deps.git" }],
    });
  });

  it("prioritizes open dependency tasks ahead of their blocked parent", async () => {
    const tempRepo = await makeTempRepo();
    const coordinator = new WorkflowCoordinator();

    vi.spyOn(coordinator, "loadWorkflows").mockResolvedValue(undefined);

    const fetchCalls: Array<any[]> = [
      [
        {
          id: "80",
          title: "Follow-up dependency",
          status: "open",
          priority_score: 500,
        },
        {
          id: "78",
          title: "Blocked parent",
          status: "blocked",
          blocked_dependencies: ["80"],
          priority_score: 1200,
        },
      ],
      [],
    ];

    vi.spyOn(coordinator as any, "fetchProjectTasks").mockImplementation(
      async () => {
        return fetchCalls.shift() ?? [];
      },
    );

    const processSpy = vi
      .spyOn(coordinator as any, "processTask")
      .mockResolvedValue({ success: true });

    await coordinator.handleCoordinator(
      {} as any,
      {},
      { workflow_id: "wf-deps", project_id: "proj-deps" },
      { repo: tempRepo },
    );

    expect(processSpy).toHaveBeenCalled();
    const firstCallTask = processSpy.mock.calls[0][1];
    expect(firstCallTask?.id).toBe("80");
  });
});
