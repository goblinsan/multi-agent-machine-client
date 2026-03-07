import { describe, expect, it } from "vitest";
import {
  WorkflowEngine,
  type WorkflowDefinition,
} from "../src/workflows/WorkflowEngine.js";
import type { MessageTransport } from "../src/transport/MessageTransport.js";

const mockTransport = {
  connect: async () => {},
  disconnect: async () => {},
  xAdd: async () => "0-0",
  xGroupCreate: async () => {},
  xReadGroup: async () => null,
  xRead: async () => null,
  xAck: async () => 0,
  xLen: async () => 0,
  del: async () => 0,
  xInfoGroups: async () => [],
  xGroupDestroy: async () => true,
  quit: async () => {},
} as MessageTransport;

describe("WorkflowEngine conditional skips", () => {
  it("allows dependents to run when an upstream step is skipped", async () => {
    const engine = new WorkflowEngine();
    const workflowDef: WorkflowDefinition = {
      name: "skip-test",
      description: "Ensures skipped steps unblock dependents",
      version: "1.0.0",
      trigger: { condition: "true" },
      context: { repo_required: false },
      steps: [
        {
          name: "skipped_step",
          type: "VariableResolutionStep",
          description: "This step should be skipped",
          condition: "run_skipped == true",
          config: {
            variables: { should_not_exist: "value" },
          },
        },
        {
          name: "dependent_step",
          type: "VariableResolutionStep",
          description: "Runs even if the dependency was skipped",
          depends_on: ["skipped_step"],
          config: {
            variables: { executed: true },
          },
        },
      ],
    };

    const result = await engine.executeWorkflowDefinition(
      workflowDef,
      "test-project",
      process.cwd(),
      "main",
      mockTransport,
      { run_skipped: false },
    );

    expect(result.success).toBe(true);
    expect(result.completedSteps).toContain("skipped_step");
    expect(result.completedSteps).toContain("dependent_step");
    expect(result.finalContext.getVariable("executed")).toBe(true);
    expect(result.finalContext.getVariable("should_not_exist")).toBeUndefined();
  });
});
