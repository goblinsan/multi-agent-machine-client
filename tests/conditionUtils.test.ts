import { describe, expect, it, vi } from "vitest";
import type { WorkflowContext } from "../src/workflows/engine/WorkflowContext.js";
import { evaluateCondition } from "../src/workflows/engine/conditionUtils.js";

function createContext(
  variables: Record<string, any>,
  stepOutputs: Record<string, any> = {},
): WorkflowContext {
  return {
    getVariable: (key: string) => variables[key],
    getStepOutput: (name: string) => stepOutputs[name],
    logger: {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
    },
  } as unknown as WorkflowContext;
}

describe("conditionUtils", () => {
  it("treats bare variables as truthy when they exist", () => {
    const ctx = createContext({ parent_task_id: "123" }, {
      collect_dependency_ids: { dependency_task_ids: [90] },
    });

    const result = evaluateCondition(
      "parent_task_id && collect_dependency_ids.dependency_task_ids.length > 0",
      ctx,
    );

    expect(result).toBe(true);
  });

  it("supports negating bare variables", () => {
    const ctx = createContext({}, {});
    expect(evaluateCondition("!parent_task_id", ctx)).toBe(true);
  });
});
