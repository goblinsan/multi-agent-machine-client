import { describe, it, expect, beforeEach, vi } from "vitest";
import { makeTempRepo } from "./makeTempRepo";
import { exec } from "child_process";
import { promisify } from "util";
import fs from "fs/promises";
import path from "path";

const execP = promisify(exec);

vi.mock("../src/redisClient.js");

async function git(args: string, cwd: string) {
  const { stdout } = await execP(`git ${args}`, { cwd });
  return stdout.trim();
}

describe("mergeBranchToMain", () => {
  let repoDir: string;

  beforeEach(async () => {
    repoDir = await makeTempRepo({ "README.md": "# test\n" });
  });

  it("merges a feature branch into main", async () => {
    await git("checkout -b feature/test-merge", repoDir);
    await fs.writeFile(path.join(repoDir, "feature.txt"), "feature work\n");
    await git("add .", repoDir);
    await git('commit -m "add feature"', repoDir);

    const { mergeBranchToMain } = await import(
      "../src/git/operations/BranchOperations.js"
    );

    await mergeBranchToMain(repoDir, "feature/test-merge", "main");

    const currentBranch = await git("rev-parse --abbrev-ref HEAD", repoDir);
    expect(currentBranch).toBe("main");

    const mainFiles = await git("ls-tree --name-only HEAD", repoDir);
    expect(mainFiles).toContain("feature.txt");
  });

  it("reports already up to date when no new commits", async () => {
    await git("checkout -b feature/no-changes", repoDir);

    const { mergeBranchToMain } = await import(
      "../src/git/operations/BranchOperations.js"
    );

    const result = await mergeBranchToMain(
      repoDir,
      "feature/no-changes",
      "main",
    );
    expect(result.merged).toBe(true);
    expect(result.alreadyUpToDate).toBe(true);
  });

  it("throws on merge conflict and aborts cleanly", async () => {
    await fs.writeFile(path.join(repoDir, "conflict.txt"), "main content\n");
    await git("add .", repoDir);
    await git('commit -m "main version"', repoDir);

    await git("checkout -b feature/conflict HEAD~1", repoDir);
    await fs.writeFile(
      path.join(repoDir, "conflict.txt"),
      "feature content\n",
    );
    await git("add .", repoDir);
    await git('commit -m "feature version"', repoDir);

    const { mergeBranchToMain } = await import(
      "../src/git/operations/BranchOperations.js"
    );

    await expect(
      mergeBranchToMain(repoDir, "feature/conflict", "main"),
    ).rejects.toThrow("Failed to merge");

    const status = await git("status --porcelain", repoDir);
    expect(status).toBe("");
  });
});
