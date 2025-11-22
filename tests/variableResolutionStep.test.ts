import { describe, it, expect, beforeEach, vi } from "vitest";
import { WorkflowContext } from "../src/workflows/engine/WorkflowContext.js";
import { VariableResolutionStep } from "../src/workflows/steps/VariableResolutionStep.js";
import { makeTempRepo } from "./makeTempRepo.js";

vi.mock("../src/logger.js", () => ({
  logger: {
    info: vi.fn(),
    debug: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

describe("VariableResolutionStep expressions", () => {
  let context: WorkflowContext;
  let repoRoot: string;
  let mockTransport: any;

  beforeEach(async () => {
    repoRoot = await makeTempRepo();
    mockTransport = {};

    const mockConfig = {
      name: "test-workflow",
      version: "1.0.0",
      steps: [],
    };

    context = new WorkflowContext(
      "wf-variable-001",
      "proj-1",
      repoRoot,
      "main",
      mockConfig,
      mockTransport,
      {
        taskId: 123,
      },
    );

    context.setVariable("task", {
      blocked_attempt_count: 2,
    });
  });

  it("computes arithmetic expressions and Date.now values", async () => {
    const fakeNow = Date.UTC(2025, 0, 15, 12, 34, 56);
    const dateSpy = vi.spyOn(Date, "now").mockReturnValue(fakeNow);

    const step = new VariableResolutionStep({
      name: "increment_attempt_counter",
      type: "VariableResolutionStep",
      config: {
        variables: {
          blocked_attempt_count:
            "${(blocked_attempt_count || task.blocked_attempt_count || 0) + 1}",
          last_unblock_attempt: "${Date.now()}",
        },
      },
    });

    const result = await step.execute(context);

    expect(result.status).toBe("success");
    expect(context.getVariable("blocked_attempt_count")).toBe(3);
    expect(context.getVariable("last_unblock_attempt")).toBe(fakeNow);
    expect(result.data?.variables.blocked_attempt_count).toBe(3);
    expect(result.data?.variables.last_unblock_attempt).toBe(fakeNow);

    dateSpy.mockRestore();
  });

  it("prefers existing variables before task properties", async () => {
    context.setVariable("blocked_attempt_count", 5);

    const step = new VariableResolutionStep({
      name: "increment_attempt_counter",
      type: "VariableResolutionStep",
      config: {
        variables: {
          blocked_attempt_count:
            "${(blocked_attempt_count || task.blocked_attempt_count || 0) + 1}",
        },
      },
    });

    const result = await step.execute(context);

    expect(result.status).toBe("success");
    expect(context.getVariable("blocked_attempt_count")).toBe(6);
    expect(result.data?.variables.blocked_attempt_count).toBe(6);
  });
});
