import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "fs/promises";
import os from "os";
import path from "path";
import { execSync } from "child_process";
import {
  incrementalScan,
  computeDelta,
  assessAnalysisReuse,
  filterPathsBySpec,
  getGitDelta,
  getHeadSha,
} from "../src/workflows/steps/context/IncrementalScan";
import { scanRepo, ScanSpec } from "../src/scanRepo";
import { makeTempRepo } from "./makeTempRepo";

function specFor(root: string): ScanSpec {
  return {
    repo_root: root,
    include: ["**/*"],
    exclude: ["node_modules/**", ".git/**", ".ma/**"],
    max_files: 1000,
    max_bytes: 10 * 1024 * 1024,
    max_depth: 10,
    track_lines: true,
    track_hash: false,
  };
}

describe("incrementalScan", () => {
  let root: string;

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), "inc-scan-"));
    await fs.mkdir(path.join(root, "src"), { recursive: true });
    await fs.writeFile(path.join(root, "src/a.ts"), "line1\nline2\n");
    await fs.writeFile(path.join(root, "src/b.ts"), "one\ntwo\nthree\n");
    await fs.writeFile(path.join(root, "README.md"), "# readme\n");
  });

  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });

  it("carries over unchanged files without reading them", async () => {
    const previous = await scanRepo(specFor(root));
    expect(previous.every((f) => typeof f.lines === "number")).toBe(true);

    await fs.writeFile(path.join(root, "src/a.ts"), "line1\nline2\nline3\n");

    const result = await incrementalScan(specFor(root), previous, null);
    expect(result.files).toHaveLength(3);
    expect(result.readCount).toBe(1);
    expect(result.carriedCount).toBe(2);

    const a = result.files.find((f) => f.path === "src/a.ts");
    expect(a?.lines).toBe(4);
    const b = result.files.find((f) => f.path === "src/b.ts");
    expect(b?.lines).toBe(4);
  });

  it("uses the git delta to skip mtime-churned but unchanged files", async () => {
    const previous = await scanRepo(specFor(root));

    const now = new Date();
    await fs.utimes(path.join(root, "src/b.ts"), now, now);
    await fs.utimes(path.join(root, "README.md"), now, now);

    const result = await incrementalScan(
      specFor(root),
      previous,
      new Set<string>(),
    );
    expect(result.readCount).toBe(0);
    expect(result.carriedCount).toBe(3);
  });

  it("detects added and removed files", async () => {
    const previous = await scanRepo(specFor(root));

    await fs.writeFile(path.join(root, "src/new.ts"), "fresh\n");
    await fs.unlink(path.join(root, "README.md"));

    const result = await incrementalScan(specFor(root), previous, null);
    const delta = computeDelta(previous, result.files, null);

    expect(delta.added).toEqual(["src/new.ts"]);
    expect(delta.removed).toEqual(["README.md"]);
    expect(delta.modified).toEqual([]);
  });
});

describe("computeDelta", () => {
  it("flags files as modified when git reports them changed", () => {
    const prev = [{ path: "src/a.ts", bytes: 10, mtime: 1, lines: 2 }];
    const cur = [{ path: "src/a.ts", bytes: 10, mtime: 99, lines: 2 }];

    expect(computeDelta(prev, cur, new Set(["src/a.ts"])).modified).toEqual([
      "src/a.ts",
    ]);
    expect(computeDelta(prev, cur, new Set()).modified).toEqual([]);
  });
});

describe("assessAnalysisReuse", () => {
  const previous = [
    { path: "src/a.ts", bytes: 10, mtime: 1 },
    { path: "src/b.ts", bytes: 10, mtime: 1 },
  ];

  it("reuses analysis for small non-structural deltas", () => {
    const result = assessAnalysisReuse(
      { added: [], modified: ["src/a.ts"], removed: [] },
      previous,
    );
    expect(result.reusable).toBe(true);
  });

  it("requires analysis when structural files change", () => {
    for (const file of [
      "package.json",
      "tsconfig.json",
      "vite.config.ts",
      "Dockerfile",
      ".github/workflows/ci.yml",
    ]) {
      const result = assessAnalysisReuse(
        { added: [], modified: [file], removed: [] },
        previous,
      );
      expect(result.reusable, file).toBe(false);
    }
  });

  it("requires analysis when a new file extension appears", () => {
    const result = assessAnalysisReuse(
      { added: ["scripts/tool.py"], modified: [], removed: [] },
      previous,
    );
    expect(result.reusable).toBe(false);
  });

  it("requires analysis when too many files change", () => {
    const modified = Array.from({ length: 11 }, (_, i) => `src/f${i}.ts`);
    const result = assessAnalysisReuse(
      { added: [], modified, removed: [] },
      previous,
    );
    expect(result.reusable).toBe(false);
  });
});

describe("filterPathsBySpec", () => {
  it("applies include and exclude patterns", () => {
    const filtered = filterPathsBySpec(
      ["src/a.ts", "node_modules/x/index.js", ".ma/context/summary.md"],
      ["**/*"],
      ["node_modules/**", ".ma/**"],
    );
    expect([...filtered]).toEqual(["src/a.ts"]);
  });
});

describe("git delta helpers", () => {
  it("reports committed and worktree changes since a sha", async () => {
    const repo = await makeTempRepo({
      "src/a.ts": "one\n",
      "src/b.ts": "two\n",
    });

    const baseSha = await getHeadSha(repo);
    expect(baseSha).toMatch(/^[0-9a-f]{40}$/);

    await fs.writeFile(path.join(repo, "src/a.ts"), "one changed\n");
    execSync("git add . && git commit -q -m change", { cwd: repo });
    await fs.writeFile(path.join(repo, "src/b.ts"), "two dirty\n");
    await fs.writeFile(path.join(repo, "src/untracked.ts"), "new\n");

    const delta = await getGitDelta(repo, baseSha!);
    expect(delta.ok).toBe(true);
    expect(delta.changed.has("src/a.ts")).toBe(true);
    expect(delta.changed.has("src/b.ts")).toBe(true);
    expect(delta.changed.has("src/untracked.ts")).toBe(true);
  });

  it("fails soft on an unknown sha", async () => {
    const repo = await makeTempRepo({ "a.txt": "x\n" });
    const delta = await getGitDelta(repo, "deadbeef".repeat(5));
    expect(delta.ok).toBe(false);
  });
});
