import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { StepExecutor } from "../src/workflows/engine/StepExecutor.js";
import { WorkflowStep, type StepResult } from "../src/workflows/engine/WorkflowStep.js";
import { WorkflowContext } from "../src/workflows/engine/WorkflowContext.js";
import * as gitUtils from "../src/gitUtils.js";
import * as workflowAbort from "../src/workflows/helpers/workflowAbort.js";

type TestWorkflowDef = {
  name: string;
  description: string;
  version: string;
  trigger: { condition: string };
  context: Record<string, unknown>;
  steps: any[];
  timeouts?: Record<string, number>;
};

class MutatingStep extends WorkflowStep {
  async execute(): Promise<StepResult> {
    return { status: "success" };
  }
}

function createContext(repoRoot = "/tmp/repo") {
  const transportStub = {
    xRange: vi.fn().mockResolvedValue([]),
    xAck: vi.fn().mockResolvedValue(0),
    xDel: vi.fn().mockResolvedValue(0),
  };

  const workflowConfig = {
    name: "test",
    version: "1",
    steps: [],
  } as any;

  return new WorkflowContext(
    "wf-1",
    "proj-1",
    repoRoot,
    "main",
    workflowConfig,
    transportStub as any,
  );
}

describe("StepExecutor auto-commit integration", () => {
  const registry = new Map<string, new (...args: any[]) => WorkflowStep>();
  registry.set("MutatingStep", MutatingStep);
  const executor = new StepExecutor(registry);

  const workflowDef: TestWorkflowDef = {
    name: "wf",
    description: "",
    version: "1",
    trigger: { condition: "" },
    context: {},
    steps: [],
    timeouts: {},
  };

  beforeEach(() => {
    vi.restoreAllMocks();
  });

  afterEach(() => {
    vi.resetModules();
  });

  it("commits dirty working tree after successful step", async () => {
    const describeSpy = vi.spyOn(gitUtils, "describeWorkingTree").mockResolvedValue({
      dirty: true,
      entries: [
        { status: "??", path: "foo.txt" },
        { status: " M", path: "src/app.ts" },
      ],
      summary: { staged: 0, untracked: 1, unstaged: 1, total: 2 },
      porcelain: [],
    } as any);

    const commitSpy = vi
      .spyOn(gitUtils, "commitAndPushPaths")
      .mockResolvedValue({ committed: true, pushed: true, branch: "main" });

    const stepDef = {
      name: "auto-step",
      type: "MutatingStep",
      description: "",
      config: {},
    };

    const success = await executor.executeStep(
      stepDef as any,
      createContext(),
      workflowDef as any,
    );

    expect(success).toBe(true);
    expect(describeSpy).toHaveBeenCalledTimes(1);
    expect(commitSpy).toHaveBeenCalledWith({
      repoRoot: "/tmp/repo",
      branch: "main",
      message: "auto-commit auto-step",
      paths: ["foo.txt", "src/app.ts"],
    });
  });

  it("skips auto-commit when disabled", async () => {
    const describeSpy = vi.spyOn(gitUtils, "describeWorkingTree");
    const commitSpy = vi.spyOn(gitUtils, "commitAndPushPaths");

    const stepDef = {
      name: "manual-step",
      type: "MutatingStep",
      description: "",
      config: {
        autoCommit: false,
      },
    };

    const success = await executor.executeStep(
      stepDef as any,
      createContext(),
      workflowDef as any,
    );

    expect(success).toBe(true);
    expect(describeSpy).not.toHaveBeenCalled();
    expect(commitSpy).not.toHaveBeenCalled();
  });

  it("aborts workflow when auto-commit push fails", async () => {
    vi.spyOn(gitUtils, "describeWorkingTree").mockResolvedValue({
      dirty: true,
      entries: [{ status: " M", path: "src/index.ts" }],
      summary: { staged: 0, untracked: 0, unstaged: 1, total: 1 },
      porcelain: [],
    } as any);

    vi.spyOn(gitUtils, "commitAndPushPaths").mockResolvedValue({
      committed: true,
      pushed: false,
      branch: "main",
      reason: "push_failed",
    });

    const abortSpy = vi
      .spyOn(workflowAbort, "abortWorkflowDueToPushFailure")
      .mockResolvedValue();

    const stepDef = {
      name: "failing-step",
      type: "MutatingStep",
      description: "",
      config: {},
    };

    await expect(
      executor.executeStep(stepDef as any, createContext(), workflowDef as any),
    ).rejects.toThrow(/Auto-commit push failed/);

    expect(abortSpy).toHaveBeenCalledTimes(1);
  });
});
