import { describe, it, expect, vi, beforeEach } from "vitest";
import { makeTempRepo } from "./makeTempRepo.js";
import { WorkflowCoordinator } from "../src/workflows/WorkflowCoordinator.js";
import * as gitUtils from "../src/gitUtils.js";

vi.mock("../src/redisClient.js");

beforeEach(() => {
  vi.clearAllMocks();
});

describe("force_rescan flag propagation - integration-ish", () => {
  it("passes force_rescan from payload into workflow initialVariables", async () => {
    const tempRepo = await makeTempRepo();

    const coordinator = new WorkflowCoordinator();
    await coordinator.loadWorkflows();

    vi.spyOn(gitUtils, "resolveRepoFromPayload").mockResolvedValue({
      repoRoot: tempRepo,
      branch: "main",
      remote: "https://example/repo.git",
    } as any);

    let capturedInitialVars: any = null;
    const engine = (coordinator as any).engine;
    vi.spyOn(coordinator as any, "fetchProjectTasks")
      .mockResolvedValueOnce([
        { id: "t-1", name: "task", status: "open", type: "feature" },
      ])
      .mockResolvedValueOnce([]);

    vi.spyOn(engine, "executeWorkflowDefinition").mockImplementation(async (...args: any[]) => {
      capturedInitialVars = args[5];
      return {
        success: true,
        outputs: {},
        stepResults: [],
        variables: capturedInitialVars,
        completedSteps: [],
        duration: 0,
        finalContext: {} as any,
      };
    });

    const payload = { project_id: "test-proj", force_rescan: true, repo: tempRepo };

    await coordinator.handleCoordinator({} as any, {} as any, { workflow_id: "wf-test", project_id: "test-proj" }, payload);

    expect(capturedInitialVars).toBeTruthy();
    expect(capturedInitialVars.force_rescan).toBe(true);
  });
});
