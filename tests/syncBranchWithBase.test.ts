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

async function commitFile(repoDir: string, file: string, body: string, message: string) {
  await fs.mkdir(path.dirname(path.join(repoDir, file)), { recursive: true });
  await fs.writeFile(path.join(repoDir, file), body);
  await git("add -A", repoDir);
  await git(`commit -m "${message}"`, repoDir);
}

describe("syncBranchWithBase", () => {
  let repoDir: string;

  beforeEach(async () => {
    repoDir = await makeTempRepo({ "README.md": "# test\n" });
  });

  it("reports not behind when the base branch has not advanced", async () => {
    await git("checkout -b feature/current", repoDir);
    await commitFile(repoDir, "feature.txt", "work\n", "add feature");

    const { syncBranchWithBase } = await import(
      "../src/git/operations/BranchOperations.js"
    );

    const result = await syncBranchWithBase(repoDir, "feature/current", "main");

    expect(result.behind).toBe(false);
    expect(result.commitsBehind).toBe(0);
    expect(result.merged).toBe(false);
    expect(result.conflicted).toBe(false);
  });

  it("merges base commits the feature branch never saw so the preflight can see them", async () => {
    await git("checkout -b feature/stale", repoDir);
    await commitFile(repoDir, "src/view.ts", "export const view = 'new';\n", "rewrite view");

    await git("checkout main", repoDir);
    await commitFile(repoDir, "src/view.test.ts", "expect(view).toBe('old');\n", "add view test");

    await git("checkout feature/stale", repoDir);

    const { syncBranchWithBase } = await import(
      "../src/git/operations/BranchOperations.js"
    );

    const result = await syncBranchWithBase(repoDir, "feature/stale", "main");

    expect(result.behind).toBe(true);
    expect(result.commitsBehind).toBe(1);
    expect(result.merged).toBe(true);
    expect(result.conflicted).toBe(false);

    const files = await git("ls-tree -r --name-only HEAD", repoDir);
    expect(files).toContain("src/view.test.ts");
    expect(files).toContain("src/view.ts");
  });

  it("reports conflicts and leaves the tree clean instead of throwing", async () => {
    await git("checkout -b feature/conflict", repoDir);
    await commitFile(repoDir, "shared.txt", "feature version\n", "feature edit");

    await git("checkout main", repoDir);
    await commitFile(repoDir, "shared.txt", "main version\n", "main edit");

    await git("checkout feature/conflict", repoDir);

    const { syncBranchWithBase } = await import(
      "../src/git/operations/BranchOperations.js"
    );

    const result = await syncBranchWithBase(repoDir, "feature/conflict", "main");

    expect(result.behind).toBe(true);
    expect(result.merged).toBe(false);
    expect(result.conflicted).toBe(true);
    expect(result.conflictFiles).toContain("shared.txt");

    const status = await git("status --porcelain", repoDir);
    expect(status).toBe("");
  });

  it("is a no-op when the branch is the base branch", async () => {
    const { syncBranchWithBase } = await import(
      "../src/git/operations/BranchOperations.js"
    );

    const result = await syncBranchWithBase(repoDir, "main", "main");

    expect(result.behind).toBe(false);
    expect(result.merged).toBe(false);
  });
});
