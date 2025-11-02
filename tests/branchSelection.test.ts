import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  setupAllMocks,
  coordinatorMod,
  TestProject,
} from "./helpers/mockHelpers.js";
import * as gitUtils from "../src/gitUtils.js";

vi.mock("../src/redisClient.js");

beforeEach(() => {
  vi.clearAllMocks();
});

describe("Coordinator branch selection", () => {
  it(
    "uses remote default branch as base and avoids milestone/milestone",
    { timeout: 1000 },
    async () => {
      const project: TestProject = {
        id: "proj-2",
        name: "Demo Project",
        repositories: [{ url: "https://example/repo.git" }],
        tasks: [{ id: "t-1", name: "task", status: "open" }],
      };

      setupAllMocks(project, [], {
        "3-devops": {
          fields: { result: JSON.stringify({ status: "pass" }) },
          id: "evt-devops",
        } as any,
      });

      vi.spyOn(gitUtils, "getRepoMetadata").mockResolvedValue({
        remoteSlug: "example/repo",
        currentBranch: "milestone/milestone",
        remoteUrl: "https://example/repo.git",
      } as any);

      vi.spyOn(gitUtils, "detectRemoteDefaultBranch").mockResolvedValue("main");

      vi.spyOn(gitUtils, "resolveRepoFromPayload").mockResolvedValue({
        repoRoot: "/tmp/repo",
        branch: null,
        remote: "https://example/repo.git",
      } as any);

      vi.spyOn(gitUtils, "describeWorkingTree").mockResolvedValue({
        dirty: false,
        branch: "milestone/milestone",
        entries: [],
        summary: {
          staged: 0,
          unstaged: 0,
          untracked: 0,
          total: 0,
        },
        porcelain: [],
      } as any);

      const checkoutSpy = vi
        .spyOn(gitUtils, "checkoutBranchFromBase")
        .mockResolvedValue(undefined as any);
      vi.spyOn(gitUtils, "ensureBranchPublished").mockResolvedValue(
        undefined as any,
      );

      const coordinator = new coordinatorMod.WorkflowCoordinator();
      const msg = { workflow_id: "wf-branch", project_id: "proj-2" } as any;
      const payload = { repo: "https://example/repo.git" } as any;
      await coordinator.handleCoordinator({} as any, {} as any, msg, payload);

      expect(checkoutSpy).toHaveBeenCalled();
      const [repoRoot, baseBranch, newBranch] = checkoutSpy.mock
        .calls[0] as any[];
      expect(repoRoot).toBe("/tmp/repo");
      expect(baseBranch).toBe("main");

  expect(newBranch).toBe("milestone/repo");
    },
  );
});
