import { describe, expect, it } from "vitest";
import {
  enforceRequiredScopeFilesInPlan,
  extractTargetedBaselineCompileFiles,
  repairScopeExpandedPlan,
  repairTargetedScopePlan,
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

  it("allows deterministic scope expansion root files for baseline compile-error tasks", () => {
    const result = validateDeterministicPlan(
      {
        plan: [
          {
            goal: "Fix test and shared config root cause",
            key_files: [
              "src/__tests__/config-loader.test.ts",
              "src/config/defaults.ts",
              "src/config/loader.ts",
              "src/config/schema.ts",
              "src/types/index.ts",
              "src/types/logEvent.ts",
            ],
          },
        ],
      },
      {
        taskTitle:
          "Fix baseline compile errors in src/__tests__/config-loader.test.ts",
        requiredScopeFiles: [
          "src/config/defaults.ts",
          "src/config/loader.ts",
          "src/config/schema.ts",
          "src/types/index.ts",
          "src/types/logEvent.ts",
        ],
      },
    );

    expect(result.valid).toBe(true);
  });

  it("still rejects unrelated files during baseline scope expansion", () => {
    const result = validateDeterministicPlan(
      {
        plan: [
          {
            goal: "Fix test, root cause, and unrelated UI",
            key_files: [
              "src/__tests__/config-loader.test.ts",
              "src/config/loader.ts",
              "src/settings-panel.tsx",
            ],
          },
        ],
      },
      {
        taskTitle:
          "Fix baseline compile errors in src/__tests__/config-loader.test.ts",
        requiredScopeFiles: ["src/config/loader.ts"],
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

  it("deterministically repairs scope-expanded plans missing root-cause files", () => {
    const planData = {
      plan: [
        {
          goal: "Add missing properties to the Config interface and schema",
          key_files: ["src/config/index.ts", "src/config/schema.ts"],
          dependencies: [],
          acceptance_criteria: ["Schema includes corresponding fields"],
        },
        {
          goal: "Fix test file imports for missing Config properties",
          key_files: ["src/__tests__/config.test.ts"],
          dependencies: ["step_1"],
        },
      ],
    };

    const requiredScopeFiles = [
      "src/config/defaults.ts",
      "src/types/index.ts",
      "src/types/logEvent.ts",
    ];

    const beforeRepair = validateDeterministicPlan(planData, {
      requiredScopeFiles,
    });
    expect(beforeRepair.valid).toBe(false);

    const repair = enforceRequiredScopeFilesInPlan(
      planData,
      requiredScopeFiles,
    );
    expect(repair.changed).toBe(true);
    expect(repair.addedFiles).toEqual(requiredScopeFiles);
    expect(repair.targetStepIndex).toBe(0);

    expect(planData.plan[0].key_files).toEqual([
      "src/config/index.ts",
      "src/config/schema.ts",
      "src/config/defaults.ts",
      "src/types/index.ts",
      "src/types/logEvent.ts",
    ]);
    expect(planData.plan[1].dependencies).toEqual(["step_1"]);

    const afterRepair = validateDeterministicPlan(planData, {
      requiredScopeFiles,
    });
    expect(afterRepair.valid).toBe(true);
  });

  it("does not repair scope plans when required files are already present", () => {
    const planData = {
      plan: [
        {
          goal: "Repair shared config and type roots",
          key_files: ["src/config/defaults.ts", "src/types/index.ts"],
        },
      ],
    };

    const repair = enforceRequiredScopeFilesInPlan(planData, [
      "src/config/defaults.ts",
      "src/types/index.ts",
    ]);

    expect(repair.changed).toBe(false);
    expect(planData.plan[0].key_files).toEqual([
      "src/config/defaults.ts",
      "src/types/index.ts",
    ]);
  });

  it("repairs scope-expanded plans by removing out-of-scope files and adding required roots", () => {
    const planData = {
      plan: [
        {
          goal: "Repair shared config roots",
          key_files: [
            "src/__tests__/config-loader.test.ts",
            "src/types/index.ts",
            "src/types/logEvent.ts",
            "src/settings-panel.tsx",
          ],
        },
      ],
    };
    const requiredScopeFiles = [
      "src/config/defaults.ts",
      "src/config/loader.ts",
      "src/config/schema.ts",
      "src/types/index.ts",
      "src/types/logEvent.ts",
    ];

    const beforeRepair = validateDeterministicPlan(planData, {
      taskTitle:
        "Fix baseline compile errors in src/__tests__/config-loader.test.ts",
      requiredScopeFiles,
    });
    expect(beforeRepair.valid).toBe(false);
    expect(beforeRepair.issues.map((issue) => issue.guard)).toEqual([
      "scope_viability_required_files",
      "targeted_task_scope",
    ]);

    const repair = repairScopeExpandedPlan(
      planData,
      requiredScopeFiles,
      beforeRepair.issues,
    );

    expect(repair.changed).toBe(true);
    expect(repair.removedFiles).toEqual(["src/settings-panel.tsx"]);
    expect(repair.addedFiles).toEqual([
      "src/config/defaults.ts",
      "src/config/loader.ts",
      "src/config/schema.ts",
    ]);
    expect(repair.rootStageFiles).toEqual(requiredScopeFiles);
    expect(planData.plan[0].key_files).toEqual([
      "src/config/defaults.ts",
      "src/config/loader.ts",
      "src/config/schema.ts",
      "src/types/index.ts",
      "src/types/logEvent.ts",
    ]);
    expect(planData.plan[0].goal).toContain("root-cause");
    expect(planData.plan[1].key_files).toEqual([
      "src/__tests__/config-loader.test.ts",
    ]);

    const afterRepair = validateDeterministicPlan(planData, {
      taskTitle:
        "Fix baseline compile errors in src/__tests__/config-loader.test.ts",
      requiredScopeFiles,
    });
    expect(afterRepair.valid).toBe(true);
  });

  it("turns downstream-first scope-expanded plans into a root-cause-first stage", () => {
    const planData = {
      plan: [
        {
          goal:
            "Fix all compile errors in src/__tests__/config-loader.test.ts by removing references to non-existent Config properties",
          key_files: ["src/__tests__/config-loader.test.ts"],
          acceptance_criteria: ["Config-loader test compiles"],
        },
        {
          goal:
            "Fix type assertions in config-loader.test.ts by removing references to non-existent properties",
          key_files: ["src/__tests__/config-loader.test.ts"],
          acceptance_criteria: ["Assertions use real Config properties"],
        },
      ],
    };
    const requiredScopeFiles = [
      "src/config/defaults.ts",
      "src/config/loader.ts",
      "src/config/schema.ts",
      "src/types/index.ts",
      "src/types/logEvent.ts",
    ];

    const beforeRepair = validateDeterministicPlan(planData, {
      taskTitle:
        "Fix baseline compile errors in src/__tests__/config-loader.test.ts",
      requiredScopeFiles,
    });
    expect(beforeRepair.valid).toBe(false);

    const repair = repairScopeExpandedPlan(
      planData,
      requiredScopeFiles,
      beforeRepair.issues,
    );

    expect(repair.changed).toBe(true);
    expect(planData.plan).toHaveLength(2);
    expect(planData.plan[0].goal).toContain("root-cause");
    expect(planData.plan[0].key_files).toEqual(requiredScopeFiles);
    expect(planData.plan[1].key_files).toEqual([
      "src/__tests__/config-loader.test.ts",
    ]);
    expect(planData.plan[1].dependencies).toEqual(["Step 1"]);

    const afterRepair = validateDeterministicPlan(planData, {
      taskTitle:
        "Fix baseline compile errors in src/__tests__/config-loader.test.ts",
      requiredScopeFiles,
    });
    expect(afterRepair.valid).toBe(true);
  });

  it("clamps a premature root-cause plan down to the targeted file in phase 1", () => {
    const taskTitle =
      "Fix baseline compile errors in src/utils/logEventNormalizer.ts";
    const planData = {
      plan: [
        {
          goal: "Repair shared LogEvent type definitions",
          key_files: ["src/types/logEvent.ts", "src/types/index.ts"],
        },
        {
          goal: "Update the normalizer against the repaired types",
          key_files: [
            "src/utils/logEventNormalizer.ts",
            "src/config/retention-engine.ts",
          ],
        },
      ],
    };

    const beforeRepair = validateDeterministicPlan(planData, {
      taskTitle,
      requiredScopeFiles: [],
    });
    expect(beforeRepair.valid).toBe(false);
    expect(
      beforeRepair.issues.some(
        (issue) => issue.guard === "targeted_task_scope",
      ),
    ).toBe(true);

    const clamp = repairTargetedScopePlan(
      planData,
      extractTargetedBaselineCompileFiles(taskTitle),
      beforeRepair.issues,
    );

    expect(clamp.changed).toBe(true);
    expect(clamp.clampedToTargets).toBe(true);
    const remainingFiles = planData.plan.flatMap((step: any) => step.key_files);
    expect(remainingFiles).toEqual(["src/utils/logEventNormalizer.ts"]);

    const afterRepair = validateDeterministicPlan(planData, {
      taskTitle,
      requiredScopeFiles: [],
    });
    expect(afterRepair.valid).toBe(true);
  });

  it("collapses to a single targeted step when every planned step is out of scope", () => {
    const taskTitle =
      "Fix baseline compile errors in src/utils/logEventNormalizer.ts";
    const planData = {
      plan: [
        {
          goal: "Repair shared LogEvent type definitions",
          key_files: ["src/types/logEvent.ts"],
          owners: ["type-owner"],
        },
        {
          goal: "Repair index barrel",
          key_files: ["src/types/index.ts"],
        },
      ],
    };

    const beforeRepair = validateDeterministicPlan(planData, {
      taskTitle,
      requiredScopeFiles: [],
    });
    const clamp = repairTargetedScopePlan(
      planData,
      extractTargetedBaselineCompileFiles(taskTitle),
      beforeRepair.issues,
    );

    expect(clamp.clampedToTargets).toBe(true);
    expect(planData.plan).toHaveLength(1);
    expect(planData.plan[0].key_files).toEqual([
      "src/utils/logEventNormalizer.ts",
    ]);
    expect(planData.plan[0].owners).toEqual(["type-owner"]);

    const afterRepair = validateDeterministicPlan(planData, {
      taskTitle,
      requiredScopeFiles: [],
    });
    expect(afterRepair.valid).toBe(true);
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
