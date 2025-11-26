import { describe, it, expect } from "vitest";
import { WorkflowSelector } from "../src/workflows/coordinator/WorkflowSelector.js";

describe("WorkflowSelector task type detection", () => {
  const selector = new WorkflowSelector();

  it("classifies review follow-up descriptions as analysis", () => {
    const task = {
      title: "Qa Follow_up: qa failure (HIGH)",
      description:
        "Severity: high\nCategory: follow_up\nSource: normalized_blocking\nDetails: Review failed",
    };

    expect(selector.determineTaskType(task)).toBe("analysis");
  });

  it("detects review gap titles", () => {
    const task = {
      title: "Review Gap: CODE_REVIEW",
      description: "Review reported the following issue: add missing coverage",
    };

    expect(selector.determineTaskType(task)).toBe("analysis");
  });

  it("falls back to feature for unrelated tasks", () => {
    const task = {
      title: "Implement metrics endpoint",
      description: "Add a Prometheus metrics endpoint for the API",
    };

    expect(selector.determineTaskType(task)).toBe("feature");
  });

  it("treats analysis-derived implementation tasks as non-analysis", () => {
    const task = {
      title: "Implement unit tests for App",
      labels: [
        "qa_follow_up",
        "analysis-derived",
        "ready-for-implementation",
      ],
    };

    expect(selector.determineTaskType(task)).toBe("feature");
  });
});
