import { describe, it, expect } from "vitest";
import path from "path";
import fs from "fs/promises";
import { gitWorkflowManager } from "../src/git/workflowManager.js";
import { runGit } from "../src/gitUtils.js";
import { makeTempRepo } from "./makeTempRepo.js";

describe("GitWorkflowManager", () => {
  it("ensures branch, commits files, reports state, and deletes branch", async () => {
    const repoRoot = await makeTempRepo({
      "src/index.ts": "export const x = 1\n",
      "README.md": "# Temp Repo\n",
    });

    const branchName = "feature/wm-test-1";
    const ensured = await gitWorkflowManager.ensureBranch({
      repoRoot,
      branchName,
      baseBranch: "main",
    });
    expect(ensured).toBe(branchName);

    const current = await gitWorkflowManager.getCurrentBranch(repoRoot);
    expect(current).toBe(branchName);

    const relFile = "src/new-file.txt";
    await fs.mkdir(path.join(repoRoot, "src"), { recursive: true });
    await fs.writeFile(path.join(repoRoot, relFile), "hello world\n", "utf8");

    await gitWorkflowManager.commitFiles({
      repoRoot,
      files: [relFile],
      message: "feat: add new-file for wm test",
      branch: branchName,

      push: false,
    });

    const lastCommit = await runGit(["log", "--oneline", "-1"], {
      cwd: repoRoot,
    });
    expect(lastCommit.stdout).toMatch(/feat: add new-file for wm test/);

    const lsFiles = await runGit(["ls-files", relFile], { cwd: repoRoot });
    expect(lsFiles.stdout.trim()).toBe(relFile);

    const state = await gitWorkflowManager.getBranchState(repoRoot);
    expect(state.currentBranch).toBe(branchName);
    expect(state.existsLocally).toBe(true);
    expect(state.existsRemotely).toBe(false);
    expect(state.hasChanges).toBe(false);

    expect(state.hasUnpushedCommits).toBe(false);

    const defaultBranch = await gitWorkflowManager.getDefaultBranch(repoRoot);
    expect(defaultBranch).toBe("main");

    await gitWorkflowManager.deleteBranch(repoRoot, branchName, false, true);
    const branchesAfter = await runGit(["branch", "--list", branchName], {
      cwd: repoRoot,
    });
    expect(branchesAfter.stdout.trim()).toBe("");
  });
});
