import { describe, it, expect, beforeEach, vi } from "vitest";
import { GitArtifactStep } from "../src/workflows/steps/GitArtifactStep.js";
import { WorkflowContext } from "../src/workflows/engine/WorkflowContext.js";
import type { StepResult } from "../src/workflows/engine/WorkflowStep.js";
import { makeTempRepo } from "./makeTempRepo.js";
import { runGit } from "../src/gitUtils.js";
import fs from "fs/promises";
import path from "path";

const publishMock = vi.hoisted(() => vi.fn());

vi.mock("../src/dashboard/ArtifactAPI.js", () => ({
  ArtifactAPI: class {
    publishTaskArtifact = publishMock;
    fetchTaskArtifacts = vi.fn().mockResolvedValue(null);
    publishProjectArtifact = vi.fn().mockResolvedValue({ ok: true });
    fetchProjectArtifacts = vi.fn().mockResolvedValue(null);
  },
}));

type SuccessResult = StepResult & { status: "success"; data: Record<string, any> };

const assertSuccess = (result: StepResult): SuccessResult => {
  if (result.status !== "success") {
    const reason = result.error?.message ?? "unknown error";
    throw new Error(`Expected success result but received ${result.status}: ${reason}`);
  }

  if (!result.data) {
    throw new Error("Expected success result to include data payload");
  }

  return result as SuccessResult;
};

const publishedContent = (): string => {
  const call = publishMock.mock.calls.at(-1);
  if (!call) throw new Error("Expected an artifact to have been published");
  return call[0].content;
};

describe("GitArtifactStep", () => {
  let repoDir: string;
  let context: WorkflowContext;

  beforeEach(async () => {
    publishMock.mockReset();
    publishMock.mockResolvedValue({ ok: true, status: 201, artifactId: 1 });
    repoDir = await makeTempRepo();

    context = new WorkflowContext(
      "test-workflow-id",
      "test-project-id",
      repoDir,
      "main",
      {
        name: "test-workflow",
        version: "1.0.0",
        steps: [],
      },
      {} as any,
      { task: { id: "1" } },
    );
  });

  describe("Publishing", () => {
    it("publishes persona output to the dashboard without writing it into the repo", async () => {
      const planData = "This is the approved plan for the feature";
      context.setVariable("plan_result", planData);

      const step = new GitArtifactStep({
        name: "commit_plan",
        type: "GitArtifactStep",
        config: {
          source_output: "plan_result",
          artifact_path: ".ma/tasks/1/03-plan-final.md",
          commit_message: "docs(ma): approved plan for task 1",
        },
      });

      const result = assertSuccess(await step.execute(context));

      expect(result.data.path).toBe(".ma/tasks/1/03-plan-final.md");
      expect(result.data.sha).toBe("api-only");
      expect(publishedContent()).toContain(planData);
      expect(result.outputs?.commit_plan_path).toBe(
        ".ma/tasks/1/03-plan-final.md",
      );

      await expect(
        fs.access(path.join(repoDir, ".ma/tasks/1/03-plan-final.md")),
      ).rejects.toThrow();
    });

    it("derives the artifact kind from the artifact path", async () => {
      context.setVariable("review_result", { status: "pass" });

      const step = new GitArtifactStep({
        name: "commit_review",
        type: "GitArtifactStep",
        config: {
          source_output: "review_result",
          artifact_path: ".ma/tasks/1/reviews/code-review.json",
          commit_message: "docs(ma): review for task 1",
          format: "json",
        },
      });

      assertSuccess(await step.execute(context));

      expect(publishMock).toHaveBeenCalledWith(
        expect.objectContaining({ kind: "code_review" }),
      );
    });

    it("leaves the working tree clean and creates no commits", async () => {
      const before = await runGit(["rev-parse", "HEAD"], { cwd: repoDir });
      context.setVariable("qa_result", { status: "pass" });

      const step = new GitArtifactStep({
        name: "commit_qa",
        type: "GitArtifactStep",
        config: {
          source_output: "qa_result",
          artifact_path: ".ma/tasks/1/reviews/qa.json",
          commit_message: "docs(ma): QA results for task 1",
          format: "json",
        },
      });

      assertSuccess(await step.execute(context));

      const status = await runGit(["status", "--short"], { cwd: repoDir });
      expect(status.stdout.trim()).toBe("");

      const after = await runGit(["rev-parse", "HEAD"], { cwd: repoDir });
      expect(after.stdout.trim()).toBe(before.stdout.trim());
    });

    it("treats a failed publish as non-fatal", async () => {
      publishMock.mockResolvedValue({ ok: false, status: 500, error: "boom" });
      context.setVariable("plan_result", "content");

      const step = new GitArtifactStep({
        name: "commit_plan",
        type: "GitArtifactStep",
        config: {
          source_output: "plan_result",
          artifact_path: ".ma/tasks/1/plan.md",
          commit_message: "docs(ma): plan",
        },
      });

      const result = assertSuccess(await step.execute(context));
      expect(result.data.sha).toBe("api-only");
    });
  });

  describe("Content Formatting", () => {
    it("extracts a nested field when extract_field is specified", async () => {
      context.setVariable("planning_response", {
        status: "pass",
        plan: "This is the nested plan content",
        metadata: { iteration: 3 },
      });

      const step = new GitArtifactStep({
        name: "commit_plan",
        type: "GitArtifactStep",
        config: {
          source_output: "planning_response",
          extract_field: "plan",
          artifact_path: ".ma/tasks/1/03-plan-final.md",
          commit_message: "docs(ma): plan",
        },
      });

      assertSuccess(await step.execute(context));

      const content = publishedContent();
      expect(content).toContain("This is the nested plan content");
      expect(content).not.toContain("iteration");
    });

    it("serializes as JSON when format=json", async () => {
      context.setVariable("qa_result", { status: "pass", failures: [] });

      const step = new GitArtifactStep({
        name: "commit_qa",
        type: "GitArtifactStep",
        config: {
          source_output: "qa_result",
          artifact_path: ".ma/tasks/1/reviews/qa.json",
          commit_message: "docs(ma): qa",
          format: "json",
        },
      });

      assertSuccess(await step.execute(context));

      expect(JSON.parse(publishedContent())).toEqual({
        status: "pass",
        failures: [],
      });
    });

    it("formats as markdown by default", async () => {
      context.setVariable("plan_result", "# Heading\n\nBody text");

      const step = new GitArtifactStep({
        name: "commit_plan",
        type: "GitArtifactStep",
        config: {
          source_output: "plan_result",
          artifact_path: ".ma/tasks/1/03-plan-final.md",
          commit_message: "docs(ma): plan",
        },
      });

      assertSuccess(await step.execute(context));

      expect(publishedContent()).toContain("# Heading");
    });
  });

  describe("Variable Resolution", () => {
    it("resolves variable placeholders in the artifact path", async () => {
      context.setVariable("plan_result", "content");
      context.setVariable("task", { id: "42" });

      const step = new GitArtifactStep({
        name: "commit_plan",
        type: "GitArtifactStep",
        config: {
          source_output: "plan_result",
          artifact_path: ".ma/tasks/${task.id}/03-plan-final.md",
          commit_message: "docs(ma): plan for ${task.id}",
        },
      });

      const result = assertSuccess(await step.execute(context));

      expect(result.data.path).toBe(".ma/tasks/42/03-plan-final.md");
    });

    it("keeps the placeholder when the variable is not found", async () => {
      context.setVariable("plan_result", "content");

      const step = new GitArtifactStep({
        name: "commit_plan",
        type: "GitArtifactStep",
        config: {
          source_output: "plan_result",
          artifact_path: ".ma/tasks/${missing.var}/plan.md",
          commit_message: "docs(ma): plan",
        },
      });

      const result = assertSuccess(await step.execute(context));

      expect(result.data.path).toContain("${missing.var}");
    });
  });

  describe("Error Handling", () => {
    it("fails when source_output is not found", async () => {
      const step = new GitArtifactStep({
        name: "commit_plan",
        type: "GitArtifactStep",
        config: {
          source_output: "does_not_exist",
          artifact_path: ".ma/tasks/1/plan.md",
          commit_message: "docs(ma): plan",
        },
      });

      const result = await step.execute(context);

      expect(result.status).toBe("failure");
      expect(publishMock).not.toHaveBeenCalled();
    });

    it("fails when extract_field is not found in the data", async () => {
      context.setVariable("planning_response", { status: "pass" });

      const step = new GitArtifactStep({
        name: "commit_plan",
        type: "GitArtifactStep",
        config: {
          source_output: "planning_response",
          extract_field: "missing",
          artifact_path: ".ma/tasks/1/plan.md",
          commit_message: "docs(ma): plan",
        },
      });

      const result = await step.execute(context);

      expect(result.status).toBe("failure");
      expect(publishMock).not.toHaveBeenCalled();
    });

    it("fails when artifact_path escapes .ma/", async () => {
      context.setVariable("plan_result", "content");

      const step = new GitArtifactStep({
        name: "commit_plan",
        type: "GitArtifactStep",
        config: {
          source_output: "plan_result",
          artifact_path: "src/secrets.md",
          commit_message: "docs(ma): plan",
        },
      });

      const result = await step.execute(context);

      expect(result.status).toBe("failure");
      expect(publishMock).not.toHaveBeenCalled();
    });
  });

  describe("Test Bypass", () => {
    it("bypasses publishing when SKIP_GIT_OPERATIONS is true", async () => {
      context.setVariable("plan", "Test plan");
      context.setVariable("SKIP_GIT_OPERATIONS", true);

      const step = new GitArtifactStep({
        name: "commit_plan",
        type: "GitArtifactStep",
        config: {
          source_output: "plan",
          artifact_path: ".ma/tasks/1/plan.md",
          commit_message: "docs(ma): plan",
        },
      });

      const result = assertSuccess(await step.execute(context));

      expect(result.data.bypassed).toBe(true);
      expect(result.data.sha).toBe("skipped");
      expect(result.outputs?.commit_plan_sha).toBe("skipped");
      expect(publishMock).not.toHaveBeenCalled();
    });
  });

  describe("Validation", () => {
    it("validates required fields", async () => {
      const step = new GitArtifactStep({
        name: "commit_plan",
        type: "GitArtifactStep",
        config: {},
      });

      expect((await step.validate(context)).valid).toBe(false);
    });

    it("validates that artifact_path starts with .ma/", async () => {
      const step = new GitArtifactStep({
        name: "commit_plan",
        type: "GitArtifactStep",
        config: {
          source_output: "plan_result",
          artifact_path: "docs/plan.md",
          commit_message: "docs(ma): plan",
        },
      });

      expect((await step.validate(context)).valid).toBe(false);
    });

    it("validates the format enum", async () => {
      const step = new GitArtifactStep({
        name: "commit_plan",
        type: "GitArtifactStep",
        config: {
          source_output: "plan_result",
          artifact_path: ".ma/tasks/1/plan.md",
          commit_message: "docs(ma): plan",
          format: "xml",
        },
      });

      expect((await step.validate(context)).valid).toBe(false);
    });

    it("passes validation with a valid config", async () => {
      const step = new GitArtifactStep({
        name: "commit_plan",
        type: "GitArtifactStep",
        config: {
          source_output: "plan_result",
          artifact_path: ".ma/tasks/1/plan.md",
          commit_message: "docs(ma): plan",
          format: "json",
        },
      });

      expect((await step.validate(context)).valid).toBe(true);
    });
  });
});
