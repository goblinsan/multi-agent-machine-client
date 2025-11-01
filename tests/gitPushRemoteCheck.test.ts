import { describe, it, expect, vi as _vi, beforeEach, afterEach } from "vitest";
import { commitAndPushPaths } from "../src/gitUtils.js";
import { makeTempRepo } from "./makeTempRepo.js";
import fs from "fs/promises";
import path from "path";
import { execSync as _execSync } from "child_process";

describe("commitAndPushPaths - remote branch check", () => {
  let tmpRepo: string;

  beforeEach(async () => {
    tmpRepo = await makeTempRepo({
      "README.md": "# Test repo\n",
      "test.txt": "initial content\n",
    });
  });

  afterEach(async () => {
    if (tmpRepo) {
      await fs.rm(tmpRepo, { recursive: true, force: true }).catch(() => {});
    }
  });

  it("should handle new branch without -u flag error", async () => {
    const testFile = path.join(tmpRepo, "new-file.txt");
    await fs.writeFile(testFile, "new content\n");

    const result = await commitAndPushPaths({
      repoRoot: tmpRepo,
      branch: "feature/test-branch",
      message: "test commit",
      paths: ["new-file.txt"],
    });

    expect(result.committed).toBe(true);

    expect(result.pushed).toBe(false);
    expect(result.reason).toBe("push_failed");
    expect(result.branch).toBe("feature/test-branch");
  });

  it("should commit changes successfully", async () => {
    const testFile = path.join(tmpRepo, "test.txt");
    await fs.writeFile(testFile, "modified content\n");

    const result = await commitAndPushPaths({
      repoRoot: tmpRepo,
      branch: "main",
      message: "test: update file",
      paths: ["test.txt"],
    });

    expect(result.committed).toBe(true);

    expect(result.pushed).toBe(false);
    expect(result.reason).toBe("push_failed");
  });

  it("should skip commit when no changes", async () => {
    const result = await commitAndPushPaths({
      repoRoot: tmpRepo,
      branch: "main",
      message: "test: no changes",
      paths: ["test.txt"],
    });

    expect(result.committed).toBe(false);
    expect(result.pushed).toBe(false);
    expect(result.reason).toBe("no_changes");
  });

  it("should skip commit when paths array is empty", async () => {
    const result = await commitAndPushPaths({
      repoRoot: tmpRepo,
      branch: "main",
      message: "test: empty paths",
      paths: [],
    });

    expect(result.committed).toBe(false);
    expect(result.pushed).toBe(false);
    expect(result.reason).toBe("no_paths");
  });
});
