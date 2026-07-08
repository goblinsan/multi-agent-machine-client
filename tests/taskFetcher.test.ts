import { describe, it, expect } from "vitest";
import { TaskFetcher } from "../src/workflows/coordinator/TaskFetcher.js";

describe("TaskFetcher.normalizeTaskStatus", () => {
  const fetcher = new TaskFetcher();

  it("treats archived and cancelled tasks as terminal", () => {
    expect(fetcher.normalizeTaskStatus("archived")).toBe("done");
    expect(fetcher.normalizeTaskStatus("cancelled")).toBe("done");
    expect(fetcher.normalizeTaskStatus("canceled")).toBe("done");
  });

  it("still recognizes standard done aliases", () => {
    expect(fetcher.normalizeTaskStatus("done")).toBe("done");
    expect(fetcher.normalizeTaskStatus("completed")).toBe("done");
    expect(fetcher.normalizeTaskStatus("resolved")).toBe("done");
  });

  it("does not mark active statuses as terminal", () => {
    expect(fetcher.normalizeTaskStatus("open")).toBe("open");
    expect(fetcher.normalizeTaskStatus("in_progress")).toBe("in_progress");
    expect(fetcher.normalizeTaskStatus("blocked")).toBe("blocked");
    expect(fetcher.normalizeTaskStatus("in_review")).toBe("in_review");
  });

  it("excludes archived tasks from the actionable filter", () => {
    const tasks = [
      { id: 1, status: "open" },
      { id: 52, status: "archived" },
      { id: 54, status: "archived" },
      { id: 56, status: "in_progress" },
    ];

    const pending = tasks.filter(
      (task) => fetcher.normalizeTaskStatus(task.status) !== "done",
    );

    expect(pending.map((t) => t.id)).toEqual([1, 56]);
  });
});
