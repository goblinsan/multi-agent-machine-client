import { describe, expect, it } from "vitest";

import { makeTempRepo } from "../makeTempRepo.js";
import { WorkflowContext } from "../../src/workflows/engine/WorkflowContext.js";
import { ScopeViabilityStep } from "../../src/workflows/steps/ScopeViabilityStep.js";

function makeContext(repoRoot: string, planFiles: string[]) {
  return new WorkflowContext(
    "wf-scope-viability",
    "project-1",
    repoRoot,
    "main",
    { name: "test", version: "1.0.0", steps: [] },
    {} as any,
    {
      plan_required_files: planFiles,
      qa_required_files: [],
    },
  );
}

describe("ScopeViabilityStep", () => {
  it("fails before implementation when typecheck requires an out-of-scope schema file", async () => {
    const repoRoot = await makeTempRepo({
      "package.json": JSON.stringify({
        scripts: {
          typecheck:
            "node -e \"console.error('src/config/defaults.ts(5,3): error TS2353: Object literal may only specify known properties, and logPath does not exist in type AppConfig.'); process.exit(1)\"",
        },
      }),
      "src/config/schema.ts": [
        "export type AppConfig = {",
        "  enableStreaming: boolean;",
        "};",
        "",
      ].join("\n"),
      "src/config/defaults.ts": [
        "import type { AppConfig } from './schema.js';",
        "",
        "export const defaults: AppConfig = {",
        "  enableStreaming: true,",
        "  logPath: './logs/app.log',",
        "};",
        "",
      ].join("\n"),
    });
    const context = makeContext(repoRoot, ["src/config/defaults.ts"]);
    const step = new ScopeViabilityStep({
      name: "scope_viability",
      type: "ScopeViabilityStep",
      config: {
        plan_files_variable: "plan_required_files",
        timeout_ms: 30000,
      },
    });

    const result = await step.execute(context);

    expect(result.status).toBe("failure");
    expect(result.outputs?.status).toBe("requires_scope_expansion");
    expect(result.outputs?.required_files).toContain("src/config/schema.ts");
    expect(context.getVariable("workflow_stop_requested")).toBe(true);
  });

  it("can report scope expansion as a non-terminal recovery decision", async () => {
    const repoRoot = await makeTempRepo({
      "package.json": JSON.stringify({
        scripts: {
          typecheck:
            "node -e \"console.error('src/config/defaults.ts(5,3): error TS2353: Object literal may only specify known properties, and logPath does not exist in type AppConfig.'); console.error('src/App.tsx(1,1): error TS2305: Module has no exported member App.'); process.exit(1)\"",
        },
      }),
      "src/config/schema.ts": "export type AppConfig = { enableStreaming: boolean };\n",
      "src/config/defaults.ts": "export const defaults = { logPath: './logs/app.log' };\n",
      "src/App.tsx": "export const value = 1;\n",
    });
    const context = makeContext(repoRoot, ["src/config/defaults.ts"]);
    const step = new ScopeViabilityStep({
      name: "scope_viability",
      type: "ScopeViabilityStep",
      config: {
        plan_files_variable: "plan_required_files",
        timeout_ms: 30000,
        fail_on_scope_expansion: false,
      },
    });

    const result = await step.execute(context);

    expect(result.status).toBe("success");
    expect(result.outputs?.status).toBe("requires_scope_expansion");
    expect(result.outputs?.required_files).toEqual(["src/config/schema.ts"]);
    expect(result.outputs?.blocked_files).toContain("src/App.tsx");
    expect(context.getVariable("workflow_stop_requested")).toBeUndefined();
  });

  it("passes when typecheck failures are contained within the plan scope", async () => {
    const repoRoot = await makeTempRepo({
      "package.json": JSON.stringify({
        scripts: {
          typecheck:
            "node -e \"console.error('src/index.ts(1,14): error TS2322: Type number is not assignable to type string.'); process.exit(1)\"",
        },
      }),
      "src/index.ts": "export const value: string = 1;\n",
    });
    const context = makeContext(repoRoot, ["src/index.ts"]);
    const step = new ScopeViabilityStep({
      name: "scope_viability",
      type: "ScopeViabilityStep",
      config: {
        plan_files_variable: "plan_required_files",
        timeout_ms: 30000,
      },
    });

    const result = await step.execute(context);

    expect(result.status).toBe("success");
    expect(result.outputs?.status).toBe("viable");
    expect(result.outputs?.reason).toBe(
      "typecheck_failures_are_within_plan_scope",
    );
  });
});
