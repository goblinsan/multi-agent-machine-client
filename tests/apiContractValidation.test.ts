import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { join } from "path";

describe("API Contract Validation", () => {
  it("should not have /v1 prefix in ProjectAPI routes", () => {
    const projectAPIFile = readFileSync(
      join(process.cwd(), "src/dashboard/ProjectAPI.ts"),
      "utf-8",
    );

    const v1Matches = projectAPIFile.match(/[`'"]\/v1\/projects/g);

    if (v1Matches) {
      throw new Error(
        `ProjectAPI contains ${v1Matches.length} references to /v1/projects routes which don't exist in dashboard backend.\n` +
          `Backend uses /projects (no /v1 prefix).\n` +
          `Found: ${v1Matches.join(", ")}`,
      );
    }

    expect(v1Matches).toBeNull();
  });

  it("should not have /v1 prefix in TaskAPI routes", () => {
    const taskAPIFile = readFileSync(
      join(process.cwd(), "src/dashboard/TaskAPI.ts"),
      "utf-8",
    );

    const v1Matches = taskAPIFile.match(/[`'"]\/v1\/(tasks|projects)/g);

    if (v1Matches) {
      throw new Error(
        `TaskAPI contains ${v1Matches.length} references to /v1/* routes which don't exist in dashboard backend.\n` +
          `Backend uses /projects/:projectId/tasks (no /v1 prefix).\n` +
          `Found: ${v1Matches.join(", ")}`,
      );
    }

    expect(v1Matches).toBeNull();
  });

  it("should use /projects/:projectId/tasks routes in TaskAPI", () => {
    const taskAPIFile = readFileSync(
      join(process.cwd(), "src/dashboard/TaskAPI.ts"),
      "utf-8",
    );

    const correctPattern = /\/projects\/[^'"]+\/tasks/;
    const hasCorrectPattern = correctPattern.test(taskAPIFile);

    expect(hasCorrectPattern).toBe(true);
  });
});
