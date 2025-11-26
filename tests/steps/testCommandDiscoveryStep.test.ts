import { describe, it, expect, beforeEach } from "vitest";
import fs from "fs/promises";
import path from "path";

import { makeTempRepo } from "../makeTempRepo.js";
import { WorkflowContext } from "../../src/workflows/engine/WorkflowContext.js";
import { TestCommandDiscoveryStep } from "../../src/workflows/steps/TestCommandDiscoveryStep.js";

describe("TestCommandDiscoveryStep", () => {
  let repoRoot: string;
  let context: WorkflowContext;
  const transport: any = {};

  beforeEach(async () => {
    repoRoot = await makeTempRepo();
    context = new WorkflowContext(
      "wf-test-cmd",
      "proj-test",
      repoRoot,
      "main",
      { name: "test", version: "1.0.0", steps: [] },
      transport,
      {},
    );
  });

  it("detects npm scripts using configured priority", async () => {
    const pkgPath = path.join(repoRoot, "package.json");
    await fs.writeFile(
      pkgPath,
      JSON.stringify(
        {
          name: "demo",
          version: "1.0.0",
          scripts: {
            "test:regression": "vitest run tests/regression",
            test: "vitest",
          },
        },
        null,
        2,
      ),
    );

    const step = new TestCommandDiscoveryStep({
      name: "determine_test_entrypoint",
      type: "TestCommandDiscoveryStep",
      config: {
        variable: "detected_test_command",
        package_script_priority: ["test:regression", "test"],
      },
    });

    const result = await step.execute(context);

    expect(result.status).toBe("success");
    expect(result.data).toMatchObject({
      command: "npm run test:regression",
      source: "package.json:scripts.test:regression",
    });
    expect(context.getVariable("detected_test_command")).toBe(
      "npm run test:regression",
    );
  });

  it("falls back to pytest when python configs exist", async () => {
    const pyprojectPath = path.join(repoRoot, "pyproject.toml");
    await fs.writeFile(
      pyprojectPath,
      "[tool.pytest.ini_options]\naddopts = '-q'\n",
    );

    const step = new TestCommandDiscoveryStep({
      name: "determine_test_entrypoint",
      type: "TestCommandDiscoveryStep",
      config: {},
    });

    const result = await step.execute(context);

    expect(result.status).toBe("success");
    expect(result.data).toMatchObject({
      command: "pytest",
      source: "pyproject.toml",
    });
  });

  it("fails when no command can be detected and command is required", async () => {
    context.setVariable("plan_required_files", [
      "tests/regression/missing.test.ts",
    ]);

    const step = new TestCommandDiscoveryStep({
      name: "determine_test_entrypoint",
      type: "TestCommandDiscoveryStep",
      config: { require_command: true },
    });

    const result = await step.execute(context);

    expect(result.status).toBe("failure");
    expect(result.error).toBeInstanceOf(Error);
    expect(result.error?.message).toContain("unable to detect runnable test command");
  });
});
