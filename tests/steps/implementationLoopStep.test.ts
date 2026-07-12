import { describe, it, expect, beforeEach, vi } from "vitest";
import path from "path";
import fs from "fs/promises";
import { execSync } from "child_process";
import { makeTempRepo } from "../makeTempRepo.js";
import { WorkflowContext } from "../../src/workflows/engine/WorkflowContext.js";
import { ImplementationLoopStep } from "../../src/workflows/steps/ImplementationLoopStep.js";
import * as persona from "../../src/agents/persona.js";
import { templateLoader } from "../../src/workflows/engine/TemplateLoader.js";

vi.mock("../../src/agents/persona.js", async () => {
  const actual = await vi.importActual<any>(
    "../../src/agents/persona.js",
  );
  return {
    ...actual,
    sendPersonaRequest: vi.fn().mockResolvedValue("corr-1"),
    waitForPersonaCompletion: vi.fn().mockResolvedValue({
      id: "event-1",
      fields: {
        result: JSON.stringify({ output: "" }),
      },
    }),
    interpretPersonaStatus: vi.fn().mockReturnValue({
      status: "pass",
      details: "",
      raw: "",
    }),
  };
});

vi.mock("../../src/logger.js", () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
}));

describe("ImplementationLoopStep", () => {
  let repoRoot: string;
  let context: WorkflowContext;
  const transport: any = {};

  beforeEach(async () => {
    repoRoot = await makeTempRepo();

    const workflowConfig = {
      name: "test-workflow",
      version: "1.0.0",
      steps: [],
    };

    context = new WorkflowContext(
      "wf-impl-loop-01",
      "proj-1",
      repoRoot,
      "milestone/foundation",
      workflowConfig,
      transport,
      {},
    );

    context.setVariable("SKIP_PERSONA_OPERATIONS", false);
    context.setVariable("SKIP_GIT_OPERATIONS", false);
    context.setVariable("repo_remote", "git@github.com:test/repo.git");
    context.setVariable("task", { id: 1, name: "Sample Task" });
    context.setVariable("taskName", "Sample Task");
    context.setVariable("projectId", "proj-1");
    context.setVariable("planning_loop_plan_files", [
      ".example.env",
      "src/config/validator.js",
    ]);
    context.setVariable("plan_required_files", [
      ".example.env",
      "src/config/validator.js",
    ]);

    context.setStepOutput("record_plan_key_files", {
      key_files: [".example.env", "src/config/validator.js"],
      missing_files: ["src/config/validator.js"],
    });
    context.setStepOutput("planning_loop", {
      plan_result: {
        fields: {
          result: JSON.stringify({
            plan: [
              {
                goal: "Add validator",
                key_files: [".example.env", "src/config/validator.js"],
              },
            ],
          }),
        },
      },
    });

    vi.mocked(persona.sendPersonaRequest).mockClear();
    vi.mocked(persona.waitForPersonaCompletion).mockClear();
    vi.mocked(persona.interpretPersonaStatus).mockClear();
    templateLoader.load();
  });

  const buildDiff = (relativePath: string, contents: string) => {
    const lines = contents.trimEnd().split("\n");
    const additions = lines.map((line) => `+${line}`).join("\n");
    return `\`\`\`diff\n--- /dev/null\n+++ b/${relativePath}\n@@ -0,0 +${lines.length} @@\n${additions}\n\`\`\``;
  };

  const buildReplaceDiff = (
    relativePath: string,
    oldContents: string,
    newContents: string,
  ) => {
    const oldLines = oldContents.trimEnd().split("\n");
    const newLines = newContents.trimEnd().split("\n");
    const removals = oldLines.map((line) => `-${line}`).join("\n");
    const additions = newLines.map((line) => `+${line}`).join("\n");
    return `\`\`\`diff\n--- a/${relativePath}\n+++ b/${relativePath}\n@@ -1,${oldLines.length} +1,${newLines.length} @@\n${removals}\n${additions}\n\`\`\``;
  };

  const buildFileBlock = (relativePath: string, contents: string) =>
    `\`\`\`file path=${relativePath}\n${contents.trimEnd()}\n\`\`\``;

  it("rejects scope-expanded attempts that omit root-cause files", () => {
    context.setVariable("scope_viability_status", "requires_scope_expansion");
    context.setVariable("scope_viability_root_cause_files", [
      "src/config/schema.ts",
      "src/config/defaults.ts",
    ]);

    const step = new ImplementationLoopStep({
      name: "implementation_loop",
      type: "ImplementationLoopStep",
      config: {},
    });

    const errors = (step as any).evaluateScopeRootCauseTouchGate(
      context,
      ["src/__tests__/config-loader.test.ts"],
      [
        "src/__tests__/config-loader.test.ts",
        "src/config/schema.ts",
        "src/config/defaults.ts",
      ],
    );

    expect(errors).toHaveLength(1);
    expect(errors[0].file).toBe("__scope_viability__");
    expect(errors[0].reason).toContain("must edit at least one root-cause file");
  });

  it("allows scope-expanded attempts that touch a root-cause file", () => {
    context.setVariable("scope_viability_status", "requires_scope_expansion");
    context.setVariable("scope_viability_root_cause_files", [
      "src/config/schema.ts",
    ]);

    const step = new ImplementationLoopStep({
      name: "implementation_loop",
      type: "ImplementationLoopStep",
      config: {},
    });

    const errors = (step as any).evaluateScopeRootCauseTouchGate(
      context,
      ["src/config/schema.ts", "src/__tests__/config-loader.test.ts"],
      ["src/config/schema.ts", "src/__tests__/config-loader.test.ts"],
    );

    expect(errors).toEqual([]);
  });

  it("retries on persona request failure then succeeds", async () => {
    let callCount = 0;

    vi.mocked(persona.interpretPersonaStatus).mockImplementation(() => {
      callCount++;
      if (callCount === 1) {
        return { status: "unknown", details: "malformed response", raw: "" };
      }
      return { status: "pass", details: "", raw: "" };
    });

    const allDiffs = buildDiff(
      ".example.env",
      ["LOG_LEVEL=info"].join("\n"),
    ) +
      "\n" +
      buildDiff(
        "src/config/validator.js",
        ["export const validator = () => true;"].join("\n"),
      );

    vi.mocked(persona.waitForPersonaCompletion).mockResolvedValue({
      id: "event-retry",
      fields: {
        result: JSON.stringify({ status: "pass", output: allDiffs }),
      },
    });

    const step = new ImplementationLoopStep({
      name: "implementation_loop",
      type: "ImplementationLoopStep",
      config: {
        maxAttempts: 3,
        planGuard: {
          plan_step: "planning_loop",
          plan_files_variable: "planning_loop_plan_files",
          additional_files: [".example.env", "src/config/validator.js"],
        },
      },
    });

    const result = await step.execute(context);
    expect(result.status, result.error?.message).toBe("success");
    expect(context.getVariable("implementation_attempts")).toBe(2);
  });

  it("retries implementation until guard passes", async () => {
    const personaDiffs = [
      buildDiff(
        ".example.env",
        [
          "# Example configuration",
          "LOG_LEVEL=info",
          "LOG_FILE_PATH=./logs/app.log",
        ].join("\n"),
      ),
      buildDiff(
        "src/config/validator.js",
        [
          "export const validator = () => {",
          "  return true;",
          "};",
        ].join("\n"),
      ) +
        "\n" +
        buildDiff(
          ".example.env",
          [
            "# Example configuration",
            "LOG_LEVEL=info",
            "LOG_FILE_PATH=./logs/app.log",
          ].join("\n"),
        ),
    ];

    vi.mocked(persona.waitForPersonaCompletion).mockImplementation(async () => ({
      id: `event-${personaDiffs.length}`,
      fields: {
        result: JSON.stringify({
          status: "pass",
          output: personaDiffs.shift() ?? "",
        }),
      },
    }));

    const step = new ImplementationLoopStep({
      name: "implementation_loop",
      type: "ImplementationLoopStep",
      config: {
        maxAttempts: 3,
        planGuard: {
          plan_step: "planning_loop",
          plan_files_variable: "planning_loop_plan_files",
          additional_files: [".example.env", "src/config/validator.js"],
        },
      },
    });

    const result = await step.execute(context);
    expect(result.status).toBe("success");
    expect(context.getVariable("implementation_attempts")).toBe(2);

    const envContent = await fs.readFile(
      path.join(repoRoot, ".example.env"),
      "utf-8",
    );
    expect(envContent).toContain("LOG_LEVEL=info");

    const validatorContent = await fs.readFile(
      path.join(repoRoot, "src/config/validator.js"),
      "utf-8",
    );
    expect(validatorContent).toContain("export const validator");
    expect(context.getVariable("implementation_guard_missing_files")).toEqual([]);
  });

  it("retries when a validated attempt rewrites an unchanged file", async () => {
    const defaultsPath = path.join(repoRoot, "src/config/defaults.ts");
    const contents = "export const defaults = { level: 'info' };\n";
    await fs.mkdir(path.join(repoRoot, "src/config"), { recursive: true });
    await fs.writeFile(defaultsPath, contents, "utf-8");
    await fs.writeFile(
      path.join(repoRoot, "package.json"),
      JSON.stringify({
        scripts: {
          typecheck:
            "node -e \"console.error('src/config/defaults.ts(1,1): error TS9999: Defaults are stale.'); process.exit(2);\"",
        },
      }),
      "utf-8",
    );
    execSync("git add .", { cwd: repoRoot });
    execSync("git commit --no-verify -m baseline-defaults", { cwd: repoRoot });

    context.setVariable("planning_loop_plan_files", ["src/config/defaults.ts"]);
    context.setVariable("plan_required_files", ["src/config/defaults.ts"]);
    context.setStepOutput("record_plan_key_files", {
      key_files: ["src/config/defaults.ts"],
      missing_files: [],
    });
    context.setStepOutput("planning_loop", {
      plan_result: {
        fields: {
          result: JSON.stringify({
            plan: [
              {
                goal: "Update stale defaults",
                key_files: ["src/config/defaults.ts"],
              },
            ],
          }),
        },
      },
    });

    const personaDiffs = [
      buildFileBlock("src/config/defaults.ts", contents),
      buildFileBlock(
        "src/config/defaults.ts",
        "export const defaults = { level: 'debug' };\n",
      ),
    ];

    vi.mocked(persona.waitForPersonaCompletion).mockImplementation(async () => ({
      id: `event-${personaDiffs.length}`,
      fields: {
        result: JSON.stringify({
          status: "pass",
          output: personaDiffs.shift() ?? "",
        }),
      },
    }));

    const step = new ImplementationLoopStep({
      name: "implementation_loop",
      type: "ImplementationLoopStep",
      config: {
        maxAttempts: 3,
        planGuard: {
          plan_step: "planning_loop",
          plan_files_variable: "planning_loop_plan_files",
          additional_files: ["src/config/defaults.ts"],
        },
      },
    });

    const result = await step.execute(context);
    expect(result.status, result.error?.message).toBe("success");
    expect(context.getVariable("implementation_attempts")).toBe(2);

    const defaultsContent = await fs.readFile(defaultsPath, "utf-8");
    expect(defaultsContent).toContain("level: 'debug'");
  });

  it("fails fast when the same no-op rewrite repeats", async () => {
    const defaultsPath = path.join(repoRoot, "src/config/defaults.ts");
    const contents = "export const defaults = { level: 'info' };\n";
    await fs.mkdir(path.join(repoRoot, "src/config"), { recursive: true });
    await fs.writeFile(defaultsPath, contents, "utf-8");
    await fs.writeFile(
      path.join(repoRoot, "package.json"),
      JSON.stringify({
        scripts: {
          typecheck:
            "node -e \"console.error('src/config/defaults.ts(1,1): error TS9999: Defaults are stale.'); process.exit(2);\"",
        },
      }),
      "utf-8",
    );
    execSync("git add .", { cwd: repoRoot });
    execSync("git commit --no-verify -m baseline-defaults", { cwd: repoRoot });

    context.setVariable("planning_loop_plan_files", ["src/config/defaults.ts"]);
    context.setVariable("plan_required_files", ["src/config/defaults.ts"]);
    context.setStepOutput("record_plan_key_files", {
      key_files: ["src/config/defaults.ts"],
      missing_files: [],
    });
    context.setStepOutput("planning_loop", {
      plan_result: {
        fields: {
          result: JSON.stringify({
            plan: [
              {
                goal: "Update stale defaults",
                key_files: ["src/config/defaults.ts"],
              },
            ],
          }),
        },
      },
    });

    const unchangedRewrite = buildFileBlock("src/config/defaults.ts", contents);
    vi.mocked(persona.waitForPersonaCompletion).mockResolvedValue({
      id: "event-noop",
      fields: {
        result: JSON.stringify({
          status: "pass",
          output: unchangedRewrite,
        }),
      },
    } as any);

    const step = new ImplementationLoopStep({
      name: "implementation_loop",
      type: "ImplementationLoopStep",
      config: {
        maxAttempts: 3,
        planGuard: {
          plan_step: "planning_loop",
          plan_files_variable: "planning_loop_plan_files",
          additional_files: [".example.env"],
        },
      },
    });

    const result = await step.execute(context);

    expect(result.status).toBe("failure");
    expect(result.error?.message).toContain("same no-op edit");
    expect(context.getVariable("implementation_attempts")).toBe(2);
    expect(
      context.getVariable("implementation_no_effective_change_repeated"),
    ).toBe(true);
    expect(persona.waitForPersonaCompletion).toHaveBeenCalledTimes(2);
  });

  it("rolls back failed attempts before retrying", async () => {
    const personaDiffs = [
      buildDiff(
        ".example.env",
        [
          "# Incomplete configuration",
          "LOG_LEVEL=debug",
        ].join("\n"),
      ),
      buildDiff(
        ".example.env",
        [
          "# Example configuration",
          "LOG_LEVEL=info",
          "LOG_FILE_PATH=./logs/app.log",
        ].join("\n"),
      ) +
        "\n" +
        buildDiff(
          "src/config/validator.js",
          [
          "export const validator = () => {",
          "  return true;",
          "};",
          ].join("\n"),
        ),
    ];

    vi.mocked(persona.waitForPersonaCompletion).mockImplementation(async () => ({
      id: `event-${personaDiffs.length}`,
      fields: {
        result: JSON.stringify({
          status: "pass",
          output: personaDiffs.shift() ?? "",
        }),
      },
    }));

    const step = new ImplementationLoopStep({
      name: "implementation_loop",
      type: "ImplementationLoopStep",
      config: {
        maxAttempts: 3,
        planGuard: {
          plan_step: "planning_loop",
          plan_files_variable: "planning_loop_plan_files",
          additional_files: [".example.env", "src/config/validator.js"],
        },
      },
    });

    const result = await step.execute(context);
    expect(result.status, result.error?.message).toBe("success");
    expect(context.getVariable("implementation_attempts")).toBe(2);

    const envContent = await fs.readFile(
      path.join(repoRoot, ".example.env"),
      "utf-8",
    );
    expect(envContent).toContain("LOG_LEVEL=info");

    const validatorContent = await fs.readFile(
      path.join(repoRoot, "src/config/validator.js"),
      "utf-8",
    );
    expect(validatorContent).toContain("export const validator");
    expect(context.getVariable("implementation_guard_missing_files")).toEqual([]);
  });

  it("retries forced duplicate information completions instead of applying empty diffs", async () => {
    const validDiff =
      buildDiff(
        ".example.env",
        [
          "# Example configuration",
          "LOG_LEVEL=info",
          "LOG_FILE_PATH=./logs/app.log",
        ].join("\n"),
      ) +
      "\n" +
      buildDiff(
        "src/config/validator.js",
        [
          "export const validator = () => {",
          "  return true;",
          "};",
        ].join("\n"),
      );

    vi.mocked(persona.waitForPersonaCompletion)
      .mockResolvedValueOnce({
        id: "event-forced-info",
        fields: {
          result: JSON.stringify({
            status: "complete",
            summary:
              "System forced completion after repeated duplicate information requests.",
            information_blocks: [
              "src/config/validator.js was not found; create it as a new file.",
            ],
            system_note: {
              reason:
                "forced_completion_due_to_duplicate_information_requests",
            },
          }),
        },
      } as any)
      .mockResolvedValueOnce({
        id: "event-implementation",
        fields: {
          result: JSON.stringify({
            status: "pass",
            output: validDiff,
          }),
        },
      } as any);

    const step = new ImplementationLoopStep({
      name: "implementation_loop",
      type: "ImplementationLoopStep",
      config: {
        maxAttempts: 2,
        planGuard: {
          plan_step: "planning_loop",
          plan_files_variable: "planning_loop_plan_files",
          additional_files: [".example.env", "src/config/validator.js"],
        },
      },
    });

    const result = await step.execute(context);

    expect(result.status).toBe("success");
    expect(context.getVariable("implementation_attempts")).toBe(2);
    expect(
      context.getVariable("implementation_information_request_summary"),
    ).toContain("create it as a new file");
    expect(
      context.getVariable(
        "implementation_request_force_synthesis_due_to_duplicates",
      ),
    ).toBe(false);

    const validatorContent = await fs.readFile(
      path.join(repoRoot, "src/config/validator.js"),
      "utf-8",
    );
    expect(validatorContent).toContain("export const validator");
  });

  it("rejects truncated repetitive implementation output before diff parsing", async () => {
    const repeatedLines = Array.from({ length: 280 }, (_, index) => {
      const suffix = [
        "Undefined",
        "EmptyString",
        "Null",
        "UndefinedTypeAndNull",
        "NullTypeAndEmptyString",
      ][index % 5];
      return `export const defaultsForTestWithFileExportPath${suffix}${index} = { export: { path: "" } };`;
    }).join("\n");
    const runawayOutput =
      "```file path=src/config/validator.js\n" + repeatedLines;

    const validDiff =
      buildDiff(
        ".example.env",
        [
          "# Example configuration",
          "LOG_LEVEL=info",
          "LOG_FILE_PATH=./logs/app.log",
        ].join("\n"),
      ) +
      "\n" +
      buildDiff(
        "src/config/validator.js",
        [
          "export const validator = () => {",
          "  return true;",
          "};",
        ].join("\n"),
      );

    vi.mocked(persona.waitForPersonaCompletion)
      .mockResolvedValueOnce({
        id: "event-runaway",
        fields: {
          result: JSON.stringify({
            status: "pass",
            output: runawayOutput,
            truncated: true,
          }),
        },
      } as any)
      .mockResolvedValueOnce({
        id: "event-small-patch",
        fields: {
          result: JSON.stringify({
            status: "pass",
            output: validDiff,
          }),
        },
      } as any);

    const step = new ImplementationLoopStep({
      name: "implementation_loop",
      type: "ImplementationLoopStep",
      config: {
        maxAttempts: 2,
        planGuard: {
          plan_step: "planning_loop",
          plan_files_variable: "planning_loop_plan_files",
          additional_files: [".example.env", "src/config/validator.js"],
        },
      },
    });

    const result = await step.execute(context);

    expect(result.status, result.error?.message).toBe("success");
    expect(context.getVariable("implementation_attempts")).toBe(2);
    expect(
      context.getVariable("implementation_config_validation_summary"),
    ).toBe("");

    const validatorContent = await fs.readFile(
      path.join(repoRoot, "src/config/validator.js"),
      "utf-8",
    );
    expect(validatorContent).toContain("export const validator");
  });

  it("rolls back typecheck-corrupting attempts before retrying", async () => {
    const originalTypes = [
      "export interface LogEvent {",
      "  id: string;",
      "}",
      "export interface EventMeta {",
      "  source: string;",
      "}",
    ].join("\n");
    await fs.mkdir(path.join(repoRoot, "src/types"), { recursive: true });
    await fs.writeFile(
      path.join(repoRoot, "src/types/logEvent.ts"),
      originalTypes,
      "utf-8",
    );
    await fs.writeFile(
      path.join(repoRoot, "package.json"),
      JSON.stringify({
        scripts: {
          typecheck:
            "node -e \"const fs=require('fs'); const s=fs.readFileSync('src/types/logEvent.ts','utf8'); if(!s.includes('interface LogEvent') || !s.includes('interface EventMeta')) process.exit(2);\"",
        },
      }),
      "utf-8",
    );
    await fs.writeFile(path.join(repoRoot, "tsconfig.json"), "{}", "utf-8");
    execSync("git add .", { cwd: repoRoot });
    execSync("git commit -m types", { cwd: repoRoot });

    context.setVariable("planning_loop_plan_files", ["src/types/logEvent.ts"]);
    context.setVariable("plan_required_files", ["src/types/logEvent.ts"]);
    context.setStepOutput("record_plan_key_files", {
      key_files: ["src/types/logEvent.ts"],
      missing_files: [],
    });
    context.setStepOutput("planning_loop", {
      plan_result: {
        fields: {
          result: JSON.stringify({
            plan: [
              {
                goal: "Update event query params",
                key_files: ["src/types/logEvent.ts"],
              },
            ],
          }),
        },
      },
    });

    const corruptedTypes = "export interface EventQueryParams {\n  limit?: number;\n}";
    const repairedTypes = [
      originalTypes,
      "export interface EventQueryParams {",
      "  limit?: number;",
      "}",
    ].join("\n");
    const personaDiffs = [
      buildReplaceDiff("src/types/logEvent.ts", originalTypes, corruptedTypes),
      buildReplaceDiff("src/types/logEvent.ts", originalTypes, repairedTypes),
    ];

    vi.mocked(persona.waitForPersonaCompletion).mockImplementation(async () => ({
      id: `event-${personaDiffs.length}`,
      fields: {
        result: JSON.stringify({
          status: "pass",
          output: personaDiffs.shift() ?? "",
        }),
      },
    }));

    const step = new ImplementationLoopStep({
      name: "implementation_loop",
      type: "ImplementationLoopStep",
      config: {
        maxAttempts: 2,
        planGuard: {
          plan_step: "planning_loop",
          plan_files_variable: "planning_loop_plan_files",
          additional_files: ["src/types/logEvent.ts"],
        },
      },
    });

    const result = await step.execute(context);

    expect(result.status).toBe("success");
    expect(context.getVariable("implementation_attempts")).toBe(2);
    const finalTypes = await fs.readFile(
      path.join(repoRoot, "src/types/logEvent.ts"),
      "utf-8",
    );
    expect(finalTypes).toContain("interface LogEvent");
    expect(finalTypes).toContain("interface EventMeta");
    expect(finalTypes).toContain("interface EventQueryParams");
    const commitCount = execSync("git rev-list --count HEAD", {
      cwd: repoRoot,
      encoding: "utf-8",
    }).trim();
    expect(commitCount).toBe("3");
  });

  it("retains all required and missing plan files after partial retry output", async () => {
    const originalTypes = [
      "export interface ExistingEvent {",
      "  id: string;",
      "}",
    ].join("\n");
    const updatedTypes = [
      "export interface ExistingEvent {",
      "  id: string;",
      "}",
      "export interface EventQueryParams {",
      "  limit?: number;",
      "}",
    ].join("\n");
    await fs.mkdir(path.join(repoRoot, "src/types"), { recursive: true });
    await fs.writeFile(
      path.join(repoRoot, "src/types/eventTypes.ts"),
      originalTypes,
      "utf-8",
    );
    execSync("git add .", { cwd: repoRoot });
    execSync("git commit -m event-types", { cwd: repoRoot });

    context.setVariable("planning_loop_plan_files", [
      "src/types/eventTypes.ts",
      "src/routes/events.ts",
    ]);
    context.setVariable("event_plan_files", [
      "src/types/eventTypes.ts",
      "src/routes/events.ts",
    ]);
    context.setVariable("event_plan_files", [
      "src/types/eventTypes.ts",
      "src/routes/events.ts",
    ]);
    context.setVariable("plan_required_files", [
      "src/types/eventTypes.ts",
      "src/routes/events.ts",
    ]);
    context.setStepOutput("record_plan_key_files", {
      key_files: ["src/types/eventTypes.ts", "src/routes/events.ts"],
      missing_files: ["src/routes/events.ts"],
    });
    context.setStepOutput("planning_loop", {
      plan_result: {
        fields: {
          result: JSON.stringify({
            plan: [
              {
                goal: "Add event types and route",
                key_files: ["src/types/eventTypes.ts", "src/routes/events.ts"],
              },
            ],
          }),
        },
      },
    });

    const wrongBase = "export interface InventedEvent {\n  id: string;\n}";
    vi.mocked(persona.waitForPersonaCompletion)
      .mockResolvedValueOnce({
        id: "event-stale-diff",
        fields: {
          result: JSON.stringify({
            status: "pass",
            output: buildReplaceDiff(
              "src/types/eventTypes.ts",
              wrongBase,
              updatedTypes,
            ),
          }),
        },
      } as any)
      .mockResolvedValueOnce({
        id: "event-partial-retry",
        fields: {
          result: JSON.stringify({
            status: "pass",
            output: buildFileBlock("src/types/eventTypes.ts", updatedTypes),
          }),
        },
      } as any);

    const step = new ImplementationLoopStep({
      name: "implementation_loop",
      type: "ImplementationLoopStep",
      config: {
        maxAttempts: 2,
        planGuard: {
          plan_step: "planning_loop",
          plan_files_variable: "event_plan_files",
          additional_files: ["src/types/eventTypes.ts", "src/routes/events.ts"],
        },
      },
    });

    const result = await step.execute(context);

    expect(result.status).toBe("failure");
    expect(context.getVariable("implementation_required_files")).toEqual([
      "src/types/eventTypes.ts",
      "src/routes/events.ts",
    ]);
    expect(context.getVariable("implementation_missing_plan_files")).toEqual([
      "src/routes/events.ts",
    ]);
    expect(
      context.getVariable("implementation_missing_plan_files_summary"),
    ).toBe("src/routes/events.ts");
    expect(context.getVariable("implementation_prefer_full_file")).toBe(true);
  });

  it("rejects partial output for still-missing plan files before applying edits", async () => {
    const partialEnv = [
      "LOG_LEVEL=debug",
      "PARTIAL_MARKER=true",
    ].join("\n");
    const finalEnv = [
      "LOG_LEVEL=info",
      "LOG_FILE_PATH=./logs/app.log",
      "FINAL_MARKER=true",
    ].join("\n");
    const validator = [
      "export const validator = () => {",
      "  return true;",
      "};",
    ].join("\n");

    vi.mocked(persona.waitForPersonaCompletion)
      .mockResolvedValueOnce({
        id: "event-partial",
        fields: {
          result: JSON.stringify({
            status: "pass",
            output: buildFileBlock(".example.env", partialEnv),
          }),
        },
      } as any)
      .mockResolvedValueOnce({
        id: "event-complete",
        fields: {
          result: JSON.stringify({
            status: "pass",
            output:
              buildFileBlock(".example.env", finalEnv) +
              "\n" +
              buildFileBlock("src/config/validator.js", validator),
          }),
        },
      } as any);

    const step = new ImplementationLoopStep({
      name: "implementation_loop",
      type: "ImplementationLoopStep",
      config: {
        maxAttempts: 2,
        planGuard: {
          plan_step: "planning_loop",
          plan_files_variable: "planning_loop_plan_files",
          additional_files: [".example.env", "src/config/validator.js"],
        },
      },
    });

    const result = await step.execute(context);

    expect(result.status, result.error?.message).toBe("success");
    expect(context.getVariable("implementation_attempts")).toBe(2);
    const envContent = await fs.readFile(
      path.join(repoRoot, ".example.env"),
      "utf-8",
    );
    expect(envContent).toContain("FINAL_MARKER=true");
    expect(envContent).not.toContain("PARTIAL_MARKER=true");
    await expect(
      fs.access(path.join(repoRoot, "src/config/validator.js")),
    ).resolves.toBeUndefined();
  });

  it("ignores parsed typecheck errors outside touched and plan files", async () => {
    await fs.writeFile(
      path.join(repoRoot, "package.json"),
      JSON.stringify({
        scripts: {
          typecheck:
            "node -e \"console.error('src/utils/pathExtractor.ts(10,5): error TS2304: Cannot find name MissingType.'); process.exit(2);\"",
        },
      }),
      "utf-8",
    );
    execSync("git add .", { cwd: repoRoot });
    execSync("git commit -m package", { cwd: repoRoot });

    const allDiffs =
      buildDiff(
        ".example.env",
        ["LOG_LEVEL=info", "LOG_FILE_PATH=./logs/app.log"].join("\n"),
      ) +
      "\n" +
      buildDiff(
        "src/config/validator.js",
        [
          "export const validator = () => {",
          "  return true;",
          "};",
        ].join("\n"),
      );

    vi.mocked(persona.waitForPersonaCompletion).mockResolvedValue({
      id: "event-unrelated-typecheck",
      fields: {
        result: JSON.stringify({
          status: "pass",
          output: allDiffs,
        }),
      },
    });

    const step = new ImplementationLoopStep({
      name: "implementation_loop",
      type: "ImplementationLoopStep",
      config: {
        maxAttempts: 1,
        planGuard: {
          plan_step: "planning_loop",
          plan_files_variable: "planning_loop_plan_files",
          additional_files: [".example.env", "src/config/validator.js"],
        },
      },
    });

    const result = await step.execute(context);

    expect(result.status).toBe("success");
    expect(context.getVariable("implementation_typecheck_validation_errors")).toEqual([]);
    const preexistingSummary = context.getVariable(
      "implementation_typecheck_preexisting_summary",
    ) as string;
    expect(preexistingSummary).toContain("src/utils/pathExtractor.ts");
  });

  it("caps relevant typecheck diagnostics before rendering retry feedback", async () => {
    const longMessage = "X".repeat(500);
    const script =
      "node -e \"if(!require('fs').existsSync('src/config/validator.js'))process.exit(0); for(let i=1;i<=12;i++) console.error('src/config/validator.js('+i+',1): error TS2304: Cannot find name " +
      longMessage +
      "'); process.exit(2);\"";
    await fs.writeFile(
      path.join(repoRoot, "package.json"),
      JSON.stringify({ scripts: { typecheck: script } }),
      "utf-8",
    );
    execSync("git add .", { cwd: repoRoot });
    execSync("git commit -m package", { cwd: repoRoot });

    vi.mocked(persona.waitForPersonaCompletion).mockResolvedValue({
      id: "event-relevant-typecheck",
      fields: {
        result: JSON.stringify({
          status: "pass",
          output: buildDiff(
            "src/config/validator.js",
            [
              "export const validator = () => {",
              "  return true;",
              "};",
            ].join("\n"),
          ),
        }),
      },
    });

    const step = new ImplementationLoopStep({
      name: "implementation_loop",
      type: "ImplementationLoopStep",
      config: {
        maxAttempts: 1,
        planGuard: {
          plan_step: "planning_loop",
          plan_files_variable: "planning_loop_plan_files",
          additional_files: [".example.env", "src/config/validator.js"],
        },
      },
    });

    const result = await step.execute(context);

    expect(result.status).toBe("failure");
    const compactErrors = context.getVariable(
      "implementation_config_validation_errors",
    ) as Array<{ file: string; reason: string }>;
    const fullErrors = context.getVariable(
      "implementation_config_validation_errors_full",
    ) as Array<{ file: string; reason: string }>;
    const summary = context.getVariable(
      "implementation_config_validation_summary",
    ) as string;

    expect(fullErrors.length).toBe(12);
    expect(compactErrors.length).toBeLessThanOrEqual(3);
    expect(summary.length).toBeLessThanOrEqual(6500);
    expect(summary).toContain("additional diagnostic(s) omitted");
    expect(summary).not.toContain(longMessage);
  });

  it("fails after exhausting attempts when files remain missing", async () => {
    const personaDiffs = [
      buildDiff(
        ".example.env",
        [
          "LOG_LEVEL=info",
          "LOG_FILE_PATH=./logs/app.log",
        ].join("\n"),
      ),
      buildDiff(
        ".example.env",
        [
          "LOG_LEVEL=debug",
          "LOG_FILE_PATH=./logs/app.log",
        ].join("\n"),
      ),
      buildDiff(
        ".example.env",
        [
          "LOG_LEVEL=warn",
          "LOG_FILE_PATH=./logs/app.log",
        ].join("\n"),
      ),
    ];

    vi.mocked(persona.waitForPersonaCompletion).mockImplementation(async () => ({
      id: `event-${personaDiffs.length}`,
      fields: {
        result: JSON.stringify({
          status: "pass",
          output: personaDiffs.shift() ?? "",
        }),
      },
    }));

    const step = new ImplementationLoopStep({
      name: "implementation_loop",
      type: "ImplementationLoopStep",
      config: {
        maxAttempts: 3,
        planGuard: {
          plan_step: "planning_loop",
          plan_files_variable: "planning_loop_plan_files",
          additional_files: [".example.env", "src/config/validator.js"],
        },
      },
    });

    const result = await step.execute(context);
    expect(result.status).toBe("failure");
    expect(result.error?.message).toContain("missing plan files:");
    expect(context.getVariable("implementation_attempts")).toBe(3);
    expect(
      context.getVariable("implementation_guard_missing_files"),
    ).toEqual(["src/config/validator.js"]);
    await expect(
      fs.access(path.join(repoRoot, "src/config/validator.js")),
    ).rejects.toThrow();
  });

  it("rolls back the final failed attempt so later stages see no residue", async () => {
    const script =
      "node -e \"const fs=require('fs'); if(!fs.existsSync('src/config/validator.js'))process.exit(0); const s=fs.readFileSync('src/config/validator.js','utf8'); if(s.includes('MARKER_A')){console.error('src/config/validator.js(1,1): error TS2304: Cannot find name MarkerA.'); process.exit(2);}\"";
    await fs.writeFile(
      path.join(repoRoot, "package.json"),
      JSON.stringify({ scripts: { typecheck: script } }),
      "utf-8",
    );
    execSync("git add .", { cwd: repoRoot });
    execSync("git commit -m package", { cwd: repoRoot });

    const badDiff =
      buildDiff(".example.env", ["LOG_LEVEL=info"].join("\n")) +
      "\n" +
      buildDiff(
        "src/config/validator.js",
        "export const validator = 'MARKER_A';",
      );
    vi.mocked(persona.waitForPersonaCompletion).mockResolvedValue({
      id: "event-bad",
      fields: {
        result: JSON.stringify({ status: "pass", output: badDiff }),
      },
    } as any);

    const step = new ImplementationLoopStep({
      name: "implementation_loop",
      type: "ImplementationLoopStep",
      config: {
        maxAttempts: 2,
        planGuard: {
          plan_step: "planning_loop",
          plan_files_variable: "planning_loop_plan_files",
          additional_files: [".example.env", "src/config/validator.js"],
        },
      },
    });

    const result = await step.execute(context);

    expect(result.status).toBe("failure");
    await expect(
      fs.access(path.join(repoRoot, "src/config/validator.js")),
    ).rejects.toThrow();
    await expect(
      fs.access(path.join(repoRoot, ".example.env")),
    ).rejects.toThrow();
    const gitStatus = execSync("git status --porcelain", {
      cwd: repoRoot,
      encoding: "utf-8",
    }).trim();
    expect(gitStatus).toBe("");
  });

  it("stops scope-expanded plans after a failed root-cause stage", async () => {
    context.setVariable("scope_viability_status", "requires_scope_expansion");
    context.setVariable("scope_viability_root_cause_files", [".example.env"]);
    context.setVariable("planning_loop_plan_files", [
      ".example.env",
      "src/config/validator.js",
      "src/later.js",
    ]);
    context.setVariable("plan_required_files", [
      ".example.env",
      "src/config/validator.js",
      "src/later.js",
    ]);
    context.setStepOutput("record_plan_key_files", {
      key_files: [".example.env", "src/config/validator.js", "src/later.js"],
      missing_files: ["src/config/validator.js", "src/later.js"],
    });
    context.setStepOutput("planning_loop", {
      plan_result: {
        fields: {
          result: JSON.stringify({
            plan: [
              {
                goal: "Repair root cause",
                key_files: [".example.env", "src/config/validator.js"],
              },
              {
                goal: "Apply downstream cleanup",
                key_files: ["src/later.js"],
              },
            ],
          }),
        },
      },
    });

    vi.mocked(persona.waitForPersonaCompletion).mockResolvedValue({
      id: "event-stage-one",
      fields: {
        result: JSON.stringify({
          status: "pass",
          output: buildDiff(".example.env", ["LOG_LEVEL=info"].join("\n")),
        }),
      },
    } as any);

    const step = new ImplementationLoopStep({
      name: "implementation_loop",
      type: "ImplementationLoopStep",
      config: {
        maxAttempts: 1,
        continueOnStageFailure: true,
        planGuard: {
          plan_step: "planning_loop",
          plan_files_variable: "planning_loop_plan_files",
          additional_files: [
            ".example.env",
            "src/config/validator.js",
            "src/later.js",
          ],
        },
      },
    });

    const result = await step.execute(context);

    expect(result.status).toBe("failure");
    expect(result.error?.message).toContain("missing plan files:");
    expect(persona.waitForPersonaCompletion).toHaveBeenCalledTimes(1);
    await expect(
      fs.access(path.join(repoRoot, "src/later.js")),
    ).rejects.toThrow();
    const gitStatus = execSync("git status --porcelain", {
      cwd: repoRoot,
      encoding: "utf-8",
    }).trim();
    expect(gitStatus).toBe("");
  });

  it("grants a bonus attempt while validation errors keep changing", async () => {
    const script =
      "node -e \"const fs=require('fs'); if(!fs.existsSync('src/config/validator.js'))process.exit(0); const s=fs.readFileSync('src/config/validator.js','utf8'); if(s.includes('MARKER_A')){console.error('src/config/validator.js(1,1): error TS2304: Cannot find name MarkerA.'); process.exit(2);} if(s.includes('MARKER_B')){console.error('src/config/validator.js(1,1): error TS2304: Cannot find name MarkerB.'); process.exit(2);}\"";
    await fs.writeFile(
      path.join(repoRoot, "package.json"),
      JSON.stringify({ scripts: { typecheck: script } }),
      "utf-8",
    );
    execSync("git add .", { cwd: repoRoot });
    execSync("git commit -m package", { cwd: repoRoot });

    const envDiff = buildDiff(".example.env", ["LOG_LEVEL=info"].join("\n"));
    const personaDiffs = [
      envDiff +
        "\n" +
        buildDiff(
          "src/config/validator.js",
          "export const validator = 'MARKER_A';",
        ),
      envDiff +
        "\n" +
        buildDiff(
          "src/config/validator.js",
          "export const validator = 'MARKER_B';",
        ),
      envDiff +
        "\n" +
        buildDiff(
          "src/config/validator.js",
          "export const validator = () => true;",
        ),
    ];

    vi.mocked(persona.waitForPersonaCompletion).mockImplementation(
      async () => ({
        id: `event-${personaDiffs.length}`,
        fields: {
          result: JSON.stringify({
            status: "pass",
            output: personaDiffs.shift() ?? "",
          }),
        },
      }),
    );

    const step = new ImplementationLoopStep({
      name: "implementation_loop",
      type: "ImplementationLoopStep",
      config: {
        maxAttempts: 2,
        planGuard: {
          plan_step: "planning_loop",
          plan_files_variable: "planning_loop_plan_files",
          additional_files: [".example.env", "src/config/validator.js"],
        },
      },
    });

    const result = await step.execute(context);

    expect(result.status, result.error?.message).toBe("success");
    expect(context.getVariable("implementation_attempts")).toBe(3);
    const validatorContent = await fs.readFile(
      path.join(repoRoot, "src/config/validator.js"),
      "utf-8",
    );
    expect(validatorContent).toContain("() => true");
  });

  it("completes a stage without a commit when a no-op rewrite has no outstanding diagnostics", async () => {
    const contents = "export const defaults = { level: 'info' };\n";
    await fs.mkdir(path.join(repoRoot, "src/config"), { recursive: true });
    await fs.writeFile(
      path.join(repoRoot, "src/config/defaults.ts"),
      contents,
      "utf-8",
    );
    execSync("git add .", { cwd: repoRoot });
    execSync("git commit -m defaults", { cwd: repoRoot });

    context.setVariable("planning_loop_plan_files", ["src/config/defaults.ts"]);
    context.setVariable("plan_required_files", ["src/config/defaults.ts"]);
    context.setStepOutput("record_plan_key_files", {
      key_files: ["src/config/defaults.ts"],
      missing_files: [],
    });
    context.setStepOutput("planning_loop", {
      plan_result: {
        fields: {
          result: JSON.stringify({
            plan: [
              {
                goal: "Fix compile errors in defaults",
                key_files: ["src/config/defaults.ts"],
              },
            ],
          }),
        },
      },
    });

    vi.mocked(persona.waitForPersonaCompletion).mockResolvedValue({
      id: "event-noop",
      fields: {
        result: JSON.stringify({
          status: "pass",
          output: buildFileBlock("src/config/defaults.ts", contents),
        }),
      },
    } as any);

    const commitsBefore = execSync("git rev-list --count HEAD", {
      cwd: repoRoot,
      encoding: "utf-8",
    }).trim();

    const step = new ImplementationLoopStep({
      name: "implementation_loop",
      type: "ImplementationLoopStep",
      config: {
        maxAttempts: 2,
        planGuard: {
          plan_step: "planning_loop",
          plan_files_variable: "planning_loop_plan_files",
          additional_files: ["src/config/defaults.ts"],
        },
      },
    });

    const result = await step.execute(context);

    expect(result.status, result.error?.message).toBe("success");
    expect(context.getVariable("implementation_attempts")).toBe(1);
    const commitsAfter = execSync("git rev-list --count HEAD", {
      cwd: repoRoot,
      encoding: "utf-8",
    }).trim();
    expect(commitsAfter).toBe(commitsBefore);
    const fileContent = await fs.readFile(
      path.join(repoRoot, "src/config/defaults.ts"),
      "utf-8",
    );
    expect(fileContent).toBe(contents);
  });

  it("keeps failing no-op rewrites when diagnostics still reference the stage files", async () => {
    const contents = "export const defaults = { level: 'info' };\n";
    await fs.mkdir(path.join(repoRoot, "src/config"), { recursive: true });
    await fs.writeFile(
      path.join(repoRoot, "src/config/defaults.ts"),
      contents,
      "utf-8",
    );
    const script =
      "node -e \"console.error('src/config/defaults.ts(1,1): error TS2304: Cannot find name BrokenName.'); process.exit(2);\"";
    await fs.writeFile(
      path.join(repoRoot, "package.json"),
      JSON.stringify({ scripts: { typecheck: script } }),
      "utf-8",
    );
    execSync("git add .", { cwd: repoRoot });
    execSync("git commit -m defaults", { cwd: repoRoot });

    context.setVariable("planning_loop_plan_files", ["src/config/defaults.ts"]);
    context.setVariable("plan_required_files", ["src/config/defaults.ts"]);
    context.setStepOutput("record_plan_key_files", {
      key_files: ["src/config/defaults.ts"],
      missing_files: [],
    });
    context.setStepOutput("planning_loop", {
      plan_result: {
        fields: {
          result: JSON.stringify({
            plan: [
              {
                goal: "Fix compile errors in defaults",
                key_files: ["src/config/defaults.ts"],
              },
            ],
          }),
        },
      },
    });

    vi.mocked(persona.waitForPersonaCompletion).mockResolvedValue({
      id: "event-noop-broken",
      fields: {
        result: JSON.stringify({
          status: "pass",
          output: buildFileBlock("src/config/defaults.ts", contents),
        }),
      },
    } as any);

    const step = new ImplementationLoopStep({
      name: "implementation_loop",
      type: "ImplementationLoopStep",
      config: {
        maxAttempts: 3,
        planGuard: {
          plan_step: "planning_loop",
          plan_files_variable: "planning_loop_plan_files",
          additional_files: ["src/config/defaults.ts"],
        },
      },
    });

    const result = await step.execute(context);

    expect(result.status).toBe("failure");
    expect(result.error?.message).toContain("repeating the same no-op edit");
    const summary = context.getVariable(
      "implementation_config_validation_summary",
    ) as string;
    expect(summary).toContain("BrokenName");
  });

  it("does not spend the repair budget on a no-op rewrite", async () => {
    const defaultsPath = path.join(repoRoot, "src/config/defaults.ts");
    const staleContents = "export const defaults = { level: 'info' };\n";
    const fixedContents = "export const defaults = { level: 'debug' };\n";
    await fs.mkdir(path.join(repoRoot, "src/config"), { recursive: true });
    await fs.writeFile(defaultsPath, staleContents, "utf-8");
    await fs.writeFile(
      path.join(repoRoot, "package.json"),
      JSON.stringify({
        scripts: {
          typecheck:
            "node -e \"const fs=require('fs'); const s=fs.readFileSync('src/config/defaults.ts','utf8'); if(s.includes(\\\"level: 'info'\\\")){console.error('src/config/defaults.ts(1,1): error TS2304: Cannot find name StaleDefault.'); process.exit(2);}\"",
        },
      }),
      "utf-8",
    );
    execSync("git add .", { cwd: repoRoot });
    execSync("git commit -m stale-defaults", { cwd: repoRoot });

    context.setVariable("planning_loop_plan_files", ["src/config/defaults.ts"]);
    context.setVariable("plan_required_files", ["src/config/defaults.ts"]);
    context.setStepOutput("record_plan_key_files", {
      key_files: ["src/config/defaults.ts"],
      missing_files: [],
    });
    context.setStepOutput("planning_loop", {
      plan_result: {
        fields: {
          result: JSON.stringify({
            plan: [
              {
                goal: "Fix stale defaults",
                key_files: ["src/config/defaults.ts"],
              },
            ],
          }),
        },
      },
    });

    const personaDiffs = [
      buildFileBlock("src/config/defaults.ts", staleContents),
      buildFileBlock("src/config/defaults.ts", fixedContents),
    ];
    vi.mocked(persona.waitForPersonaCompletion).mockImplementation(
      async () => ({
        id: `event-${personaDiffs.length}`,
        fields: {
          result: JSON.stringify({
            status: "pass",
            output: personaDiffs.shift() ?? "",
          }),
        },
      }),
    );

    const step = new ImplementationLoopStep({
      name: "implementation_loop",
      type: "ImplementationLoopStep",
      config: {
        maxAttempts: 1,
        planGuard: {
          plan_step: "planning_loop",
          plan_files_variable: "planning_loop_plan_files",
          additional_files: ["src/config/defaults.ts"],
        },
      },
    });

    const result = await step.execute(context);

    expect(result.status, result.error?.message).toBe("success");
    expect(persona.waitForPersonaCompletion).toHaveBeenCalledTimes(2);
    expect(await fs.readFile(defaultsPath, "utf-8")).toBe(fixedContents);
  });

  it("uses the full-file rewrite retry after repeated validation failures on the last configured attempt", async () => {
    const testPath = path.join(repoRoot, "src/__tests__/config-loader.test.ts");
    const badContents = [
      "import { describe, it, expect, beforeEach } from 'vitest';",
      "",
      "describe('config loader', () => {",
      "  beforeEach(() => {",
      "    vi.clearAllMocks();",
      "  });",
      "",
      "  it('loads config', () => {",
      "    expect(true).toBe(true);",
      "  });",
      "});",
      "",
    ].join("\n");
    const fixedContents = badContents.replace(
      "import { describe, it, expect, beforeEach } from 'vitest';",
      "import { describe, it, expect, beforeEach, vi } from 'vitest';",
    );
    await fs.mkdir(path.dirname(testPath), { recursive: true });
    await fs.writeFile(testPath, fixedContents, "utf-8");
    await fs.writeFile(
      path.join(repoRoot, "package.json"),
      JSON.stringify({
        scripts: {
          typecheck:
            "node -e \"const fs=require('fs'); const s=fs.readFileSync('src/__tests__/config-loader.test.ts','utf8'); if(s.includes('vi.clearAllMocks()') && !s.includes('beforeEach, vi')){console.error('src/__tests__/config-loader.test.ts(5,5): error TS2304: Cannot find name \\'vi\\'.'); process.exit(2);}\"",
        },
      }),
      "utf-8",
    );
    execSync("git add .", { cwd: repoRoot });
    execSync("git commit -m config-loader-test", { cwd: repoRoot });

    context.setVariable("planning_loop_plan_files", [
      "src/__tests__/config-loader.test.ts",
    ]);
    context.setVariable("plan_required_files", [
      "src/__tests__/config-loader.test.ts",
    ]);
    context.setStepOutput("record_plan_key_files", {
      key_files: ["src/__tests__/config-loader.test.ts"],
      missing_files: [],
    });
    context.setStepOutput("planning_loop", {
      plan_result: {
        fields: {
          result: JSON.stringify({
            plan: [
              {
                goal: "Fix missing vitest import",
                key_files: ["src/__tests__/config-loader.test.ts"],
              },
            ],
          }),
        },
      },
    });

    const personaDiffs = [
      buildFileBlock("src/__tests__/config-loader.test.ts", badContents),
      buildFileBlock("src/__tests__/config-loader.test.ts", badContents),
      buildFileBlock("src/__tests__/config-loader.test.ts", fixedContents),
    ];
    vi.mocked(persona.waitForPersonaCompletion).mockImplementation(
      async () => ({
        id: `event-${personaDiffs.length}`,
        fields: {
          result: JSON.stringify({
            status: "pass",
            output: personaDiffs.shift() ?? "",
          }),
        },
      }),
    );

    const step = new ImplementationLoopStep({
      name: "implementation_loop",
      type: "ImplementationLoopStep",
      config: {
        maxAttempts: 2,
        planGuard: {
          plan_step: "planning_loop",
          plan_files_variable: "planning_loop_plan_files",
          additional_files: ["src/__tests__/config-loader.test.ts"],
        },
      },
    });

    const result = await step.execute(context);

    expect(result.status, result.error?.message).toBe("success");
    expect(persona.waitForPersonaCompletion).toHaveBeenCalledTimes(3);
    expect(await fs.readFile(testPath, "utf-8")).toBe(fixedContents);
  });

  it("keeps a baseline-compile-fix stage failing while the targeted file still has errors", async () => {
    const defaultsPath = path.join(repoRoot, "src/config/defaults.ts");
    const broken = "export const defaults = { level: 'info' };\n";
    await fs.mkdir(path.join(repoRoot, "src/config"), { recursive: true });
    await fs.writeFile(defaultsPath, broken, "utf-8");
    const script =
      "node -e \"const fs=require('fs'); const s=fs.readFileSync('src/config/defaults.ts','utf8'); if(s.includes('BROKEN')){console.error('src/config/defaults.ts(1,1): error TS2322: Type null is not assignable.'); process.exit(2);}\"";
    await fs.writeFile(
      path.join(repoRoot, "package.json"),
      JSON.stringify({ scripts: { typecheck: script } }),
      "utf-8",
    );
    await fs.writeFile(defaultsPath, "export const defaults = { level: 'BROKEN' };\n", "utf-8");
    execSync("git add .", { cwd: repoRoot });
    execSync("git commit --no-verify -m baseline", { cwd: repoRoot });

    context.setVariable("task", {
      id: 56,
      name: "Fix baseline compile errors in src/config/defaults.ts",
    });
    context.setVariable("planning_loop_plan_files", ["src/config/defaults.ts"]);
    context.setVariable("plan_required_files", ["src/config/defaults.ts"]);
    context.setStepOutput("record_plan_key_files", {
      key_files: ["src/config/defaults.ts"],
      missing_files: [],
    });
    context.setStepOutput("planning_loop", {
      plan_result: {
        fields: {
          result: JSON.stringify({
            plan: [
              {
                goal: "Fix baseline compile errors in defaults",
                key_files: ["src/config/defaults.ts"],
              },
            ],
          }),
        },
      },
    });

    const cosmeticEdit = buildFileBlock(
      "src/config/defaults.ts",
      "// cosmetic change only\nexport const defaults = { level: 'BROKEN' };\n",
    );
    vi.mocked(persona.waitForPersonaCompletion).mockResolvedValue({
      id: "event-cosmetic",
      fields: {
        result: JSON.stringify({ status: "pass", output: cosmeticEdit }),
      },
    } as any);

    const step = new ImplementationLoopStep({
      name: "implementation_loop",
      type: "ImplementationLoopStep",
      config: {
        maxAttempts: 2,
        planGuard: {
          plan_step: "planning_loop",
          plan_files_variable: "planning_loop_plan_files",
          additional_files: ["src/config/defaults.ts"],
        },
      },
    });

    const result = await step.execute(context);

    expect(result.status).toBe("failure");
    const summary = context.getVariable(
      "implementation_config_validation_summary",
    ) as string;
    expect(summary).toContain("defaults.ts");
    expect(summary).toContain("TS2322");
  });

  it("requires retries to touch stage files that still have diagnostics", async () => {
    const typePath = path.join(repoRoot, "src/types/logEvent.ts");
    const normalizerPath = path.join(repoRoot, "src/utils/logEventNormalizer.ts");
    await fs.mkdir(path.dirname(typePath), { recursive: true });
    await fs.mkdir(path.dirname(normalizerPath), { recursive: true });
    await fs.writeFile(
      typePath,
      "export interface LogEvent { workflow_id?: string; }\n",
      "utf-8",
    );
    await fs.writeFile(
      normalizerPath,
      "export const marker = 'BROKEN';\n",
      "utf-8",
    );
    await fs.writeFile(
      path.join(repoRoot, "package.json"),
      JSON.stringify({
        scripts: {
          typecheck:
            "node -e \"const fs=require('fs'); const typeFile=fs.readFileSync('src/types/logEvent.ts','utf8'); const impl=fs.readFileSync('src/utils/logEventNormalizer.ts','utf8'); if(typeFile.includes('intent') && impl.includes('BROKEN')){console.error('src/utils/logEventNormalizer.ts(1,25): error TS2339: Property preview does not exist on type RawLogMessage.'); process.exit(2);}\"",
        },
      }),
      "utf-8",
    );
    execSync("git add .", { cwd: repoRoot });
    execSync("git commit --no-verify -m baseline", { cwd: repoRoot });

    context.setVariable("planning_loop_plan_files", [
      "src/types/logEvent.ts",
      "src/utils/logEventNormalizer.ts",
    ]);
    context.setVariable("plan_required_files", [
      "src/types/logEvent.ts",
      "src/utils/logEventNormalizer.ts",
    ]);
    context.setStepOutput("record_plan_key_files", {
      key_files: [
        "src/types/logEvent.ts",
        "src/utils/logEventNormalizer.ts",
      ],
      missing_files: [],
    });
    context.setStepOutput("planning_loop", {
      plan_result: {
        fields: {
          result: JSON.stringify({
            plan: [
              {
                goal: "Add intent and update normalizer",
                key_files: [
                  "src/types/logEvent.ts",
                  "src/utils/logEventNormalizer.ts",
                ],
              },
            ],
          }),
        },
      },
    });

    const typeOnlyRewrite = buildFileBlock(
      "src/types/logEvent.ts",
      "export interface LogEvent { workflow_id?: string; intent?: string; }\n",
    );
    vi.mocked(persona.waitForPersonaCompletion).mockResolvedValue({
      id: "event-type-only",
      fields: {
        result: JSON.stringify({
          status: "pass",
          output: typeOnlyRewrite,
        }),
      },
    } as any);

    const step = new ImplementationLoopStep({
      name: "implementation_loop",
      type: "ImplementationLoopStep",
      config: {
        maxAttempts: 2,
        planGuard: {
          plan_step: "planning_loop",
          plan_files_variable: "planning_loop_plan_files",
          additional_files: [
            "src/types/logEvent.ts",
            "src/utils/logEventNormalizer.ts",
          ],
        },
      },
    });

    const result = await step.execute(context);

    expect(result.status).toBe("failure");
    const requiredFiles = context.getVariable(
      "implementation_required_diagnostic_touch_files",
    );
    expect(requiredFiles).toEqual(["src/utils/logEventNormalizer.ts"]);
    const summary = context.getVariable(
      "implementation_config_validation_summary",
    ) as string;
    expect(summary).toContain("logEventNormalizer.ts");
  });

  it("rejects edits that stray outside the plan scope", async () => {
    await fs.writeFile(
      path.join(repoRoot, "package.json"),
      '{ "name": "demo", }',
      "utf-8",
    );

    context.setVariable("planning_loop_plan_files", ["package.json"]);
    context.setVariable("plan_required_files", ["package.json"]);
    context.setStepOutput("record_plan_key_files", {
      key_files: ["package.json"],
      missing_files: [],
    });
    context.setStepOutput("planning_loop", {
      plan_result: {
        fields: {
          result: JSON.stringify({
            plan: [
              {
                goal: "Fix package script",
                key_files: ["package.json"],
              },
            ],
          }),
        },
      },
    });

    const personaDiffs = [
      buildDiff(
        "README.md",
        ["# temp", "Additional notes"].join("\n"),
      ),
    ];

    vi.mocked(persona.waitForPersonaCompletion).mockImplementation(
      async () => ({
        id: `event-${personaDiffs.length}`,
        fields: {
          result: JSON.stringify({
            status: "pass",
            output: personaDiffs.shift() ?? "",
          }),
        },
      }),
    );

    const step = new ImplementationLoopStep({
      name: "implementation_loop",
      type: "ImplementationLoopStep",
      config: {
        maxAttempts: 1,
        planGuard: {
          plan_step: "planning_loop",
          plan_files_variable: "planning_loop_plan_files",
          additional_files: ["package.json"],
        },
      },
    });

    const result = await step.execute(context);
    expect(result.status).toBe("failure");
    expect(result.error?.message).toContain("outside the approved scope");
    const summary = context.getVariable(
      "implementation_config_validation_summary",
    ) as string;
    expect(summary).toContain("README.md");
    const errors = context.getVariable(
      "implementation_config_validation_errors",
    ) as Array<{ file: string }>;
    expect(errors[0]?.file).toBe("README.md");
  });
});
