import { describe, it, expect, vi } from "vitest";
import { exec } from "child_process";
import { promisify } from "util";
import { makeTempRepo } from "./makeTempRepo";
import {
  changeBranchName,
  fileBranchName,
  isFileBranchOf,
  toBranchSegment,
} from "../src/git/branchNaming";

const execP = promisify(exec);
vi.mock("../src/redisClient.js");

describe("branchNaming", () => {
  it("builds a change branch from a slug", () => {
    expect(changeBranchName("openapi-layer")).toBe("change/openapi-layer");
  });

  it("sanitizes a file path into one safe branch segment", () => {
    expect(fileBranchName("openapi", "src/routes/openapi.ts")).toBe(
      "change/openapi__src-routes-openapi-ts",
    );
  });

  it("keeps the file branch a SIBLING of the change branch, not a child", () => {
    const change = changeBranchName("openapi");
    const file = fileBranchName("openapi", "src/routes/openapi.ts");
    expect(file.startsWith(`${change}/`)).toBe(false);
  });

  it("recognizes its own file branches", () => {
    expect(
      isFileBranchOf("openapi", fileBranchName("openapi", "src/a.ts")),
    ).toBe(true);
    expect(isFileBranchOf("openapi", "change/other__src-a-ts")).toBe(false);
  });

  it("throws on an empty slug or file id", () => {
    expect(() => changeBranchName("///")).toThrow();
    expect(() => fileBranchName("openapi", "...")).toThrow();
  });

  it("normalizes to lowercase kebab segments", () => {
    expect(toBranchSegment("Src/Routes/Open API.ts")).toBe(
      "src-routes-open-api-ts",
    );
  });

  it("git accepts the change branch and a file branch together (no ref collision)", async () => {
    const repo = await makeTempRepo({ "README.md": "# t\n" });
    const change = changeBranchName("openapi");
    const fileA = fileBranchName("openapi", "src/routes/openapi.ts");
    const fileB = fileBranchName("openapi", "tests/openapi.test.ts");

    await execP(`git checkout -b ${change}`, { cwd: repo });
    await execP(`git checkout -b ${fileA}`, { cwd: repo });
    await execP(`git checkout ${change}`, { cwd: repo });
    await execP(`git checkout -b ${fileB}`, { cwd: repo });

    const { stdout } = await execP("git branch", { cwd: repo });
    expect(stdout).toContain(change);
    expect(stdout).toContain(fileA);
    expect(stdout).toContain(fileB);
  });
});
