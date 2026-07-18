import { describe, it, expect } from "vitest";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { parse } from "yaml";

async function loadFileFlow() {
  const p = path.resolve(
    process.cwd(),
    "src/workflows/definitions/task-flow-file.yaml",
  );
  const wf = parse(await readFile(p, "utf-8")) as {
    trigger?: { condition?: string };
    steps: Array<{ name: string; type: string; depends_on?: string[]; condition?: string; config?: any; outputs?: string[] }>;
  };
  return {
    condition: wf.trigger?.condition,
    steps: Object.fromEntries(wf.steps.map((s) => [s.name, s])),
    stepList: wf.steps,
  };
}

describe("task-flow-file (per-file diverge-converge flow)", () => {
  it("only runs for change_file tasks, via a trigger condition (not default-open)", async () => {
    const { condition } = await loadFileFlow();
    expect(condition).toBe("task_type == 'change_file'");
  });

  it("branches off the change branch into a file sub-branch", async () => {
    const { steps } = await loadFileFlow();
    const checkout = steps["checkout_file_branch"];
    expect(checkout?.type).toBe("GitOperationStep");
    expect(checkout?.config?.operation).toBe("checkoutBranchFromBase");
    expect(checkout?.config?.baseBranch).toBe("${changeBranch}");
    expect(checkout?.config?.newBranch).toBe("${fileBranch}");
  });

  it("merges the file sub-branch back into the change branch, never main", async () => {
    const { steps, stepList } = await loadFileFlow();
    const merge = steps["merge_to_change_branch"];
    expect(merge?.config?.operation).toBe("mergeBranchToMain");
    expect(merge?.config?.sourceBranch).toBe("${fileBranch}");
    expect(merge?.config?.targetBranch).toBe("${changeBranch}");

    for (const s of stepList) {
      expect(s.config?.targetBranch).not.toBe("main");
    }
    expect(steps["merge_branch_to_main"]).toBeUndefined();
  });

  it("uses a file-local deterministic review with no test_coverage or cross-file rules", async () => {
    const { steps } = await loadFileFlow();
    const review = steps["file_local_review"];
    expect(review?.type).toBe("DeterministicReviewStep");
    const ruleIds = (review?.config?.rules ?? []).map((r: any) => r.id);
    expect(ruleIds).toContain("method_size");
    expect(ruleIds).toContain("secret_scan");
    expect(ruleIds).toContain("conflict_markers");
    expect(ruleIds).not.toContain("test_coverage");
  });

  it("defers the model reviews (code/security/devops) to convergence", async () => {
    const { steps } = await loadFileFlow();
    expect(steps["code_review_request"]).toBeUndefined();
    expect(steps["security_request"]).toBeUndefined();
    expect(steps["devops_request"]).toBeUndefined();
  });

  it("marks the file-task done only when the file-local review passes", async () => {
    const { steps } = await loadFileFlow();
    const done = steps["mark_task_done"];
    expect(done?.depends_on).toContain("merge_to_change_branch");
    expect(done?.condition).toBe("${qa_request_status} == 'pass'");
  });
});
