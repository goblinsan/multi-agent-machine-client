import { describe, it, expect, vi, beforeEach } from "vitest";
import { ensureAutoCommitAfterStep } from "../src/workflows/helpers/autoCommit";

const describeWorkingTreeMock = vi.hoisted(() => vi.fn());
const commitAndPushPathsMock = vi.hoisted(() => vi.fn());

vi.mock("../src/gitUtils.js", () => ({
  describeWorkingTree: describeWorkingTreeMock,
  commitAndPushPaths: commitAndPushPathsMock,
}));

vi.mock("../src/workflows/helpers/workflowAbort.js", () => ({
  abortWorkflowDueToPushFailure: vi.fn(),
}));

describe("ensureAutoCommitAfterStep artifact exclusion", () => {
  let context: any;
  const step: any = { config: { name: "context_rescan", config: {} } };

  beforeEach(() => {
    describeWorkingTreeMock.mockReset();
    commitAndPushPathsMock.mockReset();
    commitAndPushPathsMock.mockResolvedValue({
      branch: "main",
      committed: true,
      pushed: true,
    });
    context = {
      repoRoot: "/repo",
      branch: "main",
      getVariable: vi.fn(),
      setVariable: vi.fn(),
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    };
  });

  it("never sweeps .ma working files into auto-commits", async () => {
    describeWorkingTreeMock.mockResolvedValue({
      dirty: true,
      entries: [
        { path: ".ma/context/snapshot.json" },
        { path: ".ma/base_qa_cache_abc.json" },
        { path: "src/index.ts" },
      ],
    });

    await ensureAutoCommitAfterStep({ context, step });

    expect(commitAndPushPathsMock).toHaveBeenCalledTimes(1);
    expect(commitAndPushPathsMock.mock.calls[0][0].paths).toEqual([
      "src/index.ts",
    ]);
  });

  it("skips the commit entirely when only .ma files changed", async () => {
    describeWorkingTreeMock.mockResolvedValue({
      dirty: true,
      entries: [
        { path: ".ma/context/snapshot.json" },
        { path: ".ma/tasks/10/03-plan-final.md" },
      ],
    });

    await ensureAutoCommitAfterStep({ context, step });

    expect(commitAndPushPathsMock).not.toHaveBeenCalled();
  });
});
