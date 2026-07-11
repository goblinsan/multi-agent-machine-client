import { beforeEach, describe, expect, it, vi, type Mock } from "vitest";
import fs from "fs/promises";
import path from "path";

vi.mock("../../src/workflows/helpers/testRunner.js", () => ({
  runTestCommandWithWorker: vi.fn(),
}));

import { makeTempRepo } from "../makeTempRepo.js";
import { WorkflowContext } from "../../src/workflows/engine/WorkflowContext.js";
import { QAStep } from "../../src/workflows/steps/QAStep.js";
import { runTestCommandWithWorker } from "../../src/workflows/helpers/testRunner.js";

describe("QAStep project validation", () => {
  let repoRoot: string;
  let context: WorkflowContext;
  const runCommandMock = runTestCommandWithWorker as unknown as Mock;

  beforeEach(async () => {
    vi.clearAllMocks();
    repoRoot = await makeTempRepo();
    context = new WorkflowContext(
      "wf-qa-validation",
      "proj-qa-validation",
      repoRoot,
      "main",
      { name: "test", version: "1.0.0", steps: [] },
      {} as any,
      {},
    );
  });

  it("runs npm typecheck script before the configured test command", async () => {
    await fs.writeFile(
      path.join(repoRoot, "package.json"),
      JSON.stringify(
        {
          scripts: {
            typecheck: "tsc --noEmit",
            test: "vitest run",
          },
        },
        null,
        2,
      ),
    );

    runCommandMock.mockResolvedValue({
      stdout: "Tests: 1 passed, 1 total",
      stderr: "",
      durationMs: 10,
    });

    const step = new QAStep({
      name: "run_project_validation",
      type: "QAStep",
      config: {
        testCommand: "npm test",
        retryCount: 0,
        softFail: false,
      },
    });

    const result = await step.execute(context);

    expect(result.status).toBe("success");
    expect(runCommandMock).toHaveBeenCalledWith(
      expect.objectContaining({
        command: "npm run typecheck",
        cwd: repoRoot,
      }),
    );
    expect(runCommandMock).toHaveBeenCalledWith(
      expect.objectContaining({
        command: "npm test",
        cwd: repoRoot,
      }),
    );
  });
});
