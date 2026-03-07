import path from "path";
import { describe, it, expect, beforeEach, vi, type Mock } from "vitest";

vi.mock("../../src/gitUtils.js", () => ({
  runGit: vi.fn(),
}));

import { runGit } from "../../src/gitUtils.js";
import { WorkflowContext } from "../../src/workflows/engine/WorkflowContext.js";
import { TestToolingSetupStep } from "../../src/workflows/steps/TestToolingSetupStep.js";
import { makeTempRepo } from "../makeTempRepo.js";

const runGitMock = runGit as unknown as Mock;

function makeContext(repoRoot: string) {
  return new WorkflowContext(
    "wf-test",
    "proj-123",
    repoRoot,
    "main",
    {
      name: "bootstrap",
      version: "1.0.0",
      steps: [],
    },
    {} as any,
    {},
  );
}

describe("TestToolingSetupStep", () => {
  beforeEach(() => {
    runGitMock.mockReset();
  });

  it("executes context-provided setup commands and reverts tracked changes", async () => {
    const repoRoot = await makeTempRepo({ "README.md": "test" });
    const context = makeContext(repoRoot);
    context.setVariable("detected_test_command", "pytest");
    context.setVariable("context_setup_commands", [
      {
        id: "python",
        title: "Python env",
        language: "Python",
        ecosystem: "python",
        reason: "requirements.txt detected",
        commands: ["python -m pip install -r requirements.txt"],
        evidence: ["requirements.txt"],
        workingDirectory: "api",
      },
      {
        id: "node",
        title: "Node deps",
        language: "TypeScript",
        ecosystem: "node",
        reason: "package.json detected",
        commands: ["npm install --no-package-lock"],
        evidence: ["package.json"],
      },
    ]);

    runGitMock.mockResolvedValueOnce({ stdout: "", stderr: "" });
    runGitMock.mockResolvedValueOnce({
      stdout: " M package-lock.json\n?? node_modules/cache\n",
      stderr: "",
    });
    runGitMock.mockResolvedValue({ stdout: "", stderr: "" });

    const runCommandSpy = vi
      .spyOn(TestToolingSetupStep.prototype as any, "runCommand")
      .mockResolvedValue(undefined);

    const step = new TestToolingSetupStep({
      name: "bootstrap_test_tooling",
      type: "TestToolingSetupStep",
      config: {
        testCommandVariable: "detected_test_command",
      },
    });

    const result = await step.execute(context);
    const outputs = result.outputs!;

    expect(runCommandSpy).toHaveBeenNthCalledWith(
      1,
      "python -m pip install -r requirements.txt",
      path.join(repoRoot, "api"),
      undefined,
    );
    expect(runCommandSpy).toHaveBeenNthCalledWith(
      2,
      "npm install --no-package-lock",
      repoRoot,
      undefined,
    );

    expect(outputs.gitChanges).toEqual([
      { path: "package-lock.json", status: " M", untracked: false },
      { path: "node_modules/cache", status: "??", untracked: true },
    ]);
    expect(outputs.revertedTrackedPaths).toEqual(["package-lock.json"]);
    expect(context.getVariable("test_tooling_context_setup")).toBe(true);
    expect(context.getVariable("test_tooling_git_changes")).toEqual(
      outputs.gitChanges,
    );

    const checkoutArgs = runGitMock.mock.calls
      .map((call) => call[0])
      .filter(
        (args): args is string[] => Array.isArray(args) && args[0] === "checkout",
      );
    expect(checkoutArgs).toEqual([["checkout", "--", "package-lock.json"]]);

    runCommandSpy.mockRestore();
  });

  it("falls back to legacy Node setup when context lacks guidance", async () => {
    const repoRoot = await makeTempRepo({
      "package.json": JSON.stringify({ name: "demo", version: "0.0.0" }),
    });
    const context = makeContext(repoRoot);
    context.setVariable("detected_test_command", "npm test");

    const runCommandSpy = vi
      .spyOn(TestToolingSetupStep.prototype as any, "runCommand")
      .mockResolvedValue(undefined);

    const step = new TestToolingSetupStep({
      name: "bootstrap_test_tooling",
      type: "TestToolingSetupStep",
      config: {
        testCommandVariable: "detected_test_command",
        ensureDevDependencies: ["vitest"],
        skipInstall: true,
      },
    });

    const result = await step.execute(context);
    const outputs = result.outputs!;

    expect(runCommandSpy).toHaveBeenCalledWith(
      "npm install --no-save vitest",
      repoRoot,
      undefined,
    );
    expect(outputs.missingDependencies).toEqual(["vitest"]);
    expect(context.getVariable("test_tooling_context_setup")).toBe(false);
    expect(context.getVariable("test_tooling_git_changes")).toEqual([]);
    expect(context.getVariable("test_tooling_reverted_paths")).toEqual([]);

    runCommandSpy.mockRestore();
  });

  it("swaps npm ci context command for npm install when lockfile is out of sync", async () => {
    const repoRoot = await makeTempRepo({
      "package.json": JSON.stringify({
        name: "demo",
        version: "0.0.0",
        dependencies: { lodash: "^4.0.0" },
      }),
      "package-lock.json": JSON.stringify({
        name: "demo",
        version: "0.0.0",
        lockfileVersion: 3,
        packages: {
          "": {
            name: "demo",
            version: "0.0.0",
            dependencies: { lodash: "^3.9.0" },
          },
        },
      }),
    });
    runGitMock.mockResolvedValue({ stdout: "", stderr: "" });

    const context = makeContext(repoRoot);
    context.setVariable("detected_test_command", "npm test");
    context.setVariable("context_setup_commands", [
      {
        id: "node",
        title: "Node deps",
        language: "TypeScript",
        ecosystem: "node",
        reason: "package.json detected",
        commands: ["npm ci --ignore-scripts"],
        evidence: ["package.json"],
      },
    ]);

    const runCommandSpy = vi
      .spyOn(TestToolingSetupStep.prototype as any, "runCommand")
      .mockResolvedValue(undefined);

    const step = new TestToolingSetupStep({
      name: "bootstrap_test_tooling",
      type: "TestToolingSetupStep",
      config: {
        testCommandVariable: "detected_test_command",
      },
    });

    await step.execute(context);

    expect(runCommandSpy).toHaveBeenCalledWith(
      "npm install --no-package-lock --ignore-scripts",
      repoRoot,
      undefined,
    );

    runCommandSpy.mockRestore();
  });

  it("replaces legacy npm ci install with npm install when lockfile mismatches", async () => {
    const repoRoot = await makeTempRepo({
      "package.json": JSON.stringify({
        name: "demo",
        version: "0.0.0",
        dependencies: { lodash: "^4.0.0" },
      }),
      "package-lock.json": JSON.stringify({
        name: "demo",
        version: "0.0.0",
        lockfileVersion: 3,
        packages: {
          "": {
            name: "demo",
            version: "0.0.0",
            dependencies: { lodash: "^3.9.0" },
          },
        },
      }),
    });
    const context = makeContext(repoRoot);
    context.setVariable("detected_test_command", "npm test");

    const runCommandSpy = vi
      .spyOn(TestToolingSetupStep.prototype as any, "runCommand")
      .mockResolvedValue(undefined);

    const step = new TestToolingSetupStep({
      name: "bootstrap_test_tooling",
      type: "TestToolingSetupStep",
      config: {
        testCommandVariable: "detected_test_command",
        ensureDevDependencies: [],
        ciCommand: "npm ci",
      },
    });

    const result = await step.execute(context);

    expect(runCommandSpy).toHaveBeenCalledWith(
      "npm install --no-package-lock",
      repoRoot,
      undefined,
    );
    expect(result.outputs?.executedCommands).toContain(
      "npm install --no-package-lock (lockfile out of sync, swapped npm ci with npm install --no-package-lock)",
    );

    runCommandSpy.mockRestore();
  });
});
