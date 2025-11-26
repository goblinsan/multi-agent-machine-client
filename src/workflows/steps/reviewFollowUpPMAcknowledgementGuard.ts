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

const INFRA_KEYWORDS = [
  "test framework",
  "testing framework",
  "missing test",
  "no test",
  "unable to run tests",
  "testing infrastructure",
  "qa infrastructure",
  "add tests",
  "add a test",
  "add vitest",
  "add jest",
  "add pytest",
  "test harness",
  "test runner",
  "build tests",
  "restore tests",
  "implement tests",
];

type BlockingIssue = NonNullable<
  NormalizedReviewPayload["blockingIssues"]
>[number];

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

  const keywordMatches = blockingIssues
    .map((issue) => {
      const text = `${issue.title || ""} ${issue.description || ""}`.trim();
      return {
        id: issue.id,
        text,
        matched: containsTestKeyword(text),
      };
    })
    .filter((match) => match.matched);

  const requiresTestKeywords = keywordMatches.length > 0;
  const infraIssues = blockingIssues.filter((issue) => isInfraIssue(issue));
  const requiresInfraTasks = infraIssues.length > 0;
  if (!requiresTestKeywords) {
    context.logger.info("QA follow-up guard evaluated", {
      stepName,
      reviewType,
      blockingIssueCount: blockingIssues.length,
      keywordIssueCount: keywordMatches.length,
      pmMentionedTests: false,
      followUpCount: followUps.length,
      keywordIssueSamples: keywordMatches.slice(0, 3),
    });
    return;
  }

  const pmMentionedTests = followUps.some((task) =>
    containsTestKeyword(`${task.title || ""} ${task.description || ""}`),
  );
  const pmProvidedInfraTask = followUps.some((task) =>
    containsInfraKeyword(`${task.title || ""} ${task.description || ""}`),
  );

  context.logger.info("QA follow-up guard evaluated", {
    stepName,
    reviewType,
    blockingIssueCount: blockingIssues.length,
    keywordIssueCount: keywordMatches.length,
    pmMentionedTests,
    requiresInfraTasks,
    pmProvidedInfraTask,
    followUpCount: followUps.length,
    keywordIssueSamples: keywordMatches.slice(0, 3),
  });

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

  if (requiresInfraTasks && !pmProvidedInfraTask) {
    context.logger.error("PM response ignored QA test infrastructure gap", {
      stepName,
      reviewType,
      infraIssueCount: infraIssues.length,
      followUpCount: followUps.length,
    });
    throw new Error(
      "PM decision ignored QA infrastructure failure: missing follow-up to restore test framework",
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

function containsInfraKeyword(text?: string): boolean {
  if (!text) {
    return false;
  }
  const normalized = text.toLowerCase();
  return INFRA_KEYWORDS.some((keyword) => normalized.includes(keyword));
}

function isInfraIssue(issue: BlockingIssue): boolean {
  const text = `${issue.title || ""} ${issue.description || ""}`.toLowerCase();
  const hasInfraLabel = Array.isArray(issue.labels)
    ? issue.labels.some((label: string) => label === "infra")
    : false;
  return hasInfraLabel || INFRA_KEYWORDS.some((keyword) => text.includes(keyword));
}
