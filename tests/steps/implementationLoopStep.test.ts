import { describe, it, expect, beforeEach, vi } from "vitest";
import path from "path";
import fs from "fs/promises";
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

  it("reports config validation errors for untouched plan files", async () => {
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
    expect(result.error?.message).toContain("config validation errors");
    const summary = context.getVariable(
      "implementation_config_validation_summary",
    ) as string;
    expect(summary).toContain("package.json");
    const errors = context.getVariable(
      "implementation_config_validation_errors",
    ) as Array<{ file: string }>;
    expect(errors[0]?.file).toBe("package.json");
  });
});
