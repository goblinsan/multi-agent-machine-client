import { describe, it, expect } from "vitest";
import { TaskDuplicateDetector } from "../../../../src/workflows/steps/helpers/TaskDuplicateDetector.js";

describe("TaskDuplicateDetector", () => {
  const detector = new TaskDuplicateDetector();

  it("computes stable hashes for normalized content", () => {
    const taskA = {
      title: "Fix: login failure",
      description: "Ensure login failures clear the global error banner.",
      milestone_slug: "stability",
    };

    const taskB = {
      title: "Fix login failure",
      description: "ensure login failures clear the global error banner",
      milestone_slug: "stability",
    };

    const hashA = detector.getContentHash(taskA);
    const hashB = detector.getContentHash(taskB);

    expect(hashA).toBeTruthy();
    expect(hashA).toBe(hashB);
  });

  it("detects duplicates via content hash strategy even with phrasing changes", () => {
    const existingTasks = [
      {
        id: "task-500",
        title: "Improve diff summaries",
        description:
          "Normalize git diff summaries before sharing with the PM persona.",
        milestone_slug: "platform",
      },
    ];

    const candidate = {
      title: "Normalize git diff summaries",
      description:
        "Normalize git diff summaries before sharing with the PM persona to reduce noise for PM review.",
      milestone_slug: "platform",
    };

    const match = detector.findDuplicateWithDetails(
      candidate,
      existingTasks,
      "content_hash",
    );

    expect(match).not.toBeNull();
    expect(match?.strategy).toBe("content_hash");
    expect(match?.matchScore).toBeGreaterThanOrEqual(70);
  });

  it("does not match content hashes when milestone slugs differ", () => {
    const existingTasks = [
      {
        id: "task-900",
        title: "Audit retry logging",
        description: "Document the retry logging gaps in queue consumers.",
        milestone_slug: "observability",
      },
    ];

    const candidate = {
      title: "Audit retry logging",
      description: "Document the retry logging gaps in queue consumers.",
      milestone_slug: "stability",
    };

    const match = detector.findDuplicateWithDetails(
      candidate,
      existingTasks,
      "content_hash",
    );

    expect(match).toBeNull();
  });

  it("does not fuzzy-match distinct baseline repair files", () => {
    const existingTasks = [
      {
        id: "56",
        title:
          "Fix baseline compile errors in src/__tests__/config-loader.test.ts",
        description:
          "Details: src/__tests__/config-loader.test.ts has compile errors. Acceptance criteria: npx tsc --noEmit reports zero errors.",
        milestone_slug: "machine-client-log-summarizer",
        external_id:
          "baseline-repair-src___tests___config-loader.test.ts",
      },
    ];

    const candidate = {
      title:
        "Fix baseline compile errors in src/config/retention-engine.ts",
      description:
        "Details: src/config/retention-engine.ts has compile errors. Acceptance criteria: npx tsc --noEmit reports zero errors.",
      milestone_slug: "machine-client-log-summarizer",
      external_id: "baseline-repair-src_config_retention-engine.ts",
    };

    const match = detector.findDuplicateWithDetails(
      candidate,
      existingTasks,
      "content_hash",
    );

    expect(match).toBeNull();
  });

  it("matches baseline repair tasks with the same external id", () => {
    const existingTasks = [
      {
        id: "56",
        title:
          "Fix baseline compile errors in src/__tests__/config-loader.test.ts",
        description:
          "Details: src/__tests__/config-loader.test.ts has compile errors.",
        milestone_slug: "machine-client-log-summarizer",
        external_id:
          "baseline-repair-src___tests___config-loader.test.ts",
      },
    ];

    const candidate = {
      title:
        "Fix baseline compile errors in src/__tests__/config-loader.test.ts",
      description:
        "Details: src/__tests__/config-loader.test.ts has compile errors.",
      milestone_slug: "machine-client-log-summarizer",
      external_id:
        "baseline-repair-src___tests___config-loader.test.ts",
    };

    const match = detector.findDuplicateWithDetails(
      candidate,
      existingTasks,
      "content_hash",
    );

    expect(match?.duplicate.id).toBe("56");
    expect(match?.matchScore).toBe(100);
  });
});
