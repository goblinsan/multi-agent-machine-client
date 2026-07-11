import { describe, it, expect } from "vitest";
import fs from "fs/promises";
import path from "path";
import { makeTempRepo } from "./makeTempRepo";
import { tryGitApply } from "../src/fileops/gitApply.js";
import { runGit } from "../src/gitUtils.js";

describe("tryGitApply robustness tests", () => {
  it("succeeds with git-apply-strict when context matches exactly", async () => {
    const repo = await makeTempRepo({
      "file.txt": "line1\nline2\nline3\n",
    });

    const diff = `diff --git a/file.txt b/file.txt
index 0000000..1111111
--- a/file.txt
+++ b/file.txt
@@ -1,3 +1,3 @@
 line1
-line2
+line2-modified
 line3
`;

    const res = await tryGitApply(repo, diff);
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.method).toBe("git-apply-strict");
      expect(res.changedFiles).toEqual(["file.txt"]);
    }

    const content = await fs.readFile(path.join(repo, "file.txt"), "utf8");
    expect(content).toBe("line1\nline2-modified\nline3\n");
  });

  it("succeeds with git-apply-ignore-whitespace when indentation drifts in context", async () => {
    const repo = await makeTempRepo({
      "file.txt": "  line1\n  line2\n  line3\n",
    });

    const diff = `diff --git a/file.txt b/file.txt
--- a/file.txt
+++ b/file.txt
@@ -1,3 +1,3 @@
     line1
-    line2
+  line2-modified
     line3
`;

    const res = await tryGitApply(repo, diff);
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.method).toBe("git-apply-ignore-whitespace");
    }

    const content = await fs.readFile(path.join(repo, "file.txt"), "utf8");
    expect(content).toBe("  line1\n  line2-modified\n  line3\n");
  });

  it("succeeds with git-apply-3way when there are minor offsets / changes", async () => {
    const repo = await makeTempRepo({
      "file.txt": "line1\nline2\nline3\nline4\nline5\n",
    });

    const shaResult = await runGit(["rev-parse", "HEAD:file.txt"], { cwd: repo });
    const blobSha = shaResult.stdout.trim();

    await fs.writeFile(path.join(repo, "file.txt"), "line1\nline2\nline3\nline4\nline5-changed\n", "utf8");
    await runGit(["add", "file.txt"], { cwd: repo });
    await runGit(["commit", "-m", "update line 5"], { cwd: repo });

    const diff = `diff --git a/file.txt b/file.txt
index ${blobSha}..0000000 100644
--- a/file.txt
+++ b/file.txt
@@ -1,5 +1,5 @@
 line1
-line2
+line2-modified
 line3
 line4
 line5
`;

    const res = await tryGitApply(repo, diff);
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.method).toBe("git-apply-3way");
    }

    const content = await fs.readFile(path.join(repo, "file.txt"), "utf8");
    expect(content).toBe("line1\nline2-modified\nline3\nline4\nline5-changed\n");
  });

  it("resets working copy and leaves no conflict markers when 3way fails", async () => {
    const repo = await makeTempRepo({
      "file.txt": "line1\nline2\nline3\n",
    });

    const shaResult = await runGit(["rev-parse", "HEAD:file.txt"], { cwd: repo });
    const blobSha = shaResult.stdout.trim();

    await fs.writeFile(path.join(repo, "file.txt"), "line1\nline2-conflicting\nline3\n", "utf8");
    await runGit(["add", "file.txt"], { cwd: repo });
    await runGit(["commit", "-m", "conflict base"], { cwd: repo });

    const diff = `diff --git a/file.txt b/file.txt
index ${blobSha}..0000000 100644
--- a/file.txt
+++ b/file.txt
@@ -1,3 +1,3 @@
 line1
-line2-original-stuff
+line2-modified
 line3
`;

    const res = await tryGitApply(repo, diff);
    expect(res.ok).toBe(false);

    const content = await fs.readFile(path.join(repo, "file.txt"), "utf8");
    expect(content).not.toContain("<<<<<<<");
    expect(content).not.toContain("=======");
    expect(content).not.toContain(">>>>>>>");
    expect(content).toBe("line1\nline2-conflicting\nline3\n");

    const lsFilesResult = await runGit(["ls-files", "-u"], { cwd: repo });
    expect(lsFilesResult.stdout.trim()).toBe("");

    const statusResult = await runGit(["status", "--porcelain"], { cwd: repo });
    expect(statusResult.stdout.trim()).toBe("");
  });

  it("preserves pre-existing dirty content in target files when apply fails", async () => {
    const repo = await makeTempRepo({
      "file.txt": "line1\nline2\nline3\n",
    });

    await fs.writeFile(path.join(repo, "file.txt"), "line1\nline2-dirty-user-edit\nline3\n", "utf8");

    const diff = `diff --git a/file.txt b/file.txt
--- a/file.txt
+++ b/file.txt
@@ -1,3 +1,3 @@
 line1
-line2-does-not-exist
+line2-modified
 line3
`;

    const res = await tryGitApply(repo, diff);
    expect(res.ok).toBe(false);

    const content = await fs.readFile(path.join(repo, "file.txt"), "utf8");
    expect(content).toBe("line1\nline2-dirty-user-edit\nline3\n");
  });

  it("refuses to apply diffs with target paths escaping repoRoot (P1)", async () => {
    const repo = await makeTempRepo({
      "file.txt": "line1\nline2\n",
    });

    const diff = `diff --git a/file.txt b/../file.txt
--- a/file.txt
+++ b/../file.txt
@@ -1,2 +1,2 @@
 line1
-line2
+line2-modified
`;

    const res = await tryGitApply(repo, diff);
    expect(res.ok).toBe(false);
    expect(res.reason).toContain("Path traversal detected");
  });
});
