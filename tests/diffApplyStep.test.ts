import { describe, it, expect, vi, beforeEach } from "vitest";
import { DiffApplyStep } from "../src/workflows/steps/DiffApplyStep.js";
import { WorkflowContext } from "../src/workflows/engine/WorkflowContext.js";
import { logger } from "../src/logger.js";

vi.mock("../src/fileops.js", () => ({
  applyEditOps: vi.fn(),
}));

vi.mock("../src/agents/parsers/DiffParser.js", () => ({
  DiffParser: {
    parsePersonaResponse: vi.fn(),
  },
}));

vi.mock("../src/logger.js", () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
}));

describe("DiffApplyStep Critical Error Handling", () => {
  let diffApplyStep: DiffApplyStep;
  let mockContext: WorkflowContext;

  beforeEach(() => {
    vi.clearAllMocks();

    diffApplyStep = new DiffApplyStep({
      name: "test-diff-apply",
      type: "DiffApplyStep",
      config: {
        source_output: "test_output",
      },
    });

    mockContext = {
      getStepOutput: vi.fn(),
      getVariable: vi.fn(),
      setVariable: vi.fn(),
      getAllStepOutputs: vi.fn(() => ({})),
      getCurrentBranch: vi.fn(() => "test-branch"),
      branch: "test-branch",
      repoRoot: "/test/repo",
      logger: logger,
    } as any;
  });

  it("should return failure when no diff operations found", async () => {
    (mockContext.getStepOutput as any).mockReturnValue("some diff content");

    const { DiffParser } = await import("../src/agents/parsers/DiffParser.js");
    (DiffParser.parsePersonaResponse as any).mockReturnValue({
      success: true,
      editSpec: { ops: [] },
      diffBlocks: [],
      errors: [],
      warnings: [],
    });

    const result = await diffApplyStep.execute(mockContext);

    expect(result.status).toBe("failure");
    expect(result.error?.message).toBe(
      "Coordinator-critical: Implementation returned no diff operations to apply. Aborting.",
    );

    expect(logger.error).toHaveBeenCalledWith(
      "Critical failure: No edit operations found in diff",
      expect.objectContaining({
        stepName: "test-diff-apply",
      }),
    );
  });

  it("should return failure when no file changes after applying diffs", async () => {
    (mockContext.getStepOutput as any).mockReturnValue("some diff content");

    const { DiffParser } = await import("../src/agents/parsers/DiffParser.js");
    (DiffParser.parsePersonaResponse as any).mockReturnValue({
      success: true,
      editSpec: { ops: [{ path: "test.ts", operation: "edit" }] },
      diffBlocks: [],
      errors: [],
      warnings: [],
    });

    const { applyEditOps } = await import("../src/fileops.js");
    (applyEditOps as any).mockResolvedValue({
      changed: [],
      branch: "test-branch",
      sha: "test-sha",
    });

    const result = await diffApplyStep.execute(mockContext);

    expect(result.status).toBe("failure");
    expect(result.error?.message).toBe(
      "Coordinator-critical: Implementation edits produced no file changes. Aborting.",
    );

    expect(logger.error).toHaveBeenCalledWith(
      "Critical failure: No file changes after applying diffs",
      expect.objectContaining({
        stepName: "test-diff-apply",
      }),
    );
  });

  it("should return failure when no commit SHA is returned", async () => {
    (mockContext.getStepOutput as any).mockReturnValue("some diff content");

    const { DiffParser } = await import("../src/agents/parsers/DiffParser.js");
    (DiffParser.parsePersonaResponse as any).mockReturnValue({
      success: true,
      editSpec: { ops: [{ path: "test.ts", operation: "edit" }] },
      diffBlocks: [],
      errors: [],
      warnings: [],
    });

    const { applyEditOps } = await import("../src/fileops.js");
    (applyEditOps as any).mockResolvedValue({
      changed: ["test.ts"],
      branch: "test-branch",
      sha: "",
    });

    const result = await diffApplyStep.execute(mockContext);

    expect(result.status).toBe("failure");
    expect(result.error?.message).toBe(
      "Coordinator-critical: Implementation changes were not committed to repository. Aborting.",
    );

    expect(logger.error).toHaveBeenCalledWith(
      "Critical failure: No commit SHA after applying changes",
      expect.objectContaining({
        stepName: "test-diff-apply",
      }),
    );
  });

  it("should succeed when valid diff operations are applied and committed", async () => {
    (mockContext.getStepOutput as any).mockReturnValue("some diff content");

    const { DiffParser } = await import("../src/agents/parsers/DiffParser.js");
    (DiffParser.parsePersonaResponse as any).mockReturnValue({
      success: true,
      editSpec: { ops: [{ path: "test.ts", operation: "edit" }] },
      diffBlocks: [],
      errors: [],
      warnings: [],
    });

    const { applyEditOps } = await import("../src/fileops.js");
    (applyEditOps as any).mockResolvedValue({
      changed: ["test.ts"],
      branch: "test-branch",
      sha: "commit-sha-123",
    });

    const result = await diffApplyStep.execute(mockContext);

    expect(result.status).toBe("success");
    expect(result.outputs).toEqual({
      applied_files: ["test.ts"],
      commit_sha: "commit-sha-123",
      operations_count: 1,
      branch: "test-branch",
    });

    expect(logger.info).toHaveBeenCalledWith(
      "Diff application completed",
      expect.objectContaining({
        stepName: "test-diff-apply",
        filesChanged: 1,
        commitSha: "commit-sha-123",
      }),
    );
  });

  it("should throw when allowed_extensions override is provided", async () => {
    diffApplyStep = new DiffApplyStep({
      name: "test-diff-apply",
      type: "DiffApplyStep",
      config: {
        source_output: "test_output",
        allowed_extensions: [".ts"],
      },
    });

    (mockContext.getStepOutput as any).mockReturnValue("some diff content");

    const { DiffParser } = await import("../src/agents/parsers/DiffParser.js");
    (DiffParser.parsePersonaResponse as any).mockReturnValue({
      success: true,
      editSpec: { ops: [{ path: "test.ts", operation: "edit" }] },
      diffBlocks: [],
      errors: [],
      warnings: [],
    });

    await expect(diffApplyStep.execute(mockContext)).rejects.toThrow(
      "allowed_extensions is no longer supported",
    );

    const { applyEditOps } = await import("../src/fileops.js");
    expect(applyEditOps).not.toHaveBeenCalled();
  });

  it("should pass blocked_extensions override to applyEditOps", async () => {
    diffApplyStep = new DiffApplyStep({
      name: "test-diff-apply",
      type: "DiffApplyStep",
      config: {
        source_output: "test_output",
        blocked_extensions: [".env"],
      },
    });

    (mockContext.getStepOutput as any).mockReturnValue("some diff content");

    const { DiffParser } = await import("../src/agents/parsers/DiffParser.js");
    (DiffParser.parsePersonaResponse as any).mockReturnValue({
      success: true,
      editSpec: { ops: [{ path: "test.ts", operation: "edit" }] },
      diffBlocks: [],
      errors: [],
      warnings: [],
    });

    const { applyEditOps } = await import("../src/fileops.js");
    (applyEditOps as any).mockResolvedValue({
      changed: ["test.ts"],
      branch: "test-branch",
      sha: "commit-sha-123",
    });

    const result = await diffApplyStep.execute(mockContext);

    expect(result.status).toBe("success");
    const applyArgs = (applyEditOps as any).mock.calls.at(-1)[1];
    expect(applyArgs.blockedExts).toEqual([".env"]);
  });
});
