import { describe, it, expect } from "vitest";
import { runTestCommandWithWorker } from "../src/workflows/helpers/testRunner.js";

const repoRoot = process.cwd();

describe("runTestCommandWithWorker", () => {
  it("captures stdout from a fast command", async () => {
    const result = await runTestCommandWithWorker({
      command: "node -e \"console.log('ok')\"",
      cwd: repoRoot,
      timeoutMs: 5000,
    });

    expect(result.stdout).toContain("ok");
  });

  it("aborts long running commands", async () => {
    await expect(
      runTestCommandWithWorker({
        command: "node -e \"setTimeout(() => {}, 5000)\"",
        cwd: repoRoot,
        timeoutMs: 200,
        idleTimeoutMs: 100,
      }),
    ).rejects.toThrow(/timeout/i);
  });
});
