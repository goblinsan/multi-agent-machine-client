import { describe, it, expect, beforeEach, vi } from "vitest";
import { WorkflowContext } from "../../src/workflows/engine/WorkflowContext.js";
import { ReviewFailureNormalizationStep } from "../../src/workflows/steps/ReviewFailureNormalizationStep.js";
import type { MessageTransport } from "../../src/transport/MessageTransport.js";

vi.mock("../../src/logger.js", () => ({
  logger: {
    info: vi.fn(),
    debug: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

describe("ReviewFailureNormalizationStep", () => {
  let context: WorkflowContext;
  let transport: MessageTransport;

  beforeEach(() => {
    transport = {
      connect: vi.fn().mockResolvedValue(undefined),
      disconnect: vi.fn().mockResolvedValue(undefined),
      xAdd: vi.fn().mockResolvedValue("0-0"),
      xGroupCreate: vi.fn().mockResolvedValue(undefined),
      xReadGroup: vi.fn().mockResolvedValue(null),
      xRead: vi.fn().mockResolvedValue(null),
      xAck: vi.fn().mockResolvedValue(0),
      xLen: vi.fn().mockResolvedValue(0),
      del: vi.fn().mockResolvedValue(0),
      xInfoGroups: vi.fn().mockResolvedValue([]),
      xGroupDestroy: vi.fn().mockResolvedValue(true),
      quit: vi.fn().mockResolvedValue(undefined),
    };

    context = new WorkflowContext(
      "wf-normalization",
      "proj-qa",
      "/tmp/repo",
      "main",
      {
        name: "review-normalization",
        version: "1.0.0",
        steps: [],
      },
      transport,
      {},
    );
  });

  it("parses nested output payloads so QA root causes are retained", async () => {
    const reviewResult = {
      output: JSON.stringify({
        status: "fail",
        summary: "QA could not execute npm test",
        root_causes: [
          {
            title: "missing_test_infrastructure",
            description: "No npm test script configured",
            severity: "high",
          },
        ],
      }),
    };

    const step = new ReviewFailureNormalizationStep({
      name: "normalize_review_failure",
      type: "ReviewFailureNormalizationStep",
      config: {
        review_type: "qa",
        review_status: "fail",
        review_result: reviewResult,
      },
    });

    const result = await step.execute(context);
    const normalized = result.outputs?.normalized_review;

    expect(normalized?.blockingIssues).toHaveLength(1);
    expect(normalized?.blockingIssues[0]?.title).toBe(
      "missing_test_infrastructure",
    );
    expect(normalized?.blockingIssues[0]?.description).toContain("npm test");
    expect(result.outputs?.blocking_issue_count).toBe(1);
  });

  it("handles review_result provided as a JSON string", async () => {
    const step = new ReviewFailureNormalizationStep({
      name: "normalize_review_failure",
      type: "ReviewFailureNormalizationStep",
      config: {
        review_type: "qa",
        review_status: "fail",
        review_result: JSON.stringify({
          status: "fail",
          root_causes: [
            {
              title: "missing_tests",
              description: "Project lacks any regression coverage",
              severity: "critical",
            },
          ],
        }),
      },
    });

    const result = await step.execute(context);
    const normalized = result.outputs?.normalized_review;

    expect(normalized?.blockingIssues).toHaveLength(1);
    expect(normalized?.blockingIssues[0]?.title).toBe("missing_tests");
    expect(normalized?.blockingIssues[0]?.severity).toBe("critical");
  });
});
