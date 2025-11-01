import { describe, it, expect } from "vitest";
import fs from "fs/promises";
import path from "path";
import _os from "os";
import { applyEditOps } from "../src/fileops";
import { cfg } from "../src/config";
import { makeTempRepo } from "./makeTempRepo";

describe("applyEditOps hunks application", () => {
  it("applies hunks to an existing file when context matches", async () => {
    const repo = await makeTempRepo({
      "package.json": JSON.stringify({ name: "tmp" }),
    });
    const target = path.join(repo, "src");
    await fs.mkdir(target, { recursive: true });
    const filePath = path.join(target, "file.js");
    const base = "line1\nline2-old\nline3\n";
    await fs.writeFile(filePath, base, "utf8");

    const child = await import("child_process");
    child.execSync("git add . && git commit -m base", { cwd: repo });

    const editSpec = {
      ops: [
        {
          action: "upsert",
          path: "src/file.js",
          hunks: [
            {
              oldStart: 1,
              oldCount: 3,
              newStart: 1,
              newCount: 3,
              lines: [" line1", "-line2-old", "+line2-new", " line3"],
            },
          ],
        },
      ],
    };

    const res = await applyEditOps(JSON.stringify(editSpec), {
      repoRoot: repo,
      branchName: "feat/test-hunks",
      commitMessage: "apply hunks",
    });
    expect(res.changed && res.changed.includes("src/file.js")).toBeTruthy();

    const out = await fs.readFile(filePath, "utf8");
    expect(out).toContain("line2-new");
  });

  it("falls back to provided content if context mismatch", async () => {
    const repo = await makeTempRepo({
      "package.json": JSON.stringify({ name: "tmp" }),
    });
    const target = path.join(repo, "src");
    await fs.mkdir(target, { recursive: true });
    const filePath = path.join(target, "file2.js");
    const base = "THIS_DOES_NOT_MATCH\n";
    await fs.writeFile(filePath, base, "utf8");
    const child = await import("child_process");
    child.execSync("git add . && git commit -m base", { cwd: repo });

    const prev = cfg.writeDiagnostics;
    cfg.writeDiagnostics = true;
    try {
      const editSpec = {
        ops: [
          {
            action: "upsert",
            path: "src/file2.js",
            content: "fallback-content\n",
            hunks: [
              {
                oldStart: 1,
                oldCount: 1,
                newStart: 1,
                newCount: 1,
                lines: [" line1", "-line-old", "+line-new"],
              },
            ],
          },
        ],
      };

      const res = await applyEditOps(JSON.stringify(editSpec), {
        repoRoot: repo,
        branchName: "feat/test-hunks-2",
        commitMessage: "apply hunks",
      });
      expect(res.changed && res.changed.includes("src/file2.js")).toBeTruthy();
      const out = await fs.readFile(filePath, "utf8");
      expect(out).toBe("fallback-content\n");

      const diagDir = path.join(repo, "outputs", "diagnostics");
      const diags = await fs.readdir(diagDir).catch(() => []);
      expect(diags.length).toBeGreaterThan(0);

      const first = diags[0];
      const data = JSON.parse(
        await fs.readFile(path.join(diagDir, first), "utf8"),
      );
      expect(data.reason).toBe("hunk_context_mismatch");
    } finally {
      cfg.writeDiagnostics = prev;
    }
  });
});
