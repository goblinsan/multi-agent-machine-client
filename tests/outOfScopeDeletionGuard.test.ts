import { describe, it, expect } from "vitest";
import fs from "fs/promises";
import path from "path";
import { makeTempRepo } from "./makeTempRepo.js";
import { restoreOutOfScopeDeletions } from "../src/workflows/steps/helpers/outOfScopeDeletionGuard.js";

describe("restoreOutOfScopeDeletions", () => {
  it("restores a deleted file that is outside the allowed scope", async () => {
    const repo = await makeTempRepo({
      "src/views/ProjectsView.tsx": "export const a = 1;\n",
      "src/views/TaskBoardView.tsx": "export const b = 2;\n",
    });
    await fs.unlink(path.join(repo, "src/views/TaskBoardView.tsx"));

    const result = await restoreOutOfScopeDeletions(repo, [
      "src/views/ProjectsView.tsx",
    ]);

    expect(result.restored).toContain("src/views/TaskBoardView.tsx");
    const exists = await fs
      .access(path.join(repo, "src/views/TaskBoardView.tsx"))
      .then(() => true)
      .catch(() => false);
    expect(exists).toBe(true);
  });

  it("leaves an in-scope deletion alone", async () => {
    const repo = await makeTempRepo({
      "src/views/ProjectsView.tsx": "export const a = 1;\n",
      "src/old.ts": "export const c = 3;\n",
    });
    await fs.unlink(path.join(repo, "src/old.ts"));

    const result = await restoreOutOfScopeDeletions(repo, ["src/old.ts"]);

    expect(result.restored).toHaveLength(0);
    const exists = await fs
      .access(path.join(repo, "src/old.ts"))
      .then(() => true)
      .catch(() => false);
    expect(exists).toBe(false);
  });

  it("no-ops when no allowed scope is provided", async () => {
    const repo = await makeTempRepo({ "src/a.ts": "export const a = 1;\n" });
    await fs.unlink(path.join(repo, "src/a.ts"));
    const result = await restoreOutOfScopeDeletions(repo, undefined);
    expect(result.restored).toHaveLength(0);
  });
});
