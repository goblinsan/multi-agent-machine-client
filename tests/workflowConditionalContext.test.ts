import { describe, it, expect } from "vitest";
import * as fs from "fs/promises";
import * as path from "path";

describe("Workflow Conditional Context Optimization", () => {
  it("should have condition to skip context_request when context is reused", async () => {
    const workflowPath = path.join(
      process.cwd(),
      "src",
      "workflows",
      "definitions",
      "task-flow.yaml",
    );
    const workflowContent = await fs.readFile(workflowPath, "utf-8");

    const contextRequestMatch = workflowContent.match(
      /- template: context_analysis[\s\S]*?name: context_request[\s\S]*?(?=\n {2}- name:|$)/,
    );
    expect(contextRequestMatch).toBeDefined();

    const contextRequestStep = contextRequestMatch![0];

    expect(contextRequestStep).toContain("condition:");
    expect(contextRequestStep).toMatch(
      /condition:.*context_scan\.reused_existing.*(!=\s+true|==\s+false)/,
    );

    expect(contextRequestStep).toContain("template: context_analysis");
  });

  it("should document why context_request is conditional", async () => {
    const workflowPath = path.join(
      process.cwd(),
      "src",
      "workflows",
      "definitions",
      "task-flow.yaml",
    );
    const workflowContent = await fs.readFile(workflowPath, "utf-8");

    const contextRequestSection = workflowContent.match(
      /- template: context_analysis[\s\S]*?name: context_request[\s\S]*?condition:[^\n]+/,
    );
    expect(contextRequestSection).toBeDefined();

    const section = contextRequestSection![0];
    expect(section).toContain("context_scan.reused_existing");
  });

  it("should pass reused_existing flag to context persona payload", async () => {
    const templatePath = path.join(
      process.cwd(),
      "src",
      "workflows",
      "templates",
      "step-templates.yaml",
    );
    const templateContent = await fs.readFile(templatePath, "utf-8");

    const payloadMatch = templateContent.match(
      /context_analysis:[\s\S]*?payload:([\s\S]*?)(?=\n {2}\w)/,
    );
    expect(payloadMatch).toBeDefined();

    const payload = payloadMatch![0];

    expect(payload).toContain("context_metadata");
  });
});
