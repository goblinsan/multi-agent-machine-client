import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import fs from "fs/promises";
import os from "os";
import path from "path";
import { cfg } from "../src/config";
import {
  hydrateContextArtifacts,
  loadExistingSnapshot,
  CONTEXT_ARTIFACT_KINDS,
} from "../src/workflows/steps/context/ContextArtifacts";

const fetchProjectArtifactsMock = vi.hoisted(() => vi.fn());

vi.mock("../src/dashboard/ArtifactAPI.js", () => ({
  ArtifactAPI: class {
    publishTaskArtifact = vi.fn();
    fetchTaskArtifacts = vi.fn();
    publishProjectArtifact = vi.fn();
    fetchProjectArtifacts = fetchProjectArtifactsMock;
  },
}));

describe("hydrateContextArtifacts", () => {
  const originalMode = cfg.maArtifactsMode;
  const snapshotTimestamp = Date.parse("2026-07-01T12:00:00Z");
  let repoDir: string;

  const artifactByKind: Record<string, string> = {
    [CONTEXT_ARTIFACT_KINDS.snapshot]: JSON.stringify({
      timestamp: snapshotTimestamp,
      files: [],
      totals: { files: 0, bytes: 0 },
    }),
    [CONTEXT_ARTIFACT_KINDS.summary]: "# Summary\n\nPrimary Language: ts",
    [CONTEXT_ARTIFACT_KINDS.filesNdjson]: '{"path":"src/a.ts"}\n',
  };

  beforeEach(async () => {
    repoDir = await fs.mkdtemp(path.join(os.tmpdir(), "ctx-hydrate-"));
    (cfg as any).maArtifactsMode = "api";
    fetchProjectArtifactsMock.mockReset();
    fetchProjectArtifactsMock.mockImplementation(async ({ kind }: any) => {
      const content = artifactByKind[kind];
      return content !== undefined ? [{ kind, content, byte_size: 1 }] : [];
    });
  });

  afterEach(async () => {
    (cfg as any).maArtifactsMode = originalMode;
    await fs.rm(repoDir, { recursive: true, force: true });
  });

  it("hydrates missing context artifacts and restores snapshot mtime", async () => {
    const hydrated = await hydrateContextArtifacts(repoDir, 1);
    expect(hydrated).toBe(true);

    const state = await loadExistingSnapshot(repoDir);
    expect(state.exists).toBe(true);

    const stat = await fs.stat(state.snapshotPath);
    expect(stat.mtime.getTime()).toBe(snapshotTimestamp);
  });

  it("does nothing when local artifacts already exist", async () => {
    await hydrateContextArtifacts(repoDir, 1);
    fetchProjectArtifactsMock.mockClear();

    const hydrated = await hydrateContextArtifacts(repoDir, 1);
    expect(hydrated).toBe(false);
    expect(fetchProjectArtifactsMock).not.toHaveBeenCalled();
  });

  it("does nothing when any artifact is missing from the API", async () => {
    fetchProjectArtifactsMock.mockImplementation(async ({ kind }: any) =>
      kind === CONTEXT_ARTIFACT_KINDS.summary
        ? []
        : [{ kind, content: artifactByKind[kind] }],
    );

    const hydrated = await hydrateContextArtifacts(repoDir, 1);
    expect(hydrated).toBe(false);
    expect((await loadExistingSnapshot(repoDir)).exists).toBe(false);
  });

  it("does nothing in git mode or without a project id", async () => {
    (cfg as any).maArtifactsMode = "git";
    expect(await hydrateContextArtifacts(repoDir, 1)).toBe(false);

    (cfg as any).maArtifactsMode = "api";
    expect(await hydrateContextArtifacts(repoDir, null)).toBe(false);
    expect(fetchProjectArtifactsMock).not.toHaveBeenCalled();
  });

  it("rejects a snapshot that is not valid JSON", async () => {
    fetchProjectArtifactsMock.mockImplementation(async ({ kind }: any) => [
      {
        kind,
        content:
          kind === CONTEXT_ARTIFACT_KINDS.snapshot
            ? "not json"
            : artifactByKind[kind],
      },
    ]);

    const hydrated = await hydrateContextArtifacts(repoDir, 1);
    expect(hydrated).toBe(false);
  });
});
