import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { join } from "path";
import * as yaml from "yaml";

describe("TDD Context in Review Payloads", () => {
  const templatePath = join(
    __dirname,
    "../src/workflows/templates/step-templates.yaml",
  );
  const inReviewFlowPath = join(
    __dirname,
    "../src/workflows/definitions/in-review-task-flow.yaml",
  );

  it("templates: code_review template should include tdd_aware and tdd_stage", () => {
    const content = readFileSync(templatePath, "utf-8");
    const templates = yaml.parse(content);

    const codeReviewTemplate = templates.templates.code_review;

    expect(codeReviewTemplate).toBeDefined();
    expect(codeReviewTemplate.type).toBe("PersonaRequestStep");
    expect(codeReviewTemplate.config.payload).toBeDefined();

    expect(codeReviewTemplate.config.payload.tdd_aware).toBe("${tdd_aware}");
    expect(codeReviewTemplate.config.payload.tdd_stage).toBe("${tdd_stage}");
  });

  it("templates: security_review template should include tdd_aware and tdd_stage", () => {
    const content = readFileSync(templatePath, "utf-8");
    const templates = yaml.parse(content);

    const securityTemplate = templates.templates.security_review;

    expect(securityTemplate).toBeDefined();
    expect(securityTemplate.type).toBe("PersonaRequestStep");
    expect(securityTemplate.config.payload).toBeDefined();

    expect(securityTemplate.config.payload.tdd_aware).toBe("${tdd_aware}");
    expect(securityTemplate.config.payload.tdd_stage).toBe("${tdd_stage}");
  });

  it("in-review-task-flow.yaml: code_review_request uses code_review template", () => {
    const content = readFileSync(inReviewFlowPath, "utf-8");
    const workflow = yaml.parse(content);

    const codeReviewStep = workflow.steps.find(
      (s: any) => s.name === "code_review_request",
    );

    expect(codeReviewStep).toBeDefined();
    expect(codeReviewStep.template).toBe("code_review");
  });

  it("in-review-task-flow.yaml: security_request uses security_review template", () => {
    const content = readFileSync(inReviewFlowPath, "utf-8");
    const workflow = yaml.parse(content);

    const securityStep = workflow.steps.find(
      (s: any) => s.name === "security_request",
    );

    expect(securityStep).toBeDefined();
    expect(securityStep.template).toBe("security_review");
  });

  it("review-failure-handling.yaml: PM evaluation receives TDD context (regression test)", () => {
    const subWorkflowPath = join(
      __dirname,
      "../src/workflows/sub-workflows/review-failure-handling.yaml",
    );
    const content = readFileSync(subWorkflowPath, "utf-8");
    const workflow = yaml.parse(content);

    expect(content).toContain("tdd_aware");
    expect(content).toContain("tdd_stage");

    const pmEvalStep = workflow.steps.find(
      (s: any) => s.name === "pm_evaluation",
    );

    expect(pmEvalStep).toBeDefined();
    expect(pmEvalStep.config.payload.tdd_aware).toBe("${tdd_aware || false}");
    expect(pmEvalStep.config.payload.tdd_stage).toBe(
      "${tdd_stage || 'implementation'}",
    );
    expect(pmEvalStep.config.payload.diff_summary).toBe(
      "${diff_summary || ''}",
    );
    expect(pmEvalStep.config.payload.diff_changed_files).toBe(
      "${diff_changed_files || []}",
    );
  });
});
