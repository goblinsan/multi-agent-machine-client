import { describe, it, expect } from "vitest";
import {
  resolvePlanStages,
  typecheckErrorSignature,
} from "../src/workflows/steps/helpers/implementationStages";

function planEvent(steps: unknown[]) {
  return {
    fields: {
      status: "done",
      result: JSON.stringify({ plan: steps }),
    },
  };
}

describe("resolvePlanStages", () => {
  const fallback = ["src/a.ts", "src/b.ts"];

  it("returns one stage per plan step with normalized files", () => {
    const stages = resolvePlanStages(
      planEvent([
        {
          goal: "Add event types",
          key_files: ["src/types/eventTypes.ts"],
          acceptance_criteria: ["types compile"],
        },
        {
          goal: "Add events route",
          key_files: ["./src/routes/events.ts", "src/types/eventTypes.ts"],
        },
      ]),
      fallback,
    );

    expect(stages).toHaveLength(2);
    expect(stages[0]).toMatchObject({
      index: 1,
      total: 2,
      goal: "Add event types",
      files: ["src/types/eventTypes.ts"],
      acceptance: ["types compile"],
    });
    expect(stages[1].files).toEqual([
      "src/routes/events.ts",
      "src/types/eventTypes.ts",
    ]);
  });

  it("falls back to a single stage for single-step or missing plans", () => {
    expect(resolvePlanStages(null, fallback)).toEqual([
      { index: 1, total: 1, goal: "", files: fallback, acceptance: [] },
    ]);
    expect(
      resolvePlanStages(planEvent([{ goal: "only", key_files: ["src/a.ts"] }]), fallback),
    ).toHaveLength(1);
    expect(resolvePlanStages({ fields: { result: "not json" } }, fallback)).toHaveLength(1);
  });

  it("falls back to a single stage when any step lacks key files", () => {
    const stages = resolvePlanStages(
      planEvent([
        { goal: "one", key_files: ["src/a.ts"] },
        { goal: "two", key_files: [] },
      ]),
      fallback,
    );
    expect(stages).toHaveLength(1);
    expect(stages[0].files).toEqual(fallback);
  });

  it("falls back to a single stage when the plan has too many steps", () => {
    const steps = Array.from({ length: 11 }, (_, i) => ({
      goal: `step ${i}`,
      key_files: [`src/f${i}.ts`],
    }));
    expect(resolvePlanStages(planEvent(steps), fallback)).toHaveLength(1);
  });
});

describe("typecheckErrorSignature", () => {
  it("is stable across line and column shifts", () => {
    const a = typecheckErrorSignature({
      file: "src/App.tsx",
      code: "TS2305",
      message: "Module './x' has no exported member 'normalizeLogEvent'.",
    });
    const b = typecheckErrorSignature({
      file: "src/App.tsx",
      reason:
        "Typecheck TS2305 at src/App.tsx:42:7 - Module './x' has no exported member 'normalizeLogEvent'.",
    });
    expect(a.split("|")[0]).toBe("src/App.tsx");
    expect(a.split("|")[1]).toBe("TS2305");
    expect(b).toContain("TS2305");
  });

  it("differs when the error code or file differs", () => {
    const base = { file: "src/a.ts", code: "TS1005", message: "';' expected." };
    expect(typecheckErrorSignature(base)).not.toBe(
      typecheckErrorSignature({ ...base, code: "TS1109" }),
    );
    expect(typecheckErrorSignature(base)).not.toBe(
      typecheckErrorSignature({ ...base, file: "src/b.ts" }),
    );
  });
});
