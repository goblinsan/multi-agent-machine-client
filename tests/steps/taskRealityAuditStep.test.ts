import { describe, expect, it } from "vitest";
import fs from "fs/promises";
import path from "path";

import { makeTempRepo } from "../makeTempRepo.js";
import { WorkflowContext } from "../../src/workflows/engine/WorkflowContext.js";
import { TaskRealityAuditStep } from "../../src/workflows/steps/TaskRealityAuditStep.js";

function makeContext(repoRoot: string, task: any) {
  return new WorkflowContext(
    "wf-task-audit",
    "project-1",
    repoRoot,
    "main",
    { name: "test", version: "1.0.0", steps: [] },
    {} as any,
    {
      task,
      projectId: "project-1",
      taskId: task.id,
    },
  );
}

describe("TaskRealityAuditStep", () => {
  it("auto-resolves compile/typecheck tasks when diagnostics are clean", async () => {
    const repoRoot = await makeTempRepo({
      "package.json": JSON.stringify({
        scripts: { typecheck: "node -e \"process.exit(0)\"" },
      }),
      "src/index.ts": "export const value = 1;\n",
    });
    const context = makeContext(repoRoot, {
      id: "task-1",
      title: "Fix TypeScript compile error in src/index.ts",
      description: "tsc previously failed for src/index.ts",
    });

    const step = new TaskRealityAuditStep({
      name: "task_reality_audit",
      type: "TaskRealityAuditStep",
      config: { update_task_status: false, timeout_ms: 10000 },
    });

    const result = await step.execute(context);

    expect(result.status).toBe("success");
    expect(result.outputs?.already_resolved).toBe(true);
    expect(result.outputs?.reason).toBe(
      "compile_or_typecheck_task_has_clean_diagnostics",
    );
    expect(context.getVariable("workflow_stop_requested")).toBe(true);
  });

  it("auto-resolves fix tasks whose explicit target file no longer exists", async () => {
    const repoRoot = await makeTempRepo({
      "package.json": JSON.stringify({ scripts: {} }),
      "src/current.ts": "export const current = true;\n",
    });
    const context = makeContext(repoRoot, {
      id: "task-2",
      title: "Fix broken parser in src/removedParser.ts",
      description: "Repair the old src/removedParser.ts implementation.",
    });

    const step = new TaskRealityAuditStep({
      name: "task_reality_audit",
      type: "TaskRealityAuditStep",
      config: {
        update_task_status: false,
        run_typecheck: false,
      },
    });

    const result = await step.execute(context);

    expect(result.outputs?.already_resolved).toBe(true);
    expect(result.outputs?.reason).toBe("fix_target_no_longer_exists");
  });

  it("does not auto-resolve a build task whose target does not exist yet even if its spec mentions 'error'", async () => {
    const repoRoot = await makeTempRepo({
      "package.json": JSON.stringify({
        scripts: { typecheck: "node -e \"process.exit(0)\"" },
      }),
      "src/api.ts": "export const apiGet = 1;\n",
    });
    await fs.mkdir(path.join(repoRoot, "src", "views"), { recursive: true });
    const context = makeContext(repoRoot, {
      id: "task-build",
      title: "Build the Projects list view in src/views/ProjectsView.tsx",
      description:
        'Create ONE self-contained file src/views/ProjectsView.tsx. apiGet<T>(path) resolves to { data: T; error?: string }. Render a list of projects.',
    });

    const step = new TaskRealityAuditStep({
      name: "task_reality_audit",
      type: "TaskRealityAuditStep",
      config: { update_task_status: false, timeout_ms: 10000 },
    });

    const result = await step.execute(context);

    expect(result.outputs?.already_resolved).toBe(false);
    expect(context.getVariable("workflow_stop_requested")).toBeUndefined();
  });

  it("does not auto-resolve an enhancement task just because its target file already exists", async () => {
    const repoRoot = await makeTempRepo({
      "package.json": JSON.stringify({
        scripts: { typecheck: "node -e \"process.exit(0)\"" },
      }),
      "src/views/ProjectsView.tsx":
        'import { useState } from "react";\nimport { apiGet } from "../api";\ntype Project = { id: number };\nexport function ProjectsView() { return null; }\n',
    });
    const context = makeContext(repoRoot, {
      id: "task-enhance",
      title: "Add states and search to the Projects list view in src/views/ProjectsView.tsx",
      description:
        "Add loading, error and empty states plus a search filter to src/views/ProjectsView.tsx using useState and apiGet with a Project type.",
    });

    const step = new TaskRealityAuditStep({
      name: "task_reality_audit",
      type: "TaskRealityAuditStep",
      config: { update_task_status: false, timeout_ms: 10000 },
    });

    const result = await step.execute(context);

    expect(result.outputs?.already_resolved).toBe(false);
    expect(context.getVariable("workflow_stop_requested")).toBeUndefined();
  });

  it("does not resolve feature work when requested artifacts are missing", async () => {
    const repoRoot = await makeTempRepo({
      "package.json": JSON.stringify({
        scripts: { typecheck: "node -e \"process.exit(0)\"" },
      }),
    });
    await fs.mkdir(path.join(repoRoot, "src"), { recursive: true });
    const context = makeContext(repoRoot, {
      id: "task-3",
      title: "Implement feature widget in src/Widget.ts",
      description: "Add component Widget and wire it into the app.",
    });

    const step = new TaskRealityAuditStep({
      name: "task_reality_audit",
      type: "TaskRealityAuditStep",
      config: { update_task_status: false, timeout_ms: 10000 },
    });

    const result = await step.execute(context);

    expect(result.outputs?.already_resolved).toBe(false);
    expect(context.getVariable("workflow_stop_requested")).toBeUndefined();
  });
});
