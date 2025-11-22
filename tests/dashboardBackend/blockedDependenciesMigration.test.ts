import { describe, it, expect, vi } from "vitest";
import { runMigrations } from "../../src/dashboard-backend/src/db/migrations.js";

describe("dashboard backend migrations", () => {
  it("adds blocked_dependencies column when tasks table is missing it", () => {
    const exec = vi
      .fn()
      .mockReturnValueOnce([{ values: [["projects"]] }])
      .mockReturnValueOnce([{ values: [[0, "id"], [1, "title"]] }]);

    const run = vi.fn();

    runMigrations({ exec, run } as any);

    expect(run).toHaveBeenCalledWith("PRAGMA foreign_keys = ON;");
    expect(run).toHaveBeenCalledWith(
      "ALTER TABLE tasks ADD COLUMN blocked_dependencies TEXT",
    );
  });

  it("skips adding the column when it already exists", () => {
    const exec = vi
      .fn()
      .mockReturnValueOnce([{ values: [["projects"]] }])
      .mockReturnValueOnce([
        {
          values: [
            [0, "id"],
            [1, "title"],
            [2, "blocked_dependencies"],
          ],
        },
      ]);

    const run = vi.fn();

    runMigrations({ exec, run } as any);

    const alterCalls = run.mock.calls.filter((call) => {
      const [sql] = call;
      return typeof sql === "string" && sql.includes("ALTER TABLE tasks");
    });
    expect(alterCalls.length).toBe(0);
  });
});
