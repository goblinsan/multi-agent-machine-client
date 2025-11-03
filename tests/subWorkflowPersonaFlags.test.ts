import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { SubWorkflowStep } from "../src/workflows/steps/SubWorkflowStep.js";
import { WorkflowContext } from "../src/workflows/engine/WorkflowContext.js";
import type { WorkflowDefinition } from "../src/workflows/WorkflowEngine.js";
import { WorkflowEngine } from "../src/workflows/WorkflowEngine.js";

const stubDefinition: WorkflowDefinition = {
  name: "stub-subworkflow",
  description: "",
  version: "1.0.0",
  trigger: { condition: "true" },
  context: { repo_required: false },
  steps: [],
};

describe("SubWorkflowStep persona flags", () => {
  let capturedInitialVariables: Record<string, any> | null;

  beforeEach(() => {
    capturedInitialVariables = null;
    vi
      .spyOn(WorkflowEngine.prototype, "loadWorkflowFromFile")
      .mockResolvedValue(stubDefinition);
    vi
      .spyOn(WorkflowEngine.prototype, "executeWorkflowDefinition")
      .mockImplementation(async function (
        definition,
        projectId,
        repoRoot,
        branch,
        transport,
        initialVariables,
      ) {
        capturedInitialVariables = initialVariables ?? null;
        const finalContext = new WorkflowContext(
          "subworkflow-id",
          projectId,
          repoRoot,
          branch ?? "main",
          definition,
          transport as any,
          initialVariables,
        );
        return {
          success: true,
          completedSteps: [],
          duration: 0,
          finalContext,
        };
      });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  function makeParentContext(initial: Record<string, any> = {}) {
    const parentDefinition: WorkflowDefinition = {
      name: "parent",
      description: "",
      version: "1.0.0",
      trigger: { condition: "true" },
      context: { repo_required: false },
      steps: [],
    };

    return new WorkflowContext(
      "parent-id",
      "project-1",
      "/repo",
      "main",
      parentDefinition,
      {} as any,
      initial,
    );
  }

  it("defaults SKIP_PERSONA_OPERATIONS to false when parent has no value", async () => {
    const context = makeParentContext();
    const step = new SubWorkflowStep({
      name: "handle_review_failure",
      type: "SubWorkflowStep",
      config: {
        workflow: "review-failure-handling",
      },
    });

    const result = await step.execute(context);

    expect(result.status).toBe("success");
    expect(capturedInitialVariables).toBeDefined();
    expect(capturedInitialVariables?.SKIP_PERSONA_OPERATIONS).toBe(false);
  });

  it("preserves explicit parent SKIP_PERSONA_OPERATIONS value", async () => {
    const context = makeParentContext({ SKIP_PERSONA_OPERATIONS: true });
    const step = new SubWorkflowStep({
      name: "handle_review_failure",
      type: "SubWorkflowStep",
      config: {
        workflow: "review-failure-handling",
      },
    });

    const result = await step.execute(context);

    expect(result.status).toBe("success");
    expect(capturedInitialVariables).toBeDefined();
    expect(capturedInitialVariables?.SKIP_PERSONA_OPERATIONS).toBe(true);
  });
});
