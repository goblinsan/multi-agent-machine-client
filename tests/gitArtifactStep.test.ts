import { describe, it, expect, beforeEach, vi as _vi } from "vitest";
import { GitArtifactStep } from "../src/workflows/steps/GitArtifactStep.js";
import { WorkflowContext } from "../src/workflows/engine/WorkflowContext.js";
import type { StepResult } from "../src/workflows/engine/WorkflowStep.js";
import { makeTempRepo } from "./makeTempRepo.js";
import { runGit } from "../src/gitUtils.js";
import fs from "fs/promises";
import path from "path";

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

describe("GitArtifactStep", () => {
  let repoDir: string;
  let context: WorkflowContext;

  beforeEach(async () => {
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
      {},
    );
  });

  describe("Basic Functionality", () => {
    it("should commit persona output to .ma directory", async () => {
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
      expect(result.data.sha).toBeDefined();
      expect(result.data.sha).not.toBe("skipped");

      const filePath = path.join(repoDir, ".ma/tasks/1/03-plan-final.md");
      const content = await fs.readFile(filePath, "utf-8");
      expect(content).toContain(planData);

      const log = await runGit(["log", "--oneline", "-1"], { cwd: repoDir });
      expect(log.stdout).toContain("docs(ma): approved plan for task 1");

      expect(result.outputs?.commit_plan_sha).toBe(result.data.sha);
      expect(result.outputs?.commit_plan_path).toBe(
        ".ma/tasks/1/03-plan-final.md",
      );
    });

    it("should extract nested field when extract_field specified", async () => {
      const responseData = {
        status: "pass",
        plan: "This is the nested plan content",
        metadata: { iteration: 3 },
      };
      context.setVariable("planning_response", responseData);

      const step = new GitArtifactStep({
        name: "commit_plan",
        type: "GitArtifactStep",
        config: {
          source_output: "planning_response",
          artifact_path: ".ma/tasks/1/03-plan-final.md",
          commit_message: "docs(ma): plan for task 1",
          extract_field: "plan",
        },
      });

      assertSuccess(await step.execute(context));
      const filePath = path.join(repoDir, ".ma/tasks/1/03-plan-final.md");
      const content = await fs.readFile(filePath, "utf-8");
      expect(content).toContain("This is the nested plan content");
      expect(content).not.toContain("metadata");
    });

    it("should format as JSON when format=json", async () => {
      const qaResult = {
        status: "fail",
        failures: ["Test 1 failed", "Test 2 failed"],
        coverage: 85,
      };
      context.setVariable("qa_result", qaResult);

      const step = new GitArtifactStep({
        name: "commit_qa",
        type: "GitArtifactStep",
        config: {
          source_output: "qa_result",
          artifact_path: ".ma/tasks/1/05-qa-result.json",
          commit_message: "docs(ma): QA results for task 1",
          format: "json",
        },
      });

      const result = assertSuccess(await step.execute(context));
      expect(result.data.format).toBe("json");

      const filePath = path.join(repoDir, ".ma/tasks/1/05-qa-result.json");
      const content = await fs.readFile(filePath, "utf-8");
      const parsed = JSON.parse(content);
      expect(parsed).toEqual(qaResult);
    });

    it("should format as markdown by default", async () => {
      const planText = "Implementation plan:\n1. Step one\n2. Step two";
      context.setVariable("plan", planText);

      const step = new GitArtifactStep({
        name: "commit_plan",
        type: "GitArtifactStep",
        config: {
          source_output: "plan",
          artifact_path: ".ma/tasks/1/03-plan-final.md",
          commit_message: "docs(ma): plan",
        },
      });

      const result = assertSuccess(await step.execute(context));
      expect(result.data.format).toBe("markdown");

      const filePath = path.join(repoDir, ".ma/tasks/1/03-plan-final.md");
      const content = await fs.readFile(filePath, "utf-8");
      expect(content).toContain("Step one");
    });
  });

  describe("Variable Resolution", () => {
    it("should resolve variable placeholders in artifact path", async () => {
      context.setVariable("plan", "Test plan");
      context.setVariable("task", { id: 42, title: "Feature X" });

      const step = new GitArtifactStep({
        name: "commit_plan",
        type: "GitArtifactStep",
        config: {
          source_output: "plan",
          artifact_path: ".ma/tasks/${task.id}/03-plan-final.md",
          commit_message: "docs(ma): plan for task ${task.id}",
        },
      });

      const result = assertSuccess(await step.execute(context));
      expect(result.data.path).toBe(".ma/tasks/42/03-plan-final.md");

      const filePath = path.join(repoDir, ".ma/tasks/42/03-plan-final.md");
      await expect(fs.access(filePath)).resolves.not.toThrow();

      const log = await runGit(["log", "--oneline", "-1"], { cwd: repoDir });
      expect(log.stdout).toContain("plan for task 42");
    });

    it("should resolve nested variable placeholders in commit message", async () => {
      context.setVariable("plan", "Test plan");
      context.setVariable("task", { id: 5, title: "Bug Fix" });
      context.setVariable("milestone", { name: "Sprint 3" });

      const step = new GitArtifactStep({
        name: "commit_plan",
        type: "GitArtifactStep",
        config: {
          source_output: "plan",
          artifact_path: ".ma/tasks/${task.id}/plan.md",
          commit_message: "docs(ma): ${task.title} plan for ${milestone.name}",
        },
      });

      assertSuccess(await step.execute(context));

      const log = await runGit(["log", "--oneline", "-1"], { cwd: repoDir });
      expect(log.stdout).toContain("Bug Fix plan for Sprint 3");
    });

    it("should keep placeholder if variable not found", async () => {
      context.setVariable("plan", "Test plan");

      const step = new GitArtifactStep({
        name: "commit_plan",
        type: "GitArtifactStep",
        config: {
          source_output: "plan",
          artifact_path: ".ma/tasks/${nonexistent.id}/plan.md",
          commit_message: "docs(ma): plan",
        },
      });

      const result = assertSuccess(await step.execute(context));
      expect(result.data.path).toBe(".ma/tasks/${nonexistent.id}/plan.md");
    });
  });

  describe("Git Operations", () => {
    it("should create parent directories if missing", async () => {
      context.setVariable("plan", "Test plan");

      const step = new GitArtifactStep({
        name: "commit_plan",
        type: "GitArtifactStep",
        config: {
          source_output: "plan",
          artifact_path: ".ma/tasks/1/deep/nested/path/plan.md",
          commit_message: "docs(ma): plan",
        },
      });

      assertSuccess(await step.execute(context));
      const filePath = path.join(
        repoDir,
        ".ma/tasks/1/deep/nested/path/plan.md",
      );
      await expect(fs.access(filePath)).resolves.not.toThrow();
    });

    it("should store SHA in workflow context outputs", async () => {
      context.setVariable("plan", "Test plan");

      const step = new GitArtifactStep({
        name: "save_plan",
        type: "GitArtifactStep",
        config: {
          source_output: "plan",
          artifact_path: ".ma/tasks/1/plan.md",
          commit_message: "docs(ma): plan",
        },
      });

      const result = assertSuccess(await step.execute(context));

      expect(result.outputs).toBeDefined();
      expect(result.outputs?.save_plan_sha).toBeDefined();
      expect(result.outputs?.save_plan_sha).toMatch(/^[0-9a-f]{40}$/);
      expect(result.outputs?.save_plan_path).toBe(".ma/tasks/1/plan.md");
    });

    it("should not fail if push fails (log warning only)", async () => {
      context.setVariable("plan", "Test plan");

      await runGit(["remote", "remove", "origin"], { cwd: repoDir }).catch(
        () => {},
      );

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
      expect(result.data.sha).toBeDefined();

      const log = await runGit(["log", "--oneline", "-1"], { cwd: repoDir });
      expect(log.stdout).toContain("docs(ma): plan");
    });
  });

  describe("Branch Guard", () => {
    it("should attempt checkout and continue when expected branch exists", async () => {
      context.setVariable("plan", "Test plan");
      context.setVariable("branch", "feature/mismatch-branch");
      context.setVariable("featureBranchName", "feature/mismatch-branch");

      await runGit(["checkout", "-b", "feature/mismatch-branch"], {
        cwd: repoDir,
      });
      await runGit(["checkout", "main"], { cwd: repoDir });

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
      expect(result.status).toBe("success");

      const branch = await runGit(["rev-parse", "--abbrev-ref", "HEAD"], {
        cwd: repoDir,
      });
      expect(branch.stdout.trim()).toBe("feature/mismatch-branch");
    });

    it("should fail when active branch does not match expected branch", async () => {
      context.setVariable("plan", "Test plan");
      context.setVariable("branch", "feature/mismatch-branch");
      context.setVariable("featureBranchName", "feature/mismatch-branch");

      const step = new GitArtifactStep({
        name: "commit_plan",
        type: "GitArtifactStep",
        config: {
          source_output: "plan",
          artifact_path: ".ma/tasks/1/plan.md",
          commit_message: "docs(ma): plan",
        },
      });

      const result = await step.execute(context);

      expect(result.status).toBe("failure");
      expect(result.error?.message).toContain(
        "does not match expected branch",
      );
      expect(result.data?.failed).toBe(true);
      expect(result.data?.activeBranch).toBe("main");
      expect(result.data?.expectedBranch).toBe("feature/mismatch-branch");

      const filePath = path.join(repoDir, ".ma/tasks/1/plan.md");
      await expect(fs.access(filePath)).rejects.toThrow();

      const status = await runGit(["status", "--short"], { cwd: repoDir });
      expect(status.stdout.trim()).toBe("");
    });
  });

  describe("Error Handling", () => {
    it("should fail if source_output not found", async () => {
      const step = new GitArtifactStep({
        name: "commit_plan",
        type: "GitArtifactStep",
        config: {
          source_output: "nonexistent_variable",
          artifact_path: ".ma/tasks/1/plan.md",
          commit_message: "docs(ma): plan",
        },
      });

      const result = await step.execute(context);

      expect(result.status).toBe("failure");
      expect(result.error).toBeDefined();
      expect(result.error?.message).toContain("nonexistent_variable");
    });

    it("should fail if extract_field not found in data", async () => {
      context.setVariable("response", { status: "pass", other: "data" });

      const step = new GitArtifactStep({
        name: "commit_plan",
        type: "GitArtifactStep",
        config: {
          source_output: "response",
          artifact_path: ".ma/tasks/1/plan.md",
          commit_message: "docs(ma): plan",
          extract_field: "plan",
        },
      });

      const result = await step.execute(context);

      expect(result.status).toBe("failure");
      expect(result.error?.message).toContain("extract_field 'plan' not found");
    });

    it("should fail if artifact_path does not start with .ma/", async () => {
      context.setVariable("plan", "Test plan");

      const step = new GitArtifactStep({
        name: "commit_plan",
        type: "GitArtifactStep",
        config: {
          source_output: "plan",
          artifact_path: "dangerous/path/plan.md",
          commit_message: "docs(ma): plan",
        },
      });

      const result = await step.execute(context);

      expect(result.status).toBe("failure");
      expect(result.error?.message).toContain("must start with '.ma/'");
    });
  });

  describe("Test Bypass", () => {
    it("should bypass git operations when SKIP_GIT_OPERATIONS is true", async () => {
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

      const filePath = path.join(repoDir, ".ma/tasks/1/plan.md");
      await expect(fs.access(filePath)).rejects.toThrow();
    });
  });

  describe("Validation", () => {
    it("should validate required fields", async () => {
      const step = new GitArtifactStep({
        name: "invalid_step",
        type: "GitArtifactStep",
        config: {} as any,
      });

      const result = await step.validate(context);

      expect(result.valid).toBe(false);
      expect(result.errors).toContain(
        "GitArtifactStep: source_output is required and must be a string",
      );
      expect(result.errors).toContain(
        "GitArtifactStep: artifact_path is required and must be a string",
      );
      expect(result.errors).toContain(
        "GitArtifactStep: commit_message is required and must be a string",
      );
    });

    it("should validate artifact_path starts with .ma/", async () => {
      const step = new GitArtifactStep({
        name: "invalid_step",
        type: "GitArtifactStep",
        config: {
          source_output: "plan",
          artifact_path: "unsafe/path.md",
          commit_message: "test",
        },
      });

      const result = await step.validate(context);

      expect(result.valid).toBe(false);
      expect(result.errors).toContain(
        "GitArtifactStep: artifact_path must start with '.ma/' for security",
      );
    });

    it("should validate format enum", async () => {
      const step = new GitArtifactStep({
        name: "invalid_step",
        type: "GitArtifactStep",
        config: {
          source_output: "plan",
          artifact_path: ".ma/test.md",
          commit_message: "test",
          format: "xml" as any,
        },
      });

      const result = await step.validate(context);

      expect(result.valid).toBe(false);
      expect(result.errors).toContain(
        "GitArtifactStep: format must be 'markdown' or 'json'",
      );
    });

    it("should pass validation with valid config", async () => {
      const step = new GitArtifactStep({
        name: "valid_step",
        type: "GitArtifactStep",
        config: {
          source_output: "plan",
          artifact_path: ".ma/tasks/1/plan.md",
          commit_message: "docs(ma): plan",
          format: "markdown",
          extract_field: "plan",
        },
      });

      const result = await step.validate(context);

      expect(result.valid).toBe(true);
      expect(result.errors).toEqual([]);
    });
  });
});
