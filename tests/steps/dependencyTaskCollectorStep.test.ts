import { describe, it, expect, beforeEach } from "vitest";
import { WorkflowContext } from "../../src/workflows/engine/WorkflowContext.js";
import { makeTempRepo } from "../makeTempRepo.js";
import { DependencyTaskCollectorStep } from "../../src/workflows/steps/DependencyTaskCollectorStep.js";

describe("DependencyTaskCollectorStep", () => {
  let context: WorkflowContext;
  let repoRoot: string;

  beforeEach(async () => {
    repoRoot = await makeTempRepo();
    const transport: any = {};
    context = new WorkflowContext(
      "wf-dep-collector",
      "proj-1",
      repoRoot,
      "main",
      { name: "test", version: "1.0.0", steps: [] },
      transport,
      {},
    );
  });

  it("merges primary and duplicate ids into a unique list", async () => {
    const step = new DependencyTaskCollectorStep({
      name: "collect_dependency_ids",
      type: "DependencyTaskCollectorStep",
      config: {
        primary_ids: ["101", "102"],
        duplicate_ids: "102, 103",
        extra_ids: 104,
        output_variable: "dependency_task_ids",
      },
    });

    const result = await step.execute(context);

    expect(result.status).toBe("success");
    expect(result.data?.dependency_task_ids).toEqual([
      "101",
      "102",
      "103",
      "104",
    ]);
    expect(context.getVariable("dependency_task_ids")).toEqual([
      "101",
      "102",
      "103",
      "104",
    ]);
  });
});
