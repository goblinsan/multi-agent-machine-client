import fs from "fs/promises";
import os from "os";
import path from "path";
import { describe, it, expect, beforeEach, vi } from "vitest";
import { AnalysisReviewLoopStep } from "../src/workflows/steps/AnalysisReviewLoopStep.js";
import { WorkflowContext } from "../src/workflows/engine/WorkflowContext.js";
import type { WorkflowStepConfig } from "../src/workflows/engine/WorkflowStep.js";

const personaExecuteMock = vi.fn();

vi.mock("../src/workflows/steps/PersonaRequestStep.js", () => {
  return {
    PersonaRequestStep: class {
      config: WorkflowStepConfig;
      constructor(config: WorkflowStepConfig) {
        this.config = config;
      }
      execute(context: WorkflowContext) {
        return personaExecuteMock(this.config, context);
      }
    },
  };
});

function buildContext(repoRoot = "/tmp/repo") {
  const workflowConfig = { name: "analysis", version: "1.0.0", steps: [] };
  const context = new WorkflowContext(
    "wf-analysis",
    "project-1",
    repoRoot,
    "main",
    workflowConfig as any,
    {} as any,
  );
  context.setVariable("repo_remote", "git@example.com/repo.git");
  context.setVariable("review_existing_tasks", []);
  context.setVariable("context_summary_md", "# Summary");
  context.setVariable("context_insights", {
    primaryLanguage: "TypeScript",
    frameworks: ["Node"],
  });
  context.setVariable("task", {
    id: 55,
    title: "qa follow-up",
    description: "Severity: high\nAcceptance criteria: align QA findings",
  });
  return context;
}

describe("AnalysisReviewLoopStep", () => {
  beforeEach(() => {
    personaExecuteMock.mockReset();
  });

  it("retries analyst work using reviewer feedback until pass", async () => {
    const context = buildContext();
    const step = new AnalysisReviewLoopStep({
      name: "analysis_loop",
      type: "AnalysisReviewLoopStep",
      config: {
        analystPersona: "analyst",
        reviewerPersona: "analysis-reviewer",
        payload: {},
        reviewPayload: {},
      },
    } as WorkflowStepConfig);

    const responses = [
      { persona: "analyst", output: { summary: "attempt-1" } },
      {
        persona: "analysis-reviewer",
        output: { status: "fail", reason: "Needs repo alignment" },
      },
      { persona: "analyst", output: { summary: "attempt-2" } },
      { persona: "analysis-reviewer", output: { status: "pass" } },
    ];

    personaExecuteMock.mockImplementation((config: WorkflowStepConfig) => {
      const next = responses.shift();
      if (!next) {
        throw new Error("No mock response available");
      }
      expect(config.config?.persona).toBe(next.persona);
      return { status: "success", outputs: next.output };
    });

    const result = await step.execute(context);

    expect(result.status).toBe("success");
    expect(result.outputs?.analysis_iterations).toBe(2);
    expect(result.outputs?.analysis_review_status).toBe("pass");
    expect(result.outputs?.analysis_request_result).toEqual({
      summary: "attempt-2",
    });
    expect(personaExecuteMock).toHaveBeenCalledTimes(4);
  });

  it("injects reviewer feedback into subsequent analyst payloads", async () => {
    const context = buildContext();
    const step = new AnalysisReviewLoopStep({
      name: "analysis_loop",
      type: "AnalysisReviewLoopStep",
      config: {
        analystPersona: "analyst",
        reviewerPersona: "analysis-reviewer",
        payload: {},
        reviewPayload: {},
      },
    } as WorkflowStepConfig);

    const analystPayloads: Record<string, any>[] = [];
    const reviewerPayloads: Record<string, any>[] = [];
    let reviewCall = 0;

    personaExecuteMock.mockImplementation((config: WorkflowStepConfig) => {
      if (config.config?.persona === "analyst") {
        analystPayloads.push(config.config.payload || {});
        return {
          status: "success",
          outputs: { summary: `attempt-${analystPayloads.length}` },
        };
      }

      reviewerPayloads.push(config.config?.payload || {});
      reviewCall += 1;
      if (reviewCall === 1) {
        return {
          status: "success",
          outputs: {
            status: "fail",
            reason: "Missing evidence",
            required_revisions: ["Cite repo files"],
          },
        };
      }

      return { status: "success", outputs: { status: "pass" } };
    });

    const result = await step.execute(context);

    expect(result.status).toBe("success");
    expect(analystPayloads).toHaveLength(2);
    const firstPayload = analystPayloads[0];
    expect(firstPayload.analysis_goal_text).toContain("qa follow-up");
    expect(firstPayload.task_description).toContain("Severity: high");
    expect(firstPayload.qa_findings_text).toContain("Severity: high");
    const secondPayload = analystPayloads[1];
    expect(secondPayload.is_revision).toBe(true);
    expect(secondPayload.review_feedback_text).toContain("Missing evidence");
    expect(secondPayload.review_feedback_required_revisions).toContain(
      "Cite repo files",
    );
    expect(secondPayload.review_feedback_status).toBe("fail");
    expect(secondPayload.previous_analysis_output?.summary).toBe("attempt-1");
    expect(
      secondPayload.analysis_revision_context?.last_analysis_text,
    ).toContain("attempt-1");
    expect(secondPayload.analysis_revision_directive).toContain(
      "Refine the previous analysis",
    );
    expect(reviewerPayloads.length).toBeGreaterThan(0);
    expect(reviewerPayloads[0].analysis_output_text).toContain("attempt-1");
    expect(reviewerPayloads[0].qa_findings_text).toContain("Severity: high");
  });

  it("auto-passes on the fifth attempt when reviewer keeps failing", async () => {
    const context = buildContext();
    const step = new AnalysisReviewLoopStep({
      name: "analysis_loop",
      type: "AnalysisReviewLoopStep",
      config: {
        analystPersona: "analyst",
        reviewerPersona: "analysis-reviewer",
        payload: {},
        reviewPayload: {},
        maxIterations: 5,
        autoPassReason: "Review exhausted",
      },
    } as WorkflowStepConfig);

    const responses: Array<{ persona: string; output: any }> = [];
    for (let i = 0; i < 5; i++) {
      responses.push({ persona: "analyst", output: { summary: `rev-${i}` } });
      responses.push({
        persona: "analysis-reviewer",
        output: { status: "fail", reason: `round-${i}` },
      });
    }

    personaExecuteMock.mockImplementation((_: WorkflowStepConfig) => {
      const next = responses.shift();
      if (!next) {
        throw new Error("No mock response available");
      }
      return { status: "success", outputs: next.output };
    });

    const result = await step.execute(context);

    expect(result.status).toBe("success");
    expect(result.outputs?.analysis_iterations).toBe(5);
    expect(result.outputs?.analysis_auto_pass).toBe(true);
    expect(result.outputs?.analysis_review_status).toBe("pass");
    expect(result.outputs?.analysis_review_result).toMatchObject({
      auto_pass: true,
      reason: "Review exhausted",
    });
  });

  it("fails fast when analyst request fails", async () => {
    const context = buildContext();
    const step = new AnalysisReviewLoopStep({
      name: "analysis_loop",
      type: "AnalysisReviewLoopStep",
      config: {
        analystPersona: "analyst",
        reviewerPersona: "analysis-reviewer",
        payload: {},
        reviewPayload: {},
      },
    } as WorkflowStepConfig);

    personaExecuteMock.mockImplementation((config: WorkflowStepConfig) => {
      if (config.config?.persona === "analyst") {
        return { status: "failure", error: new Error("timeout") };
      }
      return { status: "success", outputs: { status: "pass" } };
    });

    const result = await step.execute(context);

    expect(result.status).toBe("failure");
    expect(result.error?.message).toContain("timeout");
  });
});

  it("loads review failure log and type when artifact exists", async () => {
    const repoRoot = await fs.mkdtemp(path.join(os.tmpdir(), "analysis-loop-"));
    const artifactDir = path.join(repoRoot, ".ma", "tasks", "1", "reviews");
    await fs.mkdir(artifactDir, { recursive: true });
    const artifactPath = path.join(artifactDir, "qa.json");
    await fs.writeFile(artifactPath, '{"status":"fail","details":"Missing tests"}');

    const context = buildContext(repoRoot);
    context.setVariable("task", {
      data: {
        id: 63,
        title: "Qa Follow_up: qa failure (HIGH)",
        description: "Severity: high",
        parent_task_id: 1,
        external_id: "qa-1-auto-fallback",
      },
    });

    const step = new AnalysisReviewLoopStep({
      name: "analysis_loop",
      type: "AnalysisReviewLoopStep",
      config: {
        analystPersona: "analyst",
        reviewerPersona: "analysis-reviewer",
        payload: {},
        reviewPayload: {},
      },
    } as WorkflowStepConfig);

    const analystPayloads: Record<string, any>[] = [];

    personaExecuteMock.mockImplementation((config: WorkflowStepConfig) => {
      if (config.config?.persona === "analyst") {
        analystPayloads.push(config.config.payload || {});
        return { status: "success", outputs: { summary: "analysis" } };
      }
      return { status: "success", outputs: { status: "pass" } };
    });

    const result = await step.execute(context);

    expect(result.status).toBe("success");
    expect(analystPayloads[0].review_type).toBe("qa");
    expect(analystPayloads[0].review_type_label).toBe("QA");
    expect(analystPayloads[0].review_failure_log).toContain("Missing tests");
    expect(analystPayloads[0].review_failure_source).toBe(artifactPath);

    await fs.rm(repoRoot, { recursive: true, force: true });
  });
