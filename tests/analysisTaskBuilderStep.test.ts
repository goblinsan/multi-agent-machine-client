import { describe, it, expect } from "vitest";
import { WorkflowContext } from "../src/workflows/engine/WorkflowContext.js";
import { AnalysisTaskBuilderStep } from "../src/workflows/steps/AnalysisTaskBuilderStep.js";

function buildContext(): WorkflowContext {
  const workflowConfig = { name: "analysis", version: "1.0.0", steps: [] };
  return new WorkflowContext(
    "wf-analysis",
    "project-1",
    "/tmp/repo",
    "main",
    workflowConfig as any,
    {} as any,
  );
}

describe("AnalysisTaskBuilderStep", () => {
  it("parses persona output stored inside an output field", async () => {
    const analysisContent = {
      summary: "Repository drift",
      hypotheses: [
        {
          id: "H1",
          statement: "Dependencies outdated",
          confidence: "high",
          evidence: ["package-lock.json untouched"],
          remediation_steps: ["Run npm install"],
          acceptance_criteria: ["Build succeeds"],
          validation_steps: ["npm test"],
        },
      ],
      action_plan: {
        title: "Refresh dependencies",
        summary: "Update lockfile",
        steps: ["npm install", "npm test"],
        acceptance_criteria: ["Build succeeds"],
        validation_plan: ["npm test"],
        key_files: ["package-lock.json"],
        priority: "high",
        labels: ["qa_follow_up"],
      },
    };

    const analysisPayload = {
      output: [
        "```json",
        JSON.stringify(analysisContent, null, 2),
        "```",
      ].join("\n"),
    };

    const step = new AnalysisTaskBuilderStep({
      name: "synthesize_tasks",
      type: "AnalysisTaskBuilderStep",
      config: {
        analysis_output: analysisPayload,
        review_output: { status: "pass" },
        task: { id: 55, title: "QA follow-up" },
        default_labels: ["qa_follow_up"],
      },
    });

    const result = await step.execute(buildContext());

    expect(result.status).toBe("success");
    expect(result.outputs?.actionable_tasks?.[0]?.title).toBe(
      "Refresh dependencies",
    );
  });

  it("parses bare string analysis output", async () => {
    const analysisPayload = JSON.stringify(
      {
        summary: "Unit tests missing",
        hypotheses: [
          {
            id: "H1",
            statement: "No vitest harness",
            confidence: "high",
            evidence: ["tests folder empty"],
            remediation_steps: ["Install vitest"],
            acceptance_criteria: ["Tests run"],
            validation_steps: ["npx vitest"],
          },
        ],
        action_plan: {
          title: "Establish vitest",
          summary: "Create test harness",
          steps: ["npm install vitest"],
          acceptance_criteria: ["vitest executes"],
          validation_plan: ["npx vitest"],
          key_files: ["vitest.config.ts"],
          priority: "high",
          labels: ["qa_follow_up"],
        },
      },
      null,
      2,
    );

    const step = new AnalysisTaskBuilderStep({
      name: "synthesize_tasks",
      type: "AnalysisTaskBuilderStep",
      config: {
        analysis_output: analysisPayload,
        review_output: { status: "pass" },
        task: { id: 56, title: "QA follow-up" },
        default_labels: ["qa_follow_up"],
      },
    });

    const result = await step.execute(buildContext());

    expect(result.status).toBe("success");
    expect(result.outputs?.actionable_tasks?.[0]?.title).toBe(
      "Establish vitest",
    );
  });
});
