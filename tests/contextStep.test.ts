import { describe, it, expect, vi, beforeEach } from "vitest";
import { ContextStep } from "../src/workflows/steps/ContextStep.js";
import { WorkflowContext } from "../src/workflows/engine/WorkflowContext.js";
import { logger } from "../src/logger.js";
import fs from "fs/promises";
import _path from "path";

vi.mock("fs/promises", () => ({
  default: {
    access: vi.fn(),
    stat: vi.fn(),
    readFile: vi.fn(),
    writeFile: vi.fn(),
    mkdir: vi.fn(),
    utimes: vi.fn(),
  },
}));
vi.mock("../src/scanRepo.js", () => ({
  scanRepo: vi.fn(),
}));

vi.mock("../src/logger.js", () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
}));

const runGitMock = vi.hoisted(() => vi.fn());

vi.mock("../src/gitUtils.js", () => ({
  runGit: runGitMock,
}));

const SNAPSHOT_PATH = _path.join(
  "/test/repo",
  ".ma",
  "context",
  "snapshot.json",
);

function snapshotJson(overrides: Record<string, unknown> = {}) {
  return JSON.stringify({
    timestamp: Date.now() - 60000,
    repoPath: "/test/repo",
    files: [
      {
        path: "src/test.ts",
        bytes: 1000,
        lines: 50,
        mtime: Date.now() - 120000,
      },
    ],
    totals: { files: 1, bytes: 1000 },
    ...overrides,
  });
}

describe("ContextStep Change Detection", () => {
  let contextStep: ContextStep;
  let mockContext: WorkflowContext;

  beforeEach(() => {
    vi.clearAllMocks();
    runGitMock.mockReset();
    runGitMock.mockImplementation(async (args: string[]) => {
      if (args[0] === "rev-parse") return { stdout: "abc123\n" };
      return { stdout: "" };
    });

    (fs.mkdir as any).mockReset();
    (fs.mkdir as any).mockResolvedValue(undefined);
    (fs.writeFile as any).mockReset();
    (fs.writeFile as any).mockResolvedValue(undefined);
    (fs.utimes as any).mockReset();
    (fs.utimes as any).mockResolvedValue(undefined);
    (fs.access as any).mockReset();
    (fs.access as any).mockResolvedValue(undefined);
    (fs.readFile as any).mockReset();
    (fs.readFile as any).mockResolvedValue("{}");
    (fs.stat as any).mockReset();
    (fs.stat as any).mockResolvedValue({
      isDirectory: () => true,
      mtime: new Date(Date.now() - 60000),
    });

    contextStep = new ContextStep({
      name: "test-context",
      type: "ContextStep",
      config: {
        repoPath: "/test/repo",
        includePatterns: ["**/*.ts"],
        excludePatterns: ["node_modules/**"],
      },
    });

    mockContext = {
      setVariable: vi.fn(),
      getVariable: vi.fn(),
      logger: logger,
      repoRoot: "/test/repo",
      workflowId: "wf-123",
      branch: "main",
      projectId: "proj-456",
    } as any;
  });

  it("performs a full scan when no previous snapshot exists", async () => {
    (fs.access as any).mockRejectedValue(new Error("File not found"));

    const { scanRepo } = await import("../src/scanRepo.js");
    (scanRepo as any).mockResolvedValue([
      { path: "src/test.ts", bytes: 1000, lines: 50, mtime: Date.now() },
    ]);

    const result = await contextStep.execute(mockContext);

    expect(result.status).toBe("success");
    expect(result.outputs?.reused_existing).toBe(false);
    expect(result.outputs?.scan_mode).toBe("full");
    expect(result.outputs?.analysis_required).toBe(true);
    expect(fs.writeFile).toHaveBeenCalledWith(
      _path.join("/test/repo", ".ma", "context", "files.ndjson"),
      expect.any(String),
      "utf-8",
    );
  });

  it("performs a full scan when the snapshot is unparseable", async () => {
    (fs.readFile as any).mockResolvedValue("not json");

    const { scanRepo } = await import("../src/scanRepo.js");
    (scanRepo as any).mockResolvedValue([
      { path: "src/test.ts", bytes: 1000, lines: 50, mtime: Date.now() },
    ]);

    const result = await contextStep.execute(mockContext);

    expect(result.status).toBe("success");
    expect(result.outputs?.scan_mode).toBe("full");
  });

  it("scans incrementally when the mtime probe detects changes", async () => {
    const newerMtime = Date.now() - 1000;

    (fs.readFile as any).mockImplementation(async (p: string) => {
      if (String(p) === SNAPSHOT_PATH) return snapshotJson();
      return "line1\nline2\n";
    });

    const { scanRepo } = await import("../src/scanRepo.js");
    (scanRepo as any).mockResolvedValue([
      { path: "src/test.ts", bytes: 1000, mtime: newerMtime },
    ]);

    const result = await contextStep.execute(mockContext);

    expect(result.status).toBe("success");
    expect(result.outputs?.scan_mode).toBe("incremental");
    expect(result.outputs?.reused_existing).toBe(false);
    expect(result.outputs?.delta_modified).toBe(1);
    expect(result.outputs?.files_read).toBe(1);
    expect(result.outputs?.analysis_required).toBe(true);
    expect(result.outputs?.analysis_decision).toContain(
      "no cached context analysis",
    );
  });

  it("reuses context via the git delta when nothing changed", async () => {
    (fs.readFile as any).mockImplementation(async (p: string) => {
      if (String(p) === SNAPSHOT_PATH) {
        return snapshotJson({ headSha: "abc123" });
      }
      return "{}";
    });

    const { scanRepo } = await import("../src/scanRepo.js");
    (scanRepo as any).mockResolvedValue([]);

    const result = await contextStep.execute(mockContext);

    expect(result.status).toBe("success");
    expect(result.outputs?.scan_mode).toBe("reused");
    expect(result.outputs?.reused_existing).toBe(true);
    expect(result.outputs?.analysis_required).toBe(false);
    expect(runGitMock).toHaveBeenCalledWith(
      ["diff", "--name-only", "abc123", "HEAD"],
      expect.objectContaining({ cwd: "/test/repo" }),
    );
    expect(scanRepo).not.toHaveBeenCalled();
  });

  it("scans incrementally when the git delta reports changes", async () => {
    runGitMock.mockImplementation(async (args: string[]) => {
      if (args[0] === "rev-parse") return { stdout: "def456\n" };
      if (args[0] === "diff") return { stdout: "src/test.ts\n" };
      return { stdout: "" };
    });

    (fs.readFile as any).mockImplementation(async (p: string) => {
      if (String(p) === SNAPSHOT_PATH) {
        return snapshotJson({ headSha: "abc123" });
      }
      return "line1\nline2\nline3\n";
    });

    const { scanRepo } = await import("../src/scanRepo.js");
    (scanRepo as any).mockResolvedValue([
      { path: "src/test.ts", bytes: 1200, mtime: Date.now() },
    ]);

    const result = await contextStep.execute(mockContext);

    expect(result.status).toBe("success");
    expect(result.outputs?.scan_mode).toBe("incremental");
    expect(result.outputs?.delta_modified).toBe(1);
  });

  it("reuses context when the mtime probe finds no changes", async () => {
    const olderFileTime = Date.now() - 120000;

    (fs.readFile as any).mockImplementation(async (p: string) => {
      if (String(p) === SNAPSHOT_PATH) return snapshotJson();
      return "{}";
    });

    const { scanRepo } = await import("../src/scanRepo.js");
    (scanRepo as any).mockResolvedValue([
      { path: "src/test.ts", bytes: 1000, lines: 50, mtime: olderFileTime },
    ]);

    const result = await contextStep.execute(mockContext);

    expect(result.status).toBe("success");
    expect(result.outputs?.reused_existing).toBe(true);
    expect(result.outputs?.scan_mode).toBe("reused");
    expect(logger.info).toHaveBeenCalledWith(
      "Context gathering completed using existing data",
      expect.objectContaining({
        fileCount: 1,
        totalBytes: 1000,
      }),
    );
  });

  it("forces a full rescan when forceRescan is true", async () => {
    const forceRescanStep = new ContextStep({
      name: "test-context-force",
      type: "ContextStep",
      config: {
        repoPath: "/test/repo",
        forceRescan: true,
      },
    });

    const { scanRepo } = await import("../src/scanRepo.js");
    (scanRepo as any).mockResolvedValue([
      { path: "src/test.ts", bytes: 1000, lines: 50, mtime: Date.now() },
    ]);

    const result = await forceRescanStep.execute(mockContext);

    expect(result.status).toBe("success");
    expect(result.outputs?.reused_existing).toBe(false);
    expect(result.outputs?.scan_mode).toBe("full");
    expect(logger.info).toHaveBeenCalledWith(
      "Performing new repository scan",
      expect.objectContaining({
        reason: "forced rescan",
      }),
    );
  });

  it("falls back to incremental scan when the freshness probe errors", async () => {
    (fs.readFile as any).mockImplementation(async (p: string) => {
      if (String(p) === SNAPSHOT_PATH) return snapshotJson();
      return "line1\n";
    });
    (fs.stat as any)
      .mockResolvedValueOnce({
        isDirectory: () => true,
        mtime: new Date(),
      })
      .mockRejectedValueOnce(new Error("Permission denied"));

    const { scanRepo } = await import("../src/scanRepo.js");
    (scanRepo as any).mockResolvedValue([
      { path: "src/test.ts", bytes: 1000, mtime: Date.now() },
    ]);

    const result = await contextStep.execute(mockContext);

    expect(result.status).toBe("success");
    expect(result.outputs?.scan_mode).toBe("incremental");
    expect(logger.warn).toHaveBeenCalledWith(
      "Error checking context freshness, will rescan",
      expect.objectContaining({
        error: "Error: Permission denied",
      }),
    );
  });
});
