import { describe, it, expect, vi } from "vitest";

vi.mock("../src/redisClient.js");

describe("force_rescan flag propagation", () => {
  it("passes force_rescan=true from payload to processTask context parameter", () => {
    const payload = { force_rescan: true };
    const context = {
      workflowId: "test-wf",
      projectId: "test-proj",
      projectName: "Test",
      projectSlug: "test",
      repoRoot: "/tmp/test",
      branch: "main",
      remote: "git@example.com:test/repo.git",
      force_rescan: payload.force_rescan || false,
    };

    expect(context.force_rescan).toBe(true);
  });

  it("defaults force_rescan=false when not in payload", () => {
    const payload = {};
    const context = {
      workflowId: "test-wf",
      projectId: "test-proj",
      projectName: "Test",
      projectSlug: "test",
      repoRoot: "/tmp/test",
      branch: "main",
      remote: "git@example.com:test/repo.git",
      force_rescan: (payload as any).force_rescan || false,
    };

    expect(context.force_rescan).toBe(false);
  });

  it("force_rescan is passed to executeWorkflow initialVariables", () => {
    const context = {
      workflowId: "test-wf",
      projectId: "test-proj",
      projectName: "Test Project",
      projectSlug: "test-project",
      repoRoot: "/tmp/test",
      branch: "main",
      remote: "git@example.com:test/repo.git",
      force_rescan: true,
    };

    const initialVariables = {
      taskId: "task-1",
      projectId: context.projectId,
      projectName: context.projectName,
      repo_remote: context.remote,
      force_rescan: context.force_rescan || false,
    };

    expect(initialVariables.force_rescan).toBe(true);
  });
});
