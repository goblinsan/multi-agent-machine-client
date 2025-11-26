import { describe, it, expect, beforeEach } from "vitest";
import fs from "fs/promises";
import path from "path";
import { makeTempRepo } from "../makeTempRepo.js";
import { WorkflowContext } from "../../src/workflows/engine/WorkflowContext.js";
import { PlanKeyFileGuardStep } from "../../src/workflows/steps/PlanKeyFileGuardStep.js";

function buildPlanResult(keyFiles: string[]) {
  return {
    fields: {
      result: JSON.stringify({
        plan: [
          {
            goal: "Add regression coverage",
            key_files: keyFiles,
          },
        ],
      }),
    },
  };
}

describe("PlanKeyFileGuardStep", () => {
  let repoRoot: string;
  let context: WorkflowContext;
  const transport: any = {};

  beforeEach(async () => {
    repoRoot = await makeTempRepo();
    context = new WorkflowContext(
      "wf-plan-guard-001",
      "proj-guard",
      repoRoot,
      "main",
      { name: "test", version: "1.0.0", steps: [] },
      transport,
      {},
    );

    context.setVariable("SKIP_GIT_OPERATIONS", true);
    context.setVariable("task", { id: "task-77" });
    context.setStepOutput("planning_loop", {
      plan_result: buildPlanResult(["tests/regression/user-flow.test.ts"]),
    });
  });

  it("creates missing plan files when autoCreate is enabled", async () => {
    const step = new PlanKeyFileGuardStep({
      name: "enforce_plan_key_files",
      type: "PlanKeyFileGuardStep",
      config: {
        plan_step: "planning_loop",
        plan_files_variable: "planning_loop_plan_files",
        auto_create_missing: true,
        fail_on_missing: true,
      },
    });

    const result = await step.execute(context);

    expect(result.status).toBe("success");
    expect(result.data?.createdFiles).toEqual([
      "tests/regression/user-flow.test.ts",
    ]);

    const filePath = path.join(repoRoot, "tests/regression/user-flow.test.ts");
    const content = await fs.readFile(filePath, "utf-8");
    expect(content).toContain("describe(\"tests/regression/user-flow.test.ts\"");
  });

  it("fails when files are missing and autoCreate is disabled", async () => {
    const step = new PlanKeyFileGuardStep({
      name: "verify_plan_key_files",
      type: "PlanKeyFileGuardStep",
      config: {
        plan_step: "planning_loop",
        plan_files_variable: "planning_loop_plan_files",
        auto_create_missing: false,
        fail_on_missing: true,
      },
    });

    const result = await step.execute(context);

    expect(result.status).toBe("failure");
    expect(result.error).toBeInstanceOf(Error);
    expect(result.error?.message).toContain("missing required files");
  });

  it("extracts plan files when planner output embeds JSON string", async () => {
    context.setStepOutput("planning_loop", {
      plan_result: {
        fields: {
          result: JSON.stringify({
            output: JSON.stringify({
              plan: [
                {
                  goal: "Ensure nested parsing works",
                  key_files: ["tests/regression/string-output.test.ts"],
                },
              ],
            }),
          }),
        },
      },
    });

    const step = new PlanKeyFileGuardStep({
      name: "verify_plan_key_files",
      type: "PlanKeyFileGuardStep",
      config: {
        plan_step: "planning_loop",
        auto_create_missing: false,
        fail_on_missing: false,
      },
    });

    const result = await step.execute(context);

    expect(result.status).toBe("success");
    expect(result.data?.keyFiles).toEqual([
      "tests/regression/string-output.test.ts",
    ]);
    expect(result.data?.missingFiles).toEqual([
      "tests/regression/string-output.test.ts",
    ]);
  });

  it("uses plan_files_variable fallback when plan output lacks key files", async () => {
    context.setVariable("planning_loop_plan_files", [
      "tests/regression/from-context.test.ts",
    ]);
    context.setStepOutput("planning_loop", {
      plan_result: buildPlanResult([]),
    });

    const step = new PlanKeyFileGuardStep({
      name: "verify_plan_key_files",
      type: "PlanKeyFileGuardStep",
      config: {
        plan_step: "planning_loop",
        plan_files_variable: "planning_loop_plan_files",
        auto_create_missing: false,
        fail_on_missing: false,
      },
    });

    const result = await step.execute(context);

    expect(result.status).toBe("success");
    expect(result.data?.keyFiles).toEqual([
      "tests/regression/from-context.test.ts",
    ]);
    expect(result.data?.missingFiles).toEqual([
      "tests/regression/from-context.test.ts",
    ]);
  });
});
