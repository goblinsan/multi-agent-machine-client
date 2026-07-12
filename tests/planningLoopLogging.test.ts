import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { PlanningLoopStep } from "../src/workflows/steps/PlanningLoopStep.js";
import { WorkflowContext } from "../src/workflows/engine/WorkflowContext.js";
import { logger } from "../src/logger.js";
import { cfg } from "../src/config.js";
import fs from "fs/promises";
import os from "os";
import path from "path";

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
  const originalArtifactMode = cfg.maArtifactsMode;
  const originalPlanningMode = process.env.PLANNING_MODE;

  beforeEach(() => {
    (cfg as any).maArtifactsMode = originalArtifactMode;
    delete process.env.PLANNING_MODE;
    vi.clearAllMocks();
  });

  afterEach(() => {
    (cfg as any).maArtifactsMode = originalArtifactMode;
    if (originalPlanningMode === undefined) delete process.env.PLANNING_MODE;
    else process.env.PLANNING_MODE = originalPlanningMode;
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
      {} as any,
    );
    context.setVariable("task", {
      id: "task-1",
      type: "feature",
      data: { description: "Test task" },
    });

    const planPayload = {
      plan: [
        {
          goal: "Setup",
          key_files: ["src/setup.ts"],
          acceptance_criteria: ["Setup module exists"],
        },
        {
          goal: "Implement",
          key_files: ["src/feature.ts"],
          dependencies: ["Step 1"],
          acceptance_criteria: ["Feature module exists"],
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
        planningEvaluator: "on",
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
        planPreview: expect.stringContaining("src/feature.ts"),
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

  it("skips the LLM plan evaluator by default after deterministic validation passes", async () => {
    const context = new WorkflowContext(
      "wf-skip-eval",
      "proj-skip-eval",
      "/tmp/repo",
      "main",
      {
        name: "test-workflow",
        version: "1.0.0",
        steps: [],
      } as any,
      {} as any,
    );
    context.setVariable("SKIP_GIT_OPERATIONS", true);
    context.setVariable("task", {
      id: "task-skip-eval",
      title: "Implement deterministic-only planning",
      description: "Accept plans once deterministic validation passes.",
    });

    const planPayload = {
      plan: [
        {
          goal: "Update planner",
          key_files: ["src/workflows/steps/PlanningLoopStep.ts"],
        },
      ],
    };

    personaMocks.sendPersonaRequestMock.mockResolvedValueOnce("corr-plan-only");
    personaMocks.waitForPersonaCompletionMock.mockResolvedValueOnce({
      id: "plan-event-only",
      status: "success",
      fields: {
        status: "done",
        corr_id: "corr-plan-only",
        result: JSON.stringify(planPayload),
      },
    });

    const step = new PlanningLoopStep({
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
    } as any);

    const result = await step.execute(context);

    expect(result.status).toBe("success");
    expect(result.outputs?.evaluation_passed).toBe(true);
    expect(result.outputs?.evaluation_result).toBeNull();
    expect(personaMocks.sendPersonaRequestMock).toHaveBeenCalledTimes(1);
    expect(personaMocks.sendPersonaRequestMock.mock.calls[0][1]).toMatchObject({
      toPersona: "implementation-planner",
    });
    expect(
      personaMocks.sendPersonaRequestMock.mock.calls.some(
        ([, opts]) => opts.toPersona === "plan-evaluator",
      ),
    ).toBe(false);
  });

  it("bypasses LLM planning in deterministic mode and scopes benchmark task files", async () => {
    process.env.PLANNING_MODE = "deterministic";

    const context = new WorkflowContext(
      "wf-deterministic-planning",
      "proj-deterministic-planning",
      "/tmp/repo",
      "main",
      {
        name: "test-workflow",
        version: "1.0.0",
        steps: [],
      } as any,
      {} as any,
    );
    context.setVariable("SKIP_GIT_OPERATIONS", true);
    context.setVariable("task", {
      id: "task-reducer",
      title: "Implement the pure todo reducer in src/todoReducer.ts",
      description:
        "Create src/todoReducer.ts and src/todoReducer.test.ts. " +
        "The reducer should import Todo and TodoAction from ./types. " +
        "Only modify src/todoReducer.ts and src/todoReducer.test.ts.",
    });

    const step = new PlanningLoopStep({
      name: "planning_loop",
      type: "PlanningLoopStep",
      config: {
        maxIterations: 4,
        plannerPersona: "implementation-planner",
        evaluatorPersona: "plan-evaluator",
        planStep: "2-plan",
        evaluateStep: "2.5-evaluate-plan",
        payload: {},
      },
    } as any);

    const result = await step.execute(context);

    expect(result.status).toBe("success");
    expect(result.outputs?.iterations).toBe(0);
    expect(result.outputs?.plan_key_files).toEqual([
      "src/todoReducer.ts",
      "src/todoReducer.test.ts",
    ]);
    expect(context.getVariable("planning_loop_plan_files")).toEqual([
      "src/todoReducer.ts",
      "src/todoReducer.test.ts",
    ]);
    expect(personaMocks.sendPersonaRequestMock).not.toHaveBeenCalled();

    const planResult = result.outputs?.plan_result;
    const parsed = JSON.parse(planResult.fields.result);
    expect(parsed.plan).toHaveLength(2);
    expect(parsed.plan.map((entry: any) => entry.key_files)).toEqual([
      ["src/todoReducer.ts"],
      ["src/todoReducer.test.ts"],
    ]);
  });

  it("does not write .ma/tasks artifacts locally in API mode", async () => {
    (cfg as any).maArtifactsMode = "api";
    const repoRoot = await fs.mkdtemp(path.join(os.tmpdir(), "planning-api-"));
    const context = new WorkflowContext(
      "wf-api-artifacts",
      "proj-log",
      repoRoot,
      "main",
      {
        name: "test-workflow",
        version: "1.0.0",
        steps: [],
      } as any,
      {} as any,
    );
    context.setVariable("task", {
      id: "task-api",
      type: "feature",
      data: { description: "Test task" },
    });

    personaMocks.sendPersonaRequestMock
      .mockResolvedValueOnce("corr-plan-api")
      .mockResolvedValueOnce("corr-eval-api");
    personaMocks.waitForPersonaCompletionMock
      .mockResolvedValueOnce({
        id: "plan-event-api",
        status: "success",
        fields: {
          status: "done",
          corr_id: "corr-plan-api",
          result: JSON.stringify({
            plan: [
              {
                goal: "Implement API artifact mode",
                key_files: ["src/api.ts"],
              },
            ],
          }),
        },
      })
      .mockResolvedValueOnce({
        id: "eval-event-api",
        status: "success",
        fields: {
          status: "done",
          corr_id: "corr-eval-api",
          result: JSON.stringify({ status: "pass" }),
        },
      });

    const step = new PlanningLoopStep({
      name: "planning_loop",
      type: "PlanningLoopStep",
      config: {
        maxIterations: 1,
        plannerPersona: "implementation-planner",
        evaluatorPersona: "plan-evaluator",
        planningEvaluator: "on",
        planStep: "2-plan",
        evaluateStep: "2.5-evaluate-plan",
        payload: {},
      },
    } as any);

    const result = await step.execute(context);

    expect(result.status).toBe("success");
    await expect(
      fs.access(path.join(repoRoot, ".ma/tasks/task-api")),
    ).rejects.toThrow();
  });

  it("exposes plan_key_files output and stores plan files in context", async () => {
    const mockWorkflowConfig = {
      name: "test-workflow",
      version: "1.0.0",
      steps: [],
    };

    const context = new WorkflowContext(
      "wf-plan-files",
      "proj-plan-files",
      "/tmp/repo",
      "main",
      mockWorkflowConfig as any,
      {} as any,
    );
    context.setVariable("task", {
      id: "task-plan-files",
      type: "feature",
      data: { description: "Test plan files" },
    });

    const structuredPlan = {
      plan: [
        {
          goal: "Create regression test",
          key_files: [
            "tests/regression/gap.test.ts",
            "package.json",
          ],
        },
      ],
    };

    const planPayload = {
      output: JSON.stringify(structuredPlan),
    };

    const evaluationPayload = {
      status: "pass",
    };

    personaMocks.sendPersonaRequestMock
      .mockResolvedValueOnce("corr-plan-files")
      .mockResolvedValueOnce("corr-eval-files");

    personaMocks.waitForPersonaCompletionMock
      .mockResolvedValueOnce({
        id: "plan-event-files",
        status: "success",
        fields: {
          status: "done",
          corr_id: "corr-plan-files",
          result: JSON.stringify(planPayload),
        },
      })
      .mockResolvedValueOnce({
        id: "eval-event-files",
        status: "success",
        fields: {
          status: "done",
          corr_id: "corr-eval-files",
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
        planningEvaluator: "on",
        planStep: "2-plan",
        evaluateStep: "2.5-evaluate-plan",
        payload: {},
      },
    } as any;

    const step = new PlanningLoopStep(stepConfig);

    const result = await step.execute(context);

    expect(result.outputs?.plan_key_files).toEqual([
      "tests/regression/gap.test.ts",
      "package.json",
    ]);
    expect(context.getVariable("planning_loop_plan_files")).toEqual([
      "tests/regression/gap.test.ts",
      "package.json",
    ]);
    expect(context.getVariable("plan_required_files")).toEqual([
      "tests/regression/gap.test.ts",
      "package.json",
    ]);
  });

  it("treats unsupported evaluator rejection as advisory when deterministic gates pass", async () => {
    const mockWorkflowConfig = {
      name: "test-workflow",
      version: "1.0.0",
      steps: [],
    };

    const context = new WorkflowContext(
      "wf-advisory-eval",
      "proj-advisory-eval",
      "/tmp/repo",
      "main",
      mockWorkflowConfig as any,
      {} as any,
    );
    context.setVariable("SKIP_GIT_OPERATIONS", true);
    context.setVariable("task", {
      id: "task-advisory-eval",
      title: "Events API",
      description: "Create an events API route.",
    });
    context.setVariable("repoScan", [
      { path: "src/types/logEvent.ts" },
      { path: "src/utils/index.ts" },
    ]);
    context.setVariable("context_insights", {
      primaryLanguage: "typescript",
      secondaryLanguages: [],
    });

    const structuredPlan = {
      plan: [
        {
          goal: "Define event query types",
          key_files: ["src/types/logEvent.ts"],
        },
        {
          goal: "Create events route",
          key_files: ["src/routes/events.ts"],
          dependencies: ["Step 1"],
        },
      ],
    };

    personaMocks.sendPersonaRequestMock
      .mockResolvedValueOnce("corr-plan-advisory")
      .mockResolvedValueOnce("corr-eval-advisory");

    personaMocks.waitForPersonaCompletionMock
      .mockResolvedValueOnce({
        id: "plan-event-advisory",
        status: "success",
        fields: {
          status: "done",
          corr_id: "corr-plan-advisory",
          result: JSON.stringify({ output: JSON.stringify(structuredPlan) }),
        },
      })
      .mockResolvedValueOnce({
        id: "eval-event-advisory",
        status: "success",
        fields: {
          status: "done",
          corr_id: "corr-eval-advisory",
          result: JSON.stringify({
            status: "fail",
            reason:
              "Plan references src/routes/events.ts but actual repository uses src/routes/events/index.ts",
          }),
        },
      });

    const step = new PlanningLoopStep({
      name: "planning_loop",
      type: "PlanningLoopStep",
      config: {
        maxIterations: 1,
        plannerPersona: "implementation-planner",
        evaluatorPersona: "plan-evaluator",
        planningEvaluator: "on",
        planStep: "2-plan",
        evaluateStep: "2.5-evaluate-plan",
        payload: {},
      },
    } as any);

    const result = await step.execute(context);

    expect(result.status).toBe("success");
    expect(result.outputs?.evaluation_passed).toBe(true);
    expect(result.outputs?.plan_key_files).toEqual([
      "src/types/logEvent.ts",
      "src/routes/events.ts",
    ]);
  });

  it("uses persona-configured timeouts when step timeout is not provided", async () => {
    const mockWorkflowConfig = {
      name: "test-workflow",
      version: "1.0.0",
      steps: [],
    };

    const context = new WorkflowContext(
      "wf-timeouts",
      "proj-timeouts",
      "/tmp/repo",
      "main",
      mockWorkflowConfig as any,
      {} as any,
    );
    context.setVariable("task", {
      id: "task-timeout",
      type: "feature",
      data: { description: "Timeout verification" },
    });
    context.setVariable("SKIP_GIT_OPERATIONS", true);

    const plannerTimeoutOverride = 120000;
    const evaluatorTimeoutOverride = 45000;
    const originalPlannerTimeout = cfg.personaTimeouts["implementation-planner"];
    const originalEvaluatorTimeout = cfg.personaTimeouts["plan-evaluator"];
    const originalDefaultTimeout = cfg.personaDefaultTimeoutMs;

    personaMocks.sendPersonaRequestMock
      .mockResolvedValueOnce("corr-plan-timeout")
      .mockResolvedValueOnce("corr-eval-timeout");

    personaMocks.waitForPersonaCompletionMock
      .mockResolvedValueOnce({
        id: "plan-event-timeout",
        status: "success",
        fields: {
          status: "done",
          corr_id: "corr-plan-timeout",
          result: JSON.stringify({
            plan: [
              {
                goal: "Validate timeout behavior",
                key_files: ["src/timeout.ts"],
              },
            ],
            risks: [],
            metadata: {},
          }),
        },
      })
      .mockResolvedValueOnce({
        id: "eval-event-timeout",
        status: "success",
        fields: {
          status: "done",
          corr_id: "corr-eval-timeout",
          result: JSON.stringify({ status: "approved" }),
        },
      });

    const stepConfig = {
      name: "planning_loop_timeout",
      type: "PlanningLoopStep",
      config: {
        maxIterations: 1,
        plannerPersona: "implementation-planner",
        evaluatorPersona: "plan-evaluator",
        planningEvaluator: "on",
        planStep: "2-plan",
        evaluateStep: "2.5-evaluate-plan",
        payload: {},
      },
    } as any;

    const step = new PlanningLoopStep(stepConfig);

    try {
      cfg.personaTimeouts["implementation-planner"] = plannerTimeoutOverride;
      cfg.personaTimeouts["plan-evaluator"] = evaluatorTimeoutOverride;
      cfg.personaDefaultTimeoutMs = 30000;

      const result = await step.execute(context);
      expect(result.status).toBe("success");

      expect(personaMocks.waitForPersonaCompletionMock).toHaveBeenCalledTimes(2);
      expect(
        personaMocks.waitForPersonaCompletionMock.mock.calls[0][4],
      ).toBe(plannerTimeoutOverride);
      expect(
        personaMocks.waitForPersonaCompletionMock.mock.calls[1][4],
      ).toBe(evaluatorTimeoutOverride);
    } finally {
      if (originalPlannerTimeout === undefined)
        delete cfg.personaTimeouts["implementation-planner"];
      else cfg.personaTimeouts["implementation-planner"] = originalPlannerTimeout;

      if (originalEvaluatorTimeout === undefined)
        delete cfg.personaTimeouts["plan-evaluator"];
      else cfg.personaTimeouts["plan-evaluator"] = originalEvaluatorTimeout;

      cfg.personaDefaultTimeoutMs = originalDefaultTimeout;
    }
  });

  it("includes plan artifact path in evaluation payload", async () => {
    const mockWorkflowConfig = {
      name: "test-workflow",
      version: "1.0.0",
      steps: [],
    };

    const context = new WorkflowContext(
      "wf-handshake",
      "proj-handshake",
      "/tmp/repo-handshake",
      "main",
      mockWorkflowConfig as any,
      {} as any,
    );
    context.setVariable("task", {
      id: 42,
      title: "Example",
      description: "Ensure plan artifact handshake",
    });
    context.setVariable("SKIP_GIT_OPERATIONS", true);

    const planPayload = {
      plan: [
        {
          goal: "Implement handshake fixture",
          key_files: ["src/handshake.ts"],
        },
      ],
      risks: [],
    };

    const evaluationPayload = {
      status: "pass",
    };

    personaMocks.sendPersonaRequestMock
      .mockResolvedValueOnce("corr-plan-handshake")
      .mockResolvedValueOnce("corr-eval-handshake");

    personaMocks.waitForPersonaCompletionMock
      .mockResolvedValueOnce({
        id: "plan-event-handshake",
        status: "success",
        fields: {
          status: "done",
          corr_id: "corr-plan-handshake",
          result: JSON.stringify(planPayload),
        },
      })
      .mockResolvedValueOnce({
        id: "eval-event-handshake",
        status: "success",
        fields: {
          status: "done",
          corr_id: "corr-eval-handshake",
          result: JSON.stringify(evaluationPayload),
        },
      });

    const stepConfig = {
      name: "planning_loop_handshake",
      type: "PlanningLoopStep",
      config: {
        maxIterations: 1,
        plannerPersona: "implementation-planner",
        evaluatorPersona: "plan-evaluator",
        planningEvaluator: "on",
        planStep: "2-plan",
        evaluateStep: "2.5-evaluate-plan",
        payload: {},
      },
    } as any;

    const step = new PlanningLoopStep(stepConfig);
    await step.execute(context);

    const evalCall = personaMocks.sendPersonaRequestMock.mock.calls.find(
      ([, opts]) => opts.toPersona === "plan-evaluator",
    );
    expect(evalCall).toBeDefined();
    const evalPayload = evalCall?.[1].payload;
    expect(evalPayload?.plan_artifact).toBe(
      ".ma/tasks/42/02-plan-iteration-1.md",
    );
    expect(evalPayload?.plan_iteration_artifact).toBe(
      ".ma/tasks/42/02-plan-iteration-1.md",
    );
    expect(evalPayload?.plan_iteration).toBe(1);
    expect(evalPayload?.repo_root).toBe("/tmp/repo-handshake");
  });
});
