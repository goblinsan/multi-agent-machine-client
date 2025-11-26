import { describe, it, expect, beforeEach, vi } from "vitest";
import { WorkflowContext } from "../../src/workflows/engine/WorkflowContext.js";
import { ReviewFollowUpFilterStep } from "../../src/workflows/steps/ReviewFollowUpFilterStep.js";

vi.mock("../../src/logger.js", () => ({
  logger: {
    info: vi.fn(),
    debug: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

describe("ReviewFollowUpFilterStep", () => {
  let context: WorkflowContext;
  let transport: any;

  beforeEach(() => {
    transport = {};
    context = new WorkflowContext(
      "wf-review-filter",
      "proj-001",
      "/tmp/repo",
      "main",
      {
        name: "test-workflow",
        version: "1.0.0",
        steps: [],
      },
      transport,
      {},
    );
  });

  it("drops duplicates when an existing task matches title and milestone", async () => {
    const step = new ReviewFollowUpFilterStep({
      name: "filter_followups",
      type: "ReviewFollowUpFilterStep",
      config: {
        milestone_context: { slug: "milestone-dashboard" },
        tasks: [
          { title: "Harden telemetry uploader", description: "repeat work" },
          { title: "Extend metrics coverage", description: "new task" },
        ],
        existing_tasks: [
          {
            id: "42",
            title: "Harden telemetry uploader",
            milestone_slug: "milestone-dashboard",
            description: "already tracked",
          },
        ],
      },
    });

    const result = await step.execute(context);

    expect(result.status).toBe("success");
    expect(result.outputs?.filtered_tasks).toHaveLength(1);
    expect(result.outputs?.filtered_tasks?.[0].title).toBe(
      "Extend metrics coverage",
    );
    expect(result.outputs?.dropped_tasks).toEqual([
      {
        title: "Harden telemetry uploader",
        reason: "duplicate_existing_task",
      },
    ]);
  });

  it("drops recommendations that do not match milestone keywords", async () => {
    const step = new ReviewFollowUpFilterStep({
      name: "filter_followups",
      type: "ReviewFollowUpFilterStep",
      config: {
        milestone_context: { name: "Dashboard reliability sprint" },
        tasks: [
          { title: "Revamp auth module", description: "Improve login" },
          {
            title: "Fix dashboard loading",
            description: "Dashboard times out",
          },
        ],
      },
    });

    const result = await step.execute(context);

    expect(result.status).toBe("success");
    expect(result.outputs?.filtered_tasks).toHaveLength(1);
    expect(result.outputs?.filtered_tasks?.[0].title).toBe(
      "Fix dashboard loading",
    );
    expect(result.outputs?.dropped_tasks).toEqual([
      {
        title: "Revamp auth module",
        reason: "unaligned_with_milestone",
      },
    ]);
  });

  it("rejects file-specific tasks that reference files outside the diff", async () => {
    const step = new ReviewFollowUpFilterStep({
      name: "filter_followups",
      type: "ReviewFollowUpFilterStep",
      config: {
        diff_changed_files: ["src/ui/App.tsx"],
        tasks: [
          {
            title: "Audit backend handler",
            description: "Investigate server/api/user.ts for leaks",
          },
          {
            title: "Repair chart rendering",
            description: "Check src/ui/App.tsx regressions",
          },
        ],
      },
    });

    const result = await step.execute(context);

    expect(result.status).toBe("success");
    expect(result.outputs?.filtered_tasks).toHaveLength(1);
    expect(result.outputs?.filtered_tasks?.[0].title).toBe(
      "Repair chart rendering",
    );
    expect(result.outputs?.dropped_tasks).toEqual([
      {
        title: "Audit backend handler",
        reason: "file_not_in_current_diff",
      },
    ]);
  });

  it("keeps auto-generated tasks even if milestone keywords do not match", async () => {
    const step = new ReviewFollowUpFilterStep({
      name: "filter_followups",
      type: "ReviewFollowUpFilterStep",
      config: {
        milestone_context: { name: "Telemetry hardening" },
        tasks: [
          {
            title: "Restore vitest harness",
            description: "QA reviewer cannot run tests",
            metadata: { auto_generated: true },
          },
          {
            title: "Rework auth pipeline",
            description: "auth module needs love",
          },
        ],
      },
    });

    const result = await step.execute(context);

    expect(result.status).toBe("success");
    expect(result.outputs?.filtered_tasks).toHaveLength(1);
    expect(result.outputs?.filtered_tasks?.[0].title).toBe(
      "Restore vitest harness",
    );
    expect(result.outputs?.dropped_tasks).toEqual([
      {
        title: "Rework auth pipeline",
        reason: "unaligned_with_milestone",
      },
    ]);
  });
});
