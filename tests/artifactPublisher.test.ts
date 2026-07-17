import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  inferArtifactKindFromPath,
  publishArtifactToDashboard,
} from "../src/workflows/helpers/artifactPublisher";

const publishMock = vi.hoisted(() => vi.fn());

vi.mock("../src/dashboard/ArtifactAPI.js", () => ({
  ArtifactAPI: class {
    publishTaskArtifact = publishMock;
  },
}));

describe("artifactPublisher", () => {
  beforeEach(() => {
    publishMock.mockReset();
    publishMock.mockResolvedValue({ ok: true, status: 201, artifactId: 1 });
  });

  it("publishes task artifacts to the dashboard", async () => {
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

  it("skips publishing when the task id is missing or unresolved", async () => {

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
