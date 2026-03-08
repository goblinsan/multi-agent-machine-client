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

  it("injects file-specific issue from pre_qa_test_error with esbuild-style error", async () => {
    const step = new ReviewFailureNormalizationStep({
      name: "normalize_review_failure",
      type: "ReviewFailureNormalizationStep",
      config: {
        review_type: "qa",
        review_status: "fail",
        review_result: { status: "fail", summary: "Tests failed" },
        pre_qa_test_error: 'vitest.config.ts:5:7: ERROR: Expected ":" but found "default"',
      },
    });

    const result = await step.execute(context);
    const normalized = result.outputs?.normalized_review;

    const preQaIssue = normalized?.issues?.find(
      (i: any) => i.id?.startsWith("pre-qa-test-error-"),
    );
    expect(preQaIssue).toBeDefined();
    expect(preQaIssue?.file).toBe("vitest.config.ts");
    expect(preQaIssue?.line).toBe(5);
    expect(preQaIssue?.severity).toBe("critical");
    expect(preQaIssue?.blocking).toBe(true);
    expect(preQaIssue?.title).toContain("vitest.config.ts");
    expect(preQaIssue?.labels).toContain("pre-qa-test-error");
  });

  it("creates generic blocking issue when pre_qa_test_error has no parseable file/line", async () => {
    const step = new ReviewFailureNormalizationStep({
      name: "normalize_review_failure",
      type: "ReviewFailureNormalizationStep",
      config: {
        review_type: "qa",
        review_status: "fail",
        review_result: { status: "fail", summary: "Tests failed" },
        pre_qa_test_error: "ENOENT: no such file or directory, open '/tmp/package.json'",
      },
    });

    const result = await step.execute(context);
    const normalized = result.outputs?.normalized_review;

    const preQaIssue = normalized?.issues?.find(
      (i: any) => i.id === "pre-qa-test-error",
    );
    expect(preQaIssue).toBeDefined();
    expect(preQaIssue?.severity).toBe("critical");
    expect(preQaIssue?.blocking).toBe(true);
    expect(preQaIssue?.title).toBe("Pre-QA test execution failure");
  });

  it("skips pre_qa_test_error injection when error is empty", async () => {
    const step = new ReviewFailureNormalizationStep({
      name: "normalize_review_failure",
      type: "ReviewFailureNormalizationStep",
      config: {
        review_type: "qa",
        review_status: "fail",
        review_result: {
          status: "fail",
          root_causes: [{ title: "missing_deps", description: "deps missing", severity: "high" }],
        },
        pre_qa_test_error: "",
      },
    });

    const result = await step.execute(context);
    const normalized = result.outputs?.normalized_review;

    const preQaIssues = normalized?.issues?.filter(
      (i: any) => i.id?.startsWith("pre-qa-test-error"),
    );
    expect(preQaIssues).toHaveLength(0);
    expect(normalized?.blockingIssues).toHaveLength(1);
    expect(normalized?.blockingIssues[0]?.title).toBe("missing_deps");
  });
});

describe("ReviewFailureNormalizationStep.parseTestErrors", () => {
  it("parses esbuild-style errors (file:line:col: ERROR: message)", () => {
    const errors = ReviewFailureNormalizationStep.parseTestErrors(
      'vitest.config.ts:5:7: ERROR: Expected ":" but found "default"',
    );
    expect(errors).toHaveLength(1);
    expect(errors[0]).toEqual({
      file: "vitest.config.ts",
      line: 5,
      message: 'Expected ":" but found "default"',
    });
  });

  it("parses multiple errors from multi-line output", () => {
    const input = [
      'src/index.ts:10:3: ERROR: Unexpected token',
      'src/utils.ts:22:5: ERROR: Cannot find module',
    ].join("\n");
    const errors = ReviewFailureNormalizationStep.parseTestErrors(input);
    expect(errors).toHaveLength(2);
    expect(errors[0]?.file).toBe("src/index.ts");
    expect(errors[1]?.file).toBe("src/utils.ts");
  });

  it("deduplicates errors at same file:line", () => {
    const input = [
      'app.ts:5:1: ERROR: Syntax error',
      'app.ts:5:3: ERROR: Another error same line',
    ].join("\n");
    const errors = ReviewFailureNormalizationStep.parseTestErrors(input);
    expect(errors).toHaveLength(1);
    expect(errors[0]?.file).toBe("app.ts");
  });

  it("returns empty array for non-matching text", () => {
    const errors = ReviewFailureNormalizationStep.parseTestErrors("npm ERR! code ELIFECYCLE");
    expect(errors).toHaveLength(0);
  });

  it("parses TypeScript compiler errors (file(line,col): error TSxxxx: message)", () => {
    const errors = ReviewFailureNormalizationStep.parseTestErrors(
      "src/config.ts(12,5): error TS2322: Type 'string' is not assignable to type 'number'",
    );
    expect(errors).toHaveLength(1);
    expect(errors[0]).toEqual({
      file: "src/config.ts",
      line: 12,
      message: "Type 'string' is not assignable to type 'number'",
    });
  });
});
