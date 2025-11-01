import { vi } from "vitest";

export const resolveRepoFromPayload = vi
  .fn()
  .mockImplementation(async (payload) => ({
    repoRoot: payload.repo || "/tmp/test-repo",
    branch: payload.branch || "main",
    remote: "https://example.com/test-repo.git",
  }));

export const checkout = vi.fn().mockResolvedValue(undefined);

export const commit = vi.fn().mockResolvedValue("mock-commit-sha");

export const push = vi.fn().mockResolvedValue(undefined);

export const getCurrentBranch = vi.fn().mockResolvedValue("main");

export const getBranchList = vi.fn().mockResolvedValue(["main", "develop"]);
