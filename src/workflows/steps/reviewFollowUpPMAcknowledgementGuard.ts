import { WorkflowContext } from "../engine/WorkflowContext.js";
import {
  FollowUpTask,
  NormalizedReviewPayload,
} from "./reviewFollowUpTypes.js";

const TEST_KEYWORDS = [
  "test",
  "tests",
  "qa",
  "framework",
  "harness",
  "runner",
  "vitest",
  "jest",
  "pytest",
  "coverage",
  "validation",
  "spec",
];

export function enforcePMAcknowledgement(
  context: WorkflowContext,
  normalizedReview: NormalizedReviewPayload | null,
  followUps: FollowUpTask[],
  fallbackReviewType: string,
  stepName: string,
): void {
  const reviewType = normalizedReview?.reviewType || fallbackReviewType;
  if (reviewType !== "qa") {
    return;
  }
  if (!normalizedReview?.hasBlockingIssues) {
    return;
  }
  const blockingIssues = normalizedReview.blockingIssues || [];
  if (blockingIssues.length === 0) {
    return;
  }

  const requiresTestKeywords = blockingIssues.some((issue) =>
    containsTestKeyword(`${issue.title || ""} ${issue.description || ""}`),
  );
  if (!requiresTestKeywords) {
    return;
  }

  const pmMentionedTests = followUps.some((task) =>
    containsTestKeyword(`${task.title || ""} ${task.description || ""}`),
  );

  if (!pmMentionedTests) {
    context.logger.error("PM response ignored QA test failure", {
      stepName,
      reviewType,
      blockingIssueCount: blockingIssues.length,
      followUpCount: followUps.length,
    });
    throw new Error(
      "PM decision ignored QA test failure: no test remediation tasks present",
    );
  }
}

function containsTestKeyword(text?: string): boolean {
  if (!text) {
    return false;
  }
  const normalized = text.toLowerCase();
  return TEST_KEYWORDS.some((keyword) => normalized.includes(keyword));
}
