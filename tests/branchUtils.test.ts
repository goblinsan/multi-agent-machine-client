import { describe, it, expect } from "vitest";
import { buildBranchName } from "../src/branchUtils.js";

describe("buildBranchName", () => {
  it("uses explicit milestone branch when provided", () => {
    const name = buildBranchName(
      { branch: "release/v1" },
      {},
      "proj",
      "ml",
      "task",
    );
    expect(name).toBe("release/v1");
  });

  it("uses explicit task branch when milestone branch absent", () => {
    const name = buildBranchName(
      {},
      { branchName: "feat/xyz" },
      "proj",
      "ml",
      "task",
    );
    expect(name).toBe("feat/xyz");
  });

  it("falls back to feat/taskSlug when provided", () => {
    const name = buildBranchName({}, {}, "proj", "ml", "make-api");
    expect(name).toBe("feat/make-api");
  });

  it("falls back to milestone/milestoneSlug when slug is not generic", () => {
    const name = buildBranchName({}, {}, "proj", "refactor-module", null);
    expect(name).toBe("milestone/refactor-module");
  });

  it("avoids milestone/milestone and uses project slug instead", () => {
    const name = buildBranchName({}, {}, "project-slug", "milestone", null);
    expect(name).toBe("milestone/project-slug");
  });
});
