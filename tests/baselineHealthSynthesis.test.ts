import { describe, it, expect, vi, beforeEach } from "vitest";
import { BaselineHealthSynthesisStep } from "../src/workflows/steps/BaselineHealthSynthesisStep.js";
import { logger } from "../src/logger.js";

vi.mock("../src/logger.js", () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
}));

describe("BaselineHealthSynthesisStep", () => {
  let variables: Map<string, unknown>;
  let context: any;

  beforeEach(() => {
    variables = new Map();
    context = {
      workflowId: "wf-1",
      getVariable: (name: string) => variables.get(name),
      setVariable: (name: string, value: unknown) =>
        variables.set(name, value),
      logger,
    };
  });

  function makeStep(config: Record<string, unknown> = {}) {
    return new BaselineHealthSynthesisStep({
      name: "baseline_health_synthesis",
      type: "BaselineHealthSynthesisStep",
      config,
    });
  }

  it("creates one repair task per broken file with idempotent ids", async () => {
    variables.set("baseline_compile_errors", [
      {
        file: "src/App.tsx",
        errorCount: 18,
        sample: ["- Line 82, Col 7: ',' expected."],
      },
      {
        file: "src/config/schema.ts",
        errorCount: 2,
        sample: ["- Line 2, Col 14: ';' expected."],
      },
    ]);

    const result = await makeStep().execute(context);

    expect(result.status).toBe("success");
    const tasks = (result.outputs as any).repair_tasks;
    expect(tasks).toHaveLength(2);
    expect(tasks[0].title).toBe("Fix baseline compile errors in src/App.tsx");
    expect(tasks[0].external_id).toBe("baseline-repair-src_App.tsx");
    expect(tasks[0].description).toContain("',' expected.");
    expect(tasks[0].description).toContain("npx tsc --noEmit");
    expect(tasks[1].external_id).toBe(
      "baseline-repair-src_config_schema.ts",
    );
  });

  it("orders by error count and caps at max_tasks", async () => {
    variables.set(
      "baseline_compile_errors",
      Array.from({ length: 8 }, (_, i) => ({
        file: `src/f${i}.ts`,
        errorCount: i,
        sample: [],
      })),
    );

    const result = await makeStep({ max_tasks: 3 }).execute(context);
    const tasks = (result.outputs as any).repair_tasks;

    expect(tasks).toHaveLength(3);
    expect(tasks[0].title).toContain("src/f7.ts");
    expect((result.outputs as any).broken_file_count).toBe(8);
  });

  it("succeeds with no tasks when the baseline is clean or unset", async () => {
    variables.set("baseline_compile_errors", []);
    let result = await makeStep().execute(context);
    expect((result.outputs as any).repair_task_count).toBe(0);

    variables.delete("baseline_compile_errors");
    result = await makeStep().execute(context);
    expect((result.outputs as any).repair_task_count).toBe(0);
    expect(variables.get("baseline_repair_tasks")).toEqual([]);
  });
});
