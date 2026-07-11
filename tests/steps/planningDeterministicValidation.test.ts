import { describe, expect, it } from "vitest";
import {
  extractTargetedBaselineCompileFiles,
  sanitizeVerificationOnlySteps,
  validateDeterministicPlan,
} from "../../src/workflows/steps/helpers/planningHelpers.js";

describe("deterministic plan validation", () => {
  it("accepts sequential dependencies on previous steps", () => {
    const result = validateDeterministicPlan({
      plan: [
        {
          goal: "Define event types",
          key_files: ["src/types/logEvent.ts"],
        },
        {
          goal: "Implement events route",
          key_files: ["src/routes/events.ts"],
          dependencies: ["Step 1"],
        },
        {
          goal: "Add route tests",
          key_files: ["src/__tests__/events-api.test.ts"],
          dependencies: ["Step 2"],
        },
      ],
    });

    expect(result.valid).toBe(true);
    expect(result.issues).toEqual([]);
  });

  it("rejects real dependency cycles", () => {
    const result = validateDeterministicPlan({
      plan: [
        {
          goal: "First",
          key_files: ["src/first.ts"],
          dependencies: ["Step 2"],
        },
        {
          goal: "Second",
          key_files: ["src/second.ts"],
          dependencies: ["Step 1"],
        },
      ],
    });

    expect(result.valid).toBe(false);
    expect(result.issues.some((issue) => issue.guard === "dependency_graph")).toBe(true);
  });

  it("rejects ambiguous alternatives in the same step", () => {
    const result = validateDeterministicPlan({
      plan: [
        {
          goal: "Pick one route location",
          key_files: ["src/routes/events.ts", "src/routes/events/index.ts"],
        },
      ],
    });

    expect(result.valid).toBe(false);
    expect(result.issues.some((issue) => issue.guard === "ambiguous_key_files")).toBe(true);
  });

  it("allows clearly new deliverable files without requiring them to exist", () => {
    const result = validateDeterministicPlan(
      {
        plan: [
          {
            goal: "Create events route",
            key_files: ["src/routes/events.ts"],
          },
        ],
      },
      {
        existingPaths: new Set(["src/types/logEvent.ts"]),
        allowedLanguages: new Set(["typescript"]),
      },
    );

    expect(result.valid).toBe(true);
  });

  it("rejects key files that look like typos of existing files", () => {
    const result = validateDeterministicPlan(
      {
        plan: [
          {
            goal: "Update event types",
            key_files: ["src/types/logEvents.ts"],
          },
        ],
      },
      {
        existingPaths: new Set(["src/types/logEvent.ts"]),
        allowedLanguages: new Set(["typescript"]),
      },
    );

    expect(result.valid).toBe(false);
    expect(result.issues.some((issue) => issue.guard === "path_violations")).toBe(true);
  });

  it("extracts target files from generated baseline compile-error tasks", () => {
    expect(
      extractTargetedBaselineCompileFiles(
        "Fix baseline compile errors in src/__tests__/batched-writer.test.ts",
      ),
    ).toEqual(["src/__tests__/batched-writer.test.ts"]);
  });

  it("rejects broad plans for a single-file baseline compile-error task", () => {
    const result = validateDeterministicPlan(
      {
        plan: [
          {
            goal: "Fix writer test mocks",
            key_files: ["src/__tests__/batched-writer.test.ts"],
          },
          {
            goal: "Fix retention test mocks",
            key_files: ["src/__tests__/retention-engine.test.ts"],
          },
        ],
      },
      {
        taskTitle:
          "Fix baseline compile errors in src/__tests__/batched-writer.test.ts",
      },
    );

    expect(result.valid).toBe(false);
    expect(
      result.issues.some((issue) => issue.guard === "targeted_task_scope"),
    ).toBe(true);
  });

  it("allows the targeted file for a baseline compile-error task", () => {
    const result = validateDeterministicPlan(
      {
        plan: [
          {
            goal: "Fix writer test mocks",
            key_files: ["src/__tests__/batched-writer.test.ts"],
          },
        ],
      },
      {
        taskTitle:
          "Fix baseline compile errors in src/__tests__/batched-writer.test.ts",
      },
    );

    expect(result.valid).toBe(true);
  });

  it("requires root-cause files when scope expansion is active", () => {
    const result = validateDeterministicPlan(
      {
        plan: [
          {
            goal: "Fix config defaults",
            key_files: ["src/config/defaults.ts"],
          },
        ],
      },
      {
        requiredScopeFiles: [
          "src/config/schema.ts",
          "src/config/loader.ts",
        ],
      },
    );

    expect(result.valid).toBe(false);
    expect(
      result.issues.some(
        (issue) => issue.guard === "scope_viability_required_files",
      ),
    ).toBe(true);
  });

  it("accepts expanded plans that include all required root-cause files", () => {
    const result = validateDeterministicPlan(
      {
        plan: [
          {
            goal: "Repair config schema drift",
            key_files: [
              "src/config/defaults.ts",
              "src/config/schema.ts",
              "src/config/loader.ts",
            ],
          },
        ],
      },
      {
        requiredScopeFiles: [
          "src/config/schema.ts",
          "src/config/loader.ts",
        ],
      },
    );

    expect(result.valid).toBe(true);
  });

  it("removes verification-only steps even when they list concrete files", () => {
    const planData = {
      plan: [
        {
          goal: "Fix mock event schema",
          key_files: ["src/__tests__/batched-writer.test.ts"],
        },
        {
          goal: "Verify all fixes by running the test suite",
          key_files: ["src/__tests__/batched-writer.test.ts"],
        },
      ],
    };

    sanitizeVerificationOnlySteps(planData);

    expect(planData.plan).toHaveLength(1);
    expect(planData.plan[0].goal).toBe("Fix mock event schema");
  });

  it("keeps implementation steps that add regression tests", () => {
    const planData = {
      plan: [
        {
          goal: "Add regression test for mock event schema",
          key_files: ["src/__tests__/batched-writer.test.ts"],
        },
      ],
    };

    sanitizeVerificationOnlySteps(planData);

    expect(planData.plan).toHaveLength(1);
  });
});
