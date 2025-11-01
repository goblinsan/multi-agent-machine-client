import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { PlanningLoopStep } from "../src/workflows/steps/PlanningLoopStep.js";
import { WorkflowContext } from "../src/workflows/engine/WorkflowContext.js";
import { logger } from "../src/logger.js";

const personaMocks = vi.hoisted(() => ({
  sendPersonaRequestMock: vi.fn(),
  waitForPersonaCompletionMock: vi.fn(),
}));

vi.mock("../src/redisClient.js", () => ({
  makeRedis: vi.fn().mockResolvedValue({
    xAdd: vi.fn().mockResolvedValue("stream-entry-id"),
    quit: vi.fn().mockResolvedValue(undefined),
    disconnect: vi.fn().mockResolvedValue(undefined),
  }),
}));

vi.mock("../src/agents/persona.js", async () => {
  const actual = await vi.importActual<
    typeof import("../src/agents/persona.js")
  >("../src/agents/persona.js");
  return {
    ...actual,
    sendPersonaRequest: personaMocks.sendPersonaRequestMock,
    waitForPersonaCompletion: personaMocks.waitForPersonaCompletionMock,
  };
});

describe("PlanningLoopStep logging", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("logs plan output and evaluation results for each iteration", async () => {
    const mockWorkflowConfig = {
      name: "test-workflow",
      version: "1.0.0",
      steps: [],
    };

    const context = new WorkflowContext(
      "wf-log-1",
      "proj-log",
      "/tmp/repo",
      "main",
      mockWorkflowConfig as any,
    );
    context.setVariable("task", {
      id: "task-1",
      type: "feature",
      data: { description: "Test task" },
    });

    const planPayload = {
      plan: "Implement feature X with steps A and B.",
      breakdown: [
        {
          step: 1,
          title: "Setup",
          description: "Prepare environment",
          dependencies: [],
          estimatedDuration: "1h",
          complexity: "low",
        },
        {
          step: 2,
          title: "Implement",
          description: "Build feature",
          dependencies: [1],
          estimatedDuration: "2h",
          complexity: "medium",
        },
      ],
      risks: [
        {
          description: "Potential API change",
          severity: "medium",
          mitigation: "Coordinate with backend team",
        },
      ],
      metadata: {
        planVersion: "v1",
        approved: true,
      },
    };

    const evaluationPayload = {
      status: "approved",
      summary: "Looks great",
      notes: "Proceed with implementation",
    };

    personaMocks.sendPersonaRequestMock
      .mockResolvedValueOnce("corr-plan")
      .mockResolvedValueOnce("corr-eval");

    personaMocks.waitForPersonaCompletionMock
      .mockResolvedValueOnce({
        id: "plan-event-1",
        status: "success",
        fields: {
          status: "done",
          corr_id: "corr-plan",
          result: JSON.stringify(planPayload),
        },
      })
      .mockResolvedValueOnce({
        id: "eval-event-1",
        status: "success",
        fields: {
          status: "done",
          corr_id: "corr-eval",
          result: JSON.stringify(evaluationPayload),
        },
      });

    const stepConfig = {
      name: "planning_loop",
      type: "PlanningLoopStep",
      config: {
        maxIterations: 1,
        plannerPersona: "implementation-planner",
        evaluatorPersona: "plan-evaluator",
        planStep: "2-plan",
        evaluateStep: "2.5-evaluate-plan",
        payload: {},
      },
    } as any;

    const step = new PlanningLoopStep(stepConfig);

    const infoSpy = vi.spyOn(logger, "info");

    const result = await step.execute(context);

    expect(result.status).toBe("success");

    const planLog = infoSpy.mock.calls.find(
      ([message]) => message === "Planning loop plan output",
    );
    expect(planLog).toBeDefined();
    expect(planLog?.[1]).toMatchObject({
      plan: expect.objectContaining({
        planPreview: expect.stringContaining("Implement feature X"),
        breakdownSteps: 2,
        riskCount: 1,
      }),
    });

    const evaluationLog = infoSpy.mock.calls.find(
      ([message]) => message === "Planning loop evaluation result",
    );
    expect(evaluationLog).toBeDefined();
    expect(evaluationLog?.[1]).toMatchObject({
      evaluation: expect.objectContaining({
        normalizedStatus: "pass",
        statusDetails: expect.stringContaining("approved"),
        payloadPreview: expect.stringContaining("Looks great"),
      }),
    });
  });
});
