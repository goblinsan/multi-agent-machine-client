import { describe, it, expect } from "vitest";
import { normalizePlanPayload } from "../src/workflows/steps/helpers/planningHelpers";
import { resolvePlanStages } from "../src/workflows/steps/helpers/implementationStages";

function planEvent(steps: unknown[]) {
  return {
    fields: {
      status: "done",
      result: JSON.stringify({ plan: steps }),
    },
  };
}

describe("verification-only plan step sanitization", () => {
  it("removes verification steps whose key_files are globs", () => {
    const event = planEvent([
      { goal: "Fix retention mocks", key_files: ["src/__tests__/retention-engine.test.ts"] },
      { goal: "Update writer types", key_files: ["src/types/index.ts"] },
      {
        goal: "Verify all fixes by running test suite",
        key_files: ["src/__tests__/*.ts", "src/__tests__/*.tsx"],
      },
    ]);

    const { planData } = normalizePlanPayload(event);
    expect(planData.plan).toHaveLength(2);
    expect(
      planData.plan.map((step: any) => step.goal),
    ).toEqual(["Fix retention mocks", "Update writer types"]);
  });

  it("removes verification steps with empty or directory key_files", () => {
    const event = planEvent([
      { goal: "Implement events route", key_files: ["src/routes/events.ts"] },
      { goal: "Run typecheck to validate", key_files: [] },
      { goal: "Run the full regression suite", key_files: ["src/__tests__/"] },
    ]);

    const { planData } = normalizePlanPayload(event);
    expect(planData.plan).toHaveLength(1);
    expect(planData.plan[0].goal).toBe("Implement events route");
  });

  it("keeps verification-flavored steps that name concrete files", () => {
    const event = planEvent([
      { goal: "Fix schema", key_files: ["src/config/schema.ts"] },
      {
        goal: "Update test suite helpers to verify retention",
        key_files: ["src/__tests__/retention-engine.test.ts"],
      },
    ]);

    const { planData } = normalizePlanPayload(event);
    expect(planData.plan).toHaveLength(2);
  });

  it("keeps non-verification steps untouched even with bad paths", () => {
    const event = planEvent([
      { goal: "Refactor config module", key_files: ["src/config/*.ts"] },
      { goal: "Fix loader", key_files: ["src/config/loader.ts"] },
    ]);

    const { planData } = normalizePlanPayload(event);
    expect(planData.plan).toHaveLength(2);
  });

  it("feeds sanitized plans into stage resolution", () => {
    const event = planEvent([
      { goal: "Fix mocks", key_files: ["src/__tests__/retention-engine.test.ts"] },
      { goal: "Fix types", key_files: ["src/types/index.ts"] },
      { goal: "Verify by running tests", key_files: ["src/__tests__/*.ts"] },
    ]);

    const stages = resolvePlanStages(event, ["fallback.ts"]);
    expect(stages).toHaveLength(2);
    expect(stages[1].total).toBe(2);
    expect(stages.every((s) => s.files.every((f) => !f.includes("*")))).toBe(
      true,
    );
  });
});
