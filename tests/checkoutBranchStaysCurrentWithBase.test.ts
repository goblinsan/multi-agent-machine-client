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

async function commitsBehindBase(repoDir: string, branch: string, base: string) {
  const out = await git(`rev-list --count ${branch}..${base}`, repoDir);
  return Number.parseInt(out, 10);
}

describe("checkoutBranchFromBase keeps a reused branch current with base", () => {
  let repoDir: string;

  beforeEach(async () => {
    repoDir = await makeTempRepo({ "README.md": "# test\n" });
  });

  it("pulls base into a long-lived branch that base has moved past", async () => {
    await git("checkout -b milestone/demo", repoDir);
    await commitFile(repoDir, "src/work.ts", "export const work = 1;\n", "task one work");

    await git("checkout main", repoDir);
    await git("merge --no-ff --no-edit milestone/demo", repoDir);
    await commitFile(repoDir, "src/work.test.ts", "expect(work).toBe(1);\n", "add test on main");
    await git("checkout milestone/demo", repoDir);

    expect(await commitsBehindBase(repoDir, "milestone/demo", "main")).toBeGreaterThan(0);

    const { checkoutBranchFromBase } = await import(
      "../src/git/operations/BranchOperations.js"
    );

    await checkoutBranchFromBase(repoDir, "main", "milestone/demo");

    expect(await commitsBehindBase(repoDir, "milestone/demo", "main")).toBe(0);

    const files = await git("ls-tree -r --name-only HEAD", repoDir);
    expect(files).toContain("src/work.test.ts");
  });

  it("does not drift across repeated task cycles on the same branch", async () => {
    const { checkoutBranchFromBase } = await import(
      "../src/git/operations/BranchOperations.js"
    );

    for (let cycle = 0; cycle < 3; cycle++) {
      await checkoutBranchFromBase(repoDir, "main", "milestone/demo");
      await commitFile(repoDir, `src/f${cycle}.ts`, `export const v = ${cycle};\n`, `work ${cycle}`);
      await git("checkout main", repoDir);
      await git("merge --no-ff --no-edit milestone/demo", repoDir);
      await git("checkout milestone/demo", repoDir);
    }

    await checkoutBranchFromBase(repoDir, "main", "milestone/demo");

    expect(await commitsBehindBase(repoDir, "milestone/demo", "main")).toBe(0);
  });

  it("reports conflicts instead of leaving a half-merged tree", async () => {
    await git("checkout -b milestone/conflict", repoDir);
    await commitFile(repoDir, "shared.txt", "branch version\n", "branch edit");

    await git("checkout main", repoDir);
    await commitFile(repoDir, "shared.txt", "main version\n", "main edit");
    await git("checkout milestone/conflict", repoDir);

    const { checkoutBranchFromBase } = await import(
      "../src/git/operations/BranchOperations.js"
    );

    const result = await checkoutBranchFromBase(repoDir, "main", "milestone/conflict");

    expect(result?.baseSync?.conflicted).toBe(true);
    expect(result?.baseSync?.conflictFiles).toContain("shared.txt");
    expect(await git("status --porcelain", repoDir)).toBe("");
  });

  it("still creates a fresh branch from base when it does not exist", async () => {
    await commitFile(repoDir, "src/base.ts", "export const base = 1;\n", "base work");

    const { checkoutBranchFromBase } = await import(
      "../src/git/operations/BranchOperations.js"
    );

    await checkoutBranchFromBase(repoDir, "main", "milestone/fresh");

    expect(await git("rev-parse --abbrev-ref HEAD", repoDir)).toBe("milestone/fresh");
    expect(await commitsBehindBase(repoDir, "milestone/fresh", "main")).toBe(0);
  });
});
