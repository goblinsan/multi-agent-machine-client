import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { cfg } from "../src/config";
import {
  resolveArtifactRefFromPath,
  fetchArtifactContentFromApi,
  fetchArtifactContentForPath,
} from "../src/workflows/helpers/artifactReader";

const fetchArtifactsMock = vi.hoisted(() => vi.fn());

vi.mock("../src/dashboard/ArtifactAPI.js", () => ({
  ArtifactAPI: class {
    publishTaskArtifact = vi.fn();
    fetchTaskArtifacts = fetchArtifactsMock;
  },
}));

describe("resolveArtifactRefFromPath", () => {
  it("maps planning loop artifact paths to kinds and iterations", () => {
    expect(
      resolveArtifactRefFromPath(".ma/tasks/57/02-plan-iteration-3.md"),
    ).toEqual({ kind: "plan", iteration: 3 });
    expect(
      resolveArtifactRefFromPath(".ma/tasks/57/02-plan-eval-iteration-1.md"),
    ).toEqual({ kind: "plan_eval", iteration: 1 });
    expect(resolveArtifactRefFromPath(".ma/tasks/57/03-plan-final.md")).toEqual(
      { kind: "plan_final" },
    );
  });

  it("maps review artifact paths to kinds", () => {
    expect(resolveArtifactRefFromPath(".ma/tasks/57/reviews/qa.json")).toEqual({
      kind: "qa",
    });
    expect(
      resolveArtifactRefFromPath(".ma/tasks/57/reviews/code-review.json"),
    ).toEqual({ kind: "code_review" });
    expect(
      resolveArtifactRefFromPath(".ma\\tasks\\57\\reviews\\security.json"),
    ).toEqual({ kind: "security" });
  });

  it("returns null for unrecognized paths", () => {
    expect(resolveArtifactRefFromPath(".ma/context/summary.md")).toBeNull();
    expect(resolveArtifactRefFromPath("src/index.ts")).toBeNull();
  });
});

describe("fetchArtifactContentFromApi", () => {
  const originalMode = cfg.maArtifactsMode;

  beforeEach(() => {
    fetchArtifactsMock.mockReset();
    (cfg as any).maArtifactsMode = "both";
  });

  afterEach(() => {
    (cfg as any).maArtifactsMode = originalMode;
  });

  it("returns the latest artifact content", async () => {
    fetchArtifactsMock.mockResolvedValue([
      { kind: "plan_final", iteration: null, content: "the plan", byte_size: 8 },
    ]);

    const content = await fetchArtifactContentFromApi({
      projectId: 1,
      taskId: 57,
      kind: "plan_final",
    });

    expect(content).toBe("the plan");
    expect(fetchArtifactsMock).toHaveBeenCalledWith(
      expect.objectContaining({ kind: "plan_final", latest: true }),
    );
  });

  it("selects a specific iteration when requested", async () => {
    fetchArtifactsMock.mockResolvedValue([
      { kind: "plan", iteration: 3, content: "iter three" },
      { kind: "plan", iteration: 2, content: "iter two" },
    ]);

    const content = await fetchArtifactContentFromApi({
      projectId: 1,
      taskId: 57,
      kind: "plan",
      iteration: 2,
    });

    expect(content).toBe("iter two");
    expect(fetchArtifactsMock).toHaveBeenCalledWith(
      expect.objectContaining({ kind: "plan", latest: false }),
    );
  });

  it("returns null in git mode without calling the API", async () => {
    (cfg as any).maArtifactsMode = "git";

    const content = await fetchArtifactContentFromApi({
      projectId: 1,
      taskId: 57,
      kind: "qa",
    });

    expect(content).toBeNull();
    expect(fetchArtifactsMock).not.toHaveBeenCalled();
  });

  it("returns null when the API has no artifacts or throws", async () => {
    fetchArtifactsMock.mockResolvedValueOnce([]);
    expect(
      await fetchArtifactContentFromApi({ projectId: 1, taskId: 57, kind: "qa" }),
    ).toBeNull();

    fetchArtifactsMock.mockRejectedValueOnce(new Error("connection refused"));
    expect(
      await fetchArtifactContentFromApi({ projectId: 1, taskId: 57, kind: "qa" }),
    ).toBeNull();
  });

  it("skips unresolved task ids", async () => {
    expect(
      await fetchArtifactContentFromApi({
        projectId: 1,
        taskId: "unknown",
        kind: "qa",
      }),
    ).toBeNull();
    expect(fetchArtifactsMock).not.toHaveBeenCalled();
  });
});

describe("fetchArtifactContentForPath", () => {
  beforeEach(() => {
    fetchArtifactsMock.mockReset();
    (cfg as any).maArtifactsMode = "both";
  });

  afterEach(() => {
    (cfg as any).maArtifactsMode = "git";
  });

  it("resolves the path to a kind before fetching", async () => {
    fetchArtifactsMock.mockResolvedValue([
      { kind: "plan_final", iteration: null, content: "final plan" },
    ]);

    const content = await fetchArtifactContentForPath({
      projectId: 1,
      taskId: 57,
      artifactPath: ".ma/tasks/57/03-plan-final.md",
    });

    expect(content).toBe("final plan");
  });

  it("returns null for unmapped paths without calling the API", async () => {
    const content = await fetchArtifactContentForPath({
      projectId: 1,
      taskId: 57,
      artifactPath: ".ma/context/summary.md",
    });

    expect(content).toBeNull();
    expect(fetchArtifactsMock).not.toHaveBeenCalled();
  });
});
