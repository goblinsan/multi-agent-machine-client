import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { cfg } from "../src/config";
import {
  inferArtifactKindFromPath,
  publishArtifactToDashboard,
  shouldCommitArtifactsToGit,
  shouldPublishArtifactsToApi,
} from "../src/workflows/helpers/artifactPublisher";

const publishMock = vi.hoisted(() => vi.fn());

vi.mock("../src/dashboard/ArtifactAPI.js", () => ({
  ArtifactAPI: class {
    publishTaskArtifact = publishMock;
  },
}));

describe("artifactPublisher", () => {
  const originalMode = cfg.maArtifactsMode;

  beforeEach(() => {
    publishMock.mockReset();
    publishMock.mockResolvedValue({ ok: true, status: 201, artifactId: 1 });
  });

  afterEach(() => {
    (cfg as any).maArtifactsMode = originalMode;
  });

  it("maps modes to git/api behavior", () => {
    (cfg as any).maArtifactsMode = "git";
    expect(shouldCommitArtifactsToGit()).toBe(true);
    expect(shouldPublishArtifactsToApi()).toBe(false);

    (cfg as any).maArtifactsMode = "api";
    expect(shouldCommitArtifactsToGit()).toBe(false);
    expect(shouldPublishArtifactsToApi()).toBe(true);

    (cfg as any).maArtifactsMode = "both";
    expect(shouldCommitArtifactsToGit()).toBe(true);
    expect(shouldPublishArtifactsToApi()).toBe(true);
  });

  it("publishes when mode allows it", async () => {
    (cfg as any).maArtifactsMode = "both";
    const ok = await publishArtifactToDashboard({
      projectId: "1",
      taskId: "57",
      workflowId: "wf-1",
      kind: "plan",
      iteration: 2,
      content: "plan body",
    });

    expect(ok).toBe(true);
    expect(publishMock).toHaveBeenCalledWith(
      expect.objectContaining({
        projectId: "1",
        taskId: "57",
        kind: "plan",
        iteration: 2,
        content: "plan body",
      }),
    );
  });

  it("skips publishing in git mode", async () => {
    (cfg as any).maArtifactsMode = "git";
    const ok = await publishArtifactToDashboard({
      projectId: "1",
      taskId: "57",
      kind: "plan",
      content: "plan body",
    });

    expect(ok).toBe(false);
    expect(publishMock).not.toHaveBeenCalled();
  });

  it("skips publishing when the task id is missing or unresolved", async () => {
    (cfg as any).maArtifactsMode = "both";

    expect(
      await publishArtifactToDashboard({
        projectId: "1",
        taskId: null,
        kind: "qa",
        content: "x",
      }),
    ).toBe(false);

    expect(
      await publishArtifactToDashboard({
        projectId: "1",
        taskId: "unknown",
        kind: "qa",
        content: "x",
      }),
    ).toBe(false);

    expect(publishMock).not.toHaveBeenCalled();
  });

  it("treats API failures as non-fatal", async () => {
    (cfg as any).maArtifactsMode = "both";
    publishMock.mockResolvedValue({ ok: false, status: 500, error: "boom" });

    const ok = await publishArtifactToDashboard({
      projectId: "1",
      taskId: "57",
      kind: "qa",
      content: "x",
    });
    expect(ok).toBe(false);
  });

  it("infers artifact kinds from file paths", () => {
    expect(inferArtifactKindFromPath(".ma/tasks/57/reviews/qa.json")).toBe("qa");
    expect(
      inferArtifactKindFromPath(".ma/tasks/57/reviews/code-review.json"),
    ).toBe("code_review");
    expect(inferArtifactKindFromPath(".ma/tasks/57/reviews/security.json")).toBe(
      "security",
    );
  });
});
