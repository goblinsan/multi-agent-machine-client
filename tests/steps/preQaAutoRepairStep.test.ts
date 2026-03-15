import fs from "fs/promises";
import path from "path";
import { describe, it, expect, beforeEach, vi, type Mock } from "vitest";

vi.mock("../../src/gitUtils.js", () => ({
  runGit: vi.fn(),
}));

vi.mock("../../src/logger.js", () => ({
  logger: {
    info: vi.fn(),
    debug: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

vi.mock("../../src/workflows/helpers/testRunner.js", () => ({
  runTestCommandWithWorker: vi.fn(),
}));

import { runGit } from "../../src/gitUtils.js";
import { runTestCommandWithWorker } from "../../src/workflows/helpers/testRunner.js";
import { WorkflowContext } from "../../src/workflows/engine/WorkflowContext.js";
import { PreQaAutoRepairStep } from "../../src/workflows/steps/PreQaAutoRepairStep.js";
import { makeTempRepo } from "../makeTempRepo.js";

const runGitMock = runGit as unknown as Mock;
const runTestMock = runTestCommandWithWorker as unknown as Mock;

function makeContext(repoRoot: string) {
  return new WorkflowContext(
    "wf-test",
    "proj-123",
    repoRoot,
    "main",
    {
      name: "pre-qa-repair",
      version: "1.0.0",
      steps: [],
    },
    {} as any,
    {},
  );
}

function makeStep(config: Record<string, any> = {}) {
  return new PreQaAutoRepairStep({
    name: "pre_qa_auto_repair",
    type: "PreQaAutoRepairStep",
    config,
  });
}

describe("PreQaAutoRepairStep", () => {
  beforeEach(() => {
    runGitMock.mockReset();
    runTestMock.mockReset();
  });

  it("skips when no pre_qa_test_error is set", async () => {
    const repoRoot = await makeTempRepo({ "README.md": "test" });
    const context = makeContext(repoRoot);
    const step = makeStep();
    const result = await step.execute(context);
    expect(result.status).toBe("success");
    expect(result.data?.skipped).toBe(true);
    expect(result.outputs?.repair_attempted).toBe(false);
  });

  it("skips when pre_qa_test_error is empty string", async () => {
    const repoRoot = await makeTempRepo({ "README.md": "test" });
    const context = makeContext(repoRoot);
    context.setVariable("pre_qa_test_error", "");
    const step = makeStep();
    const result = await step.execute(context);
    expect(result.status).toBe("success");
    expect(result.data?.skipped).toBe(true);
  });

  it("skips when error text has no parseable file/line info", async () => {
    const repoRoot = await makeTempRepo({ "README.md": "test" });
    const context = makeContext(repoRoot);
    context.setVariable("pre_qa_test_error", "ENOENT: no such file or directory");
    const step = makeStep();
    const result = await step.execute(context);
    expect(result.status).toBe("success");
    expect(result.data?.skipped).toBe(true);
    expect(result.data?.reason).toBe("no_parseable_errors");
  });

  it("repairs missing closing brace and clears pre_qa_test_error", async () => {
    const brokenTs = [
      "export function outer() {",
      "  const x = 1;",
      "  return x;",
      "",
    ].join("\n");

    const repoRoot = await makeTempRepo({ "src/broken.ts": brokenTs });
    const context = makeContext(repoRoot);
    context.setVariable("detected_test_command", "npm test");
    context.setVariable(
      "pre_qa_test_error",
      `src/broken.ts:4:1: ERROR: Expected "}" but found end of file`,
    );

    runTestMock.mockResolvedValue({ stdout: "Tests passed", stderr: "" });
    runGitMock.mockResolvedValue({ stdout: "", stderr: "" });

    const step = makeStep();
    const result = await step.execute(context);

    expect(result.status).toBe("success");
    expect(result.outputs?.repair_succeeded).toBe(true);
    expect(result.outputs?.repaired_files).toContain("src/broken.ts");

    const repaired = await fs.readFile(path.join(repoRoot, "src/broken.ts"), "utf-8");
    const openBraces = (repaired.match(/\{/g) || []).length;
    const closeBraces = (repaired.match(/\}/g) || []).length;
    expect(openBraces).toBe(closeBraces);

    expect(context.getVariable("pre_qa_test_error")).toBe("");
  });

  it("repairs extra closing brace at end of file", async () => {
    const brokenTs = [
      'import { foo } from "./foo";',
      "",
      "export function bar() {",
      "  return foo();",
      "}",
      "}",
      "",
    ].join("\n");

    const repoRoot = await makeTempRepo({ "src/extra.ts": brokenTs });
    const context = makeContext(repoRoot);
    context.setVariable("detected_test_command", "npm test");
    context.setVariable(
      "pre_qa_test_error",
      'src/extra.ts:6:1: ERROR: Unexpected "}"',
    );

    runTestMock.mockResolvedValue({ stdout: "Tests passed", stderr: "" });
    runGitMock.mockResolvedValue({ stdout: "", stderr: "" });

    const step = makeStep();
    const result = await step.execute(context);

    expect(result.status).toBe("success");
    expect(result.outputs?.repair_succeeded).toBe(true);

    const repaired = await fs.readFile(path.join(repoRoot, "src/extra.ts"), "utf-8");
    const openBraces = (repaired.match(/\{/g) || []).length;
    const closeBraces = (repaired.match(/\}/g) || []).length;
    expect(openBraces).toBe(closeBraces);
  });

  it("reverts repair when verification test still fails", async () => {
    const brokenTs = [
      "export function broken() {",
      "  if (true) {",
      "",
    ].join("\n");

    const repoRoot = await makeTempRepo({ "src/unfixable.ts": brokenTs });
    const context = makeContext(repoRoot);
    context.setVariable("detected_test_command", "npm test");
    context.setVariable(
      "pre_qa_test_error",
      'src/unfixable.ts:3:1: ERROR: Expected "}" but found end of file',
    );

    runTestMock.mockResolvedValue({
      stdout: "",
      stderr: 'src/unfixable.ts:5:1: ERROR: Unexpected "}"',
    });
    runGitMock.mockResolvedValue({ stdout: "", stderr: "" });

    const step = makeStep({ maxRepairAttempts: 1 });
    const result = await step.execute(context);

    expect(result.status).toBe("success");
    expect(result.outputs?.repair_succeeded).toBe(false);
    expect(result.data?.reverted).toBe(true);
  });

  it("returns repair_attempted false when file has no structural issues", async () => {
    const validTs = [
      "export const x = 1;",
      "",
    ].join("\n");

    const repoRoot = await makeTempRepo({ "src/valid.ts": validTs });
    const context = makeContext(repoRoot);
    context.setVariable(
      "pre_qa_test_error",
      'src/valid.ts:1:1: ERROR: some random error',
    );

    const step = makeStep();
    const result = await step.execute(context);

    expect(result.status).toBe("success");
    expect(result.outputs?.repair_attempted).toBe(true);
    expect(result.outputs?.repair_succeeded).toBe(false);
  });

  it("uses structural validation when no test command is available", async () => {
    const brokenTs = [
      "export function a() {",
      "  return 1;",
      "",
    ].join("\n");

    const repoRoot = await makeTempRepo({ "src/notest.ts": brokenTs });
    const context = makeContext(repoRoot);
    context.setVariable(
      "pre_qa_test_error",
      'src/notest.ts:3:1: ERROR: Expected "}" but found end of file',
    );

    runGitMock.mockResolvedValue({ stdout: "", stderr: "" });

    const step = makeStep();
    const result = await step.execute(context);

    expect(result.status).toBe("success");
    expect(result.outputs?.repair_succeeded).toBe(true);
    expect(runTestMock).not.toHaveBeenCalled();
  });

  it("handles absolute file paths in error text", async () => {
    const brokenTs = "export function b() {\n  return 2;\n";

    const repoRoot = await makeTempRepo({ "src/abs.ts": brokenTs });
    const absPath = path.join(repoRoot, "src/abs.ts");
    const context = makeContext(repoRoot);
    context.setVariable(
      "pre_qa_test_error",
      `${absPath}:3:1: ERROR: Expected "}" but found end of file`,
    );

    runGitMock.mockResolvedValue({ stdout: "", stderr: "" });

    const step = makeStep();
    const result = await step.execute(context);

    expect(result.status).toBe("success");
    expect(result.outputs?.repair_succeeded).toBe(true);
  });
});
