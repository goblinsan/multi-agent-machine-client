import { describe, it, expect } from "vitest";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { parse } from "yaml";

async function loadFlow(file: string) {
  const p = path.resolve(process.cwd(), "src/workflows/definitions", file);
  const wf = parse(await readFile(p, "utf-8")) as {
    trigger?: { condition?: string };
    steps: Array<{ name: string; type: string; depends_on?: string[]; condition?: string; config?: any }>;
  };
  return {
    condition: wf.trigger?.condition,
    steps: Object.fromEntries(wf.steps.map((s) => [s.name, s])),
    stepList: wf.steps,
  };
}

describe("change-setup flow", () => {
  it("triggers only for change_setup tasks", async () => {
    const { condition } = await loadFlow("change-setup.yaml");
    expect(condition).toBe("task_type == 'change_setup'");
  });

  it("branches the change branch off main and publishes it", async () => {
    const { steps } = await loadFlow("change-setup.yaml");
    const create = steps["create_change_branch"];
    expect(create?.config?.operation).toBe("checkoutBranchFromBase");
    expect(create?.config?.baseBranch).toBe("main");
    expect(create?.config?.newBranch).toBe("${changeBranch}");
    expect(steps["publish_change_branch"]?.config?.operation).toBe("ensureBranchPublished");
  });
});

describe("change-flow (convergence) flow", () => {
  it("triggers only for change_converge tasks", async () => {
    const { condition } = await loadFlow("change-flow.yaml");
    expect(condition).toBe("task_type == 'change_converge'");
  });

  it("runs the FULL deterministic review on the whole change (coverage + method_size)", async () => {
    const { steps } = await loadFlow("change-flow.yaml");
    const review = steps["convergence_review"];
    expect(review?.type).toBe("DeterministicReviewStep");
    const ruleIds = (review?.config?.rules ?? []).map((r: any) => r.id);
    expect(ruleIds).toContain("test_coverage");
    expect(ruleIds).toContain("method_size");
  });

  it("gates the merge behind the convergence decision", async () => {
    const { steps } = await loadFlow("change-flow.yaml");
    expect(steps["convergence_gate"]?.type).toBe("ConvergenceGateStep");
    const merge = steps["merge_change_to_main"];
    expect(merge?.config?.operation).toBe("mergeBranchToMain");
    expect(merge?.config?.targetBranch).toBe("main");
    expect(merge?.config?.sourceBranch).toBe("${changeBranch}");
    expect(merge?.condition).toContain("convergence_status == 'pass'");
  });

  it("marks the change done only after the merge, and only on pass", async () => {
    const { steps } = await loadFlow("change-flow.yaml");
    const done = steps["mark_change_done"];
    expect(done?.depends_on).toContain("merge_change_to_main");
    expect(done?.condition).toContain("convergence_status == 'pass'");
  });

  it("blocks the change on workflow failure", async () => {
    const p = path.resolve(process.cwd(), "src/workflows/definitions/change-flow.yaml");
    const wf = parse(await readFile(p, "utf-8")) as any;
    const handler = wf.failure_handling?.on_workflow_failure?.[0];
    expect(handler?.config?.status).toBe("blocked");
  });
});
