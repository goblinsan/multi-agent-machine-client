import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { ContextStep } from "../src/workflows/steps/ContextStep.js";
import { GitArtifactStep } from "../src/workflows/steps/GitArtifactStep.js";
import { WorkflowContext } from "../src/workflows/engine/WorkflowContext.js";
import { makeTempRepo } from "./makeTempRepo.js";
import fs from "fs/promises";
import path from "path";
import { runGit } from "../src/gitUtils.js";
import { LocalTransport } from "../src/transport/LocalTransport.js";
import { exec } from "child_process";
import { promisify } from "util";

const execP = promisify(exec);

describe("Distributed Git Architecture - CRITICAL REQUIREMENTS", () => {
  let tempRepoDir: string;
  let transport: LocalTransport;
  let context: WorkflowContext;

  beforeEach(async () => {
    tempRepoDir = await makeTempRepo({
      "src/example.ts": 'export const hello = "world";',
      "README.md": "# Test Project",
    });

    transport = new LocalTransport();
    await transport.connect();

    context = new WorkflowContext(
      "test-workflow",
      "1",
      tempRepoDir,
      "main",
      { name: "test", version: "1.0", steps: [] },
      transport,
      {
        task: {
          id: "1",
          title: "Test Task",
          description: "Test",
          type: "feature",
        },
      },
    );
  });

  afterEach(async () => {
    await transport.disconnect();

    await execP(`rm -rf ${tempRepoDir}`);
  });

  describe("REQUIREMENT 1: Context scan MUST commit artifacts to git", () => {
    it("should write snapshot.json to .ma/context/", async () => {
      const contextStep = new ContextStep({
        name: "context_scan",
        type: "ContextStep",
        config: {
          repoPath: tempRepoDir,
          includePatterns: ["**/*"],
          excludePatterns: ["node_modules/**", ".git/**", ".ma/**"],
        },
      });

      const result = await contextStep.execute(context);

      expect(result.status).toBe("success");

      const snapshotPath = path.join(
        tempRepoDir,
        ".ma",
        "context",
        "snapshot.json",
      );
      const snapshotExists = await fs
        .access(snapshotPath)
        .then(() => true)
        .catch(() => false);
      expect(snapshotExists).toBe(true);

      const snapshotContent = await fs.readFile(snapshotPath, "utf-8");
      const snapshot = JSON.parse(snapshotContent);
      expect(snapshot.timestamp).toBeDefined();
      expect(snapshot.files).toBeInstanceOf(Array);
      expect(snapshot.files.length).toBeGreaterThan(0);
      expect(snapshot.totals).toBeDefined();
      expect(snapshot.totals.files).toBeGreaterThan(0);
    });

    it("should write summary.md to .ma/context/", async () => {
      const contextStep = new ContextStep({
        name: "context_scan",
        type: "ContextStep",
        config: {
          repoPath: tempRepoDir,
          includePatterns: ["**/*"],
          excludePatterns: ["node_modules/**", ".git/**", ".ma/**"],
        },
      });

      await contextStep.execute(context);

      const summaryPath = path.join(
        tempRepoDir,
        ".ma",
        "context",
        "summary.md",
      );
      const summaryExists = await fs
        .access(summaryPath)
        .then(() => true)
        .catch(() => false);
      expect(summaryExists).toBe(true);

      const summaryContent = await fs.readFile(summaryPath, "utf-8");
      expect(summaryContent).toContain("# Repository Context Summary");
      expect(summaryContent).toContain("## Statistics");
      expect(summaryContent).toContain("## Directory Structure");
      expect(summaryContent).toContain("## File Types");
    });

    it("should commit context artifacts to git", async () => {
      const contextStep = new ContextStep({
        name: "context_scan",
        type: "ContextStep",
        config: {
          repoPath: tempRepoDir,
          includePatterns: ["**/*"],
          excludePatterns: ["node_modules/**", ".git/**", ".ma/**"],
        },
      });

      const logBefore = await runGit(["log", "--oneline"], {
        cwd: tempRepoDir,
      });
      const commitsBefore = logBefore.stdout.trim().split("\n").length;

      await contextStep.execute(context);

      const logAfter = await runGit(["log", "--oneline"], { cwd: tempRepoDir });
      const commitsAfter = logAfter.stdout.trim().split("\n").length;

      expect(commitsAfter).toBeGreaterThan(commitsBefore);

      const latestCommit = await runGit(["log", "-1", "--pretty=%B"], {
        cwd: tempRepoDir,
      });
      expect(latestCommit.stdout).toContain("chore(ma): update context scan");
    });

    it("should commit snapshot.json and summary.md in same commit", async () => {
      const contextStep = new ContextStep({
        name: "context_scan",
        type: "ContextStep",
        config: {
          repoPath: tempRepoDir,
          includePatterns: ["**/*"],
          excludePatterns: ["node_modules/**", ".git/**", ".ma/**"],
        },
      });

      await contextStep.execute(context);

      const filesInCommit = await runGit(
        ["show", "--name-only", "--pretty=format:", "HEAD"],
        { cwd: tempRepoDir },
      );
      const files = filesInCommit.stdout.trim().split("\n").filter(Boolean);

      expect(files).toContain(".ma/context/snapshot.json");
      expect(files).toContain(".ma/context/summary.md");
    });

    it("should NOT commit if context unchanged (reused_existing)", async () => {
      const contextStep = new ContextStep({
        name: "context_scan",
        type: "ContextStep",
        config: {
          repoPath: tempRepoDir,
          includePatterns: ["**/*"],
          excludePatterns: ["node_modules/**", ".git/**", ".ma/**"],
        },
      });

      await contextStep.execute(context);
      const logAfterFirst = await runGit(["log", "--oneline"], {
        cwd: tempRepoDir,
      });
      const commitsAfterFirst = logAfterFirst.stdout.trim().split("\n").length;

      const result2 = await contextStep.execute(context);
      expect(result2.outputs?.reused_existing).toBe(true);

      const logAfterSecond = await runGit(["log", "--oneline"], {
        cwd: tempRepoDir,
      });
      const commitsAfterSecond = logAfterSecond.stdout
        .trim()
        .split("\n").length;

      expect(commitsAfterSecond).toBe(commitsAfterFirst);
    });

    it("should output repoScan data for context persona", async () => {
      const contextStep = new ContextStep({
        name: "context_scan",
        type: "ContextStep",
        config: {
          repoPath: tempRepoDir,
          includePatterns: ["**/*"],
          excludePatterns: ["node_modules/**", ".git/**", ".ma/**"],
        },
      });

      const result = await contextStep.execute(context);

      expect(result.outputs?.repoScan).toBeDefined();
      expect(result.outputs?.repoScan).toBeInstanceOf(Array);
      expect(result.outputs?.repoScan.length).toBeGreaterThan(0);

      const firstFile = result.outputs?.repoScan[0];
      expect(firstFile).toHaveProperty("path");
      expect(firstFile).toHaveProperty("bytes");
      expect(firstFile).toHaveProperty("mtime");
    });
  });

  describe("REQUIREMENT 2: Reviews MUST commit results to git", () => {
    it("should commit QA review result to .ma/tasks/{id}/reviews/qa.json", async () => {
      context.setVariable("qa_request_result", {
        status: "pass",
        summary: "All tests passing",
        findings: [],
      });

      const gitArtifactStep = new GitArtifactStep({
        name: "commit_qa_result",
        type: "GitArtifactStep",
        config: {
          source_output: "qa_request_result",
          artifact_path: ".ma/tasks/1/reviews/qa.json",
          commit_message: "test(ma): QA review for task 1",
          format: "json",
        },
      });

      const result = await gitArtifactStep.execute(context);
      expect(result.status).toBe("success");

      const qaPath = path.join(
        tempRepoDir,
        ".ma",
        "tasks",
        "1",
        "reviews",
        "qa.json",
      );
      const qaExists = await fs
        .access(qaPath)
        .then(() => true)
        .catch(() => false);
      expect(qaExists).toBe(true);

      const filesInCommit = await runGit(
        ["show", "--name-only", "--pretty=format:", "HEAD"],
        { cwd: tempRepoDir },
      );
      expect(filesInCommit.stdout).toContain(".ma/tasks/1/reviews/qa.json");
    });

    it("should commit code review result to .ma/tasks/{id}/reviews/code-review.json", async () => {
      context.setVariable("code_review_request_result", {
        status: "pass",
        summary: "Code looks good",
        findings: { severe: [], high: [], medium: [], low: [] },
      });

      const gitArtifactStep = new GitArtifactStep({
        name: "commit_code_review_result",
        type: "GitArtifactStep",
        config: {
          source_output: "code_review_request_result",
          artifact_path: ".ma/tasks/1/reviews/code-review.json",
          commit_message: "refactor(ma): code review for task 1",
          format: "json",
        },
      });

      const result = await gitArtifactStep.execute(context);
      expect(result.status).toBe("success");

      const reviewPath = path.join(
        tempRepoDir,
        ".ma",
        "tasks",
        "1",
        "reviews",
        "code-review.json",
      );
      const reviewExists = await fs
        .access(reviewPath)
        .then(() => true)
        .catch(() => false);
      expect(reviewExists).toBe(true);

      const latestCommit = await runGit(["log", "-1", "--pretty=%B"], {
        cwd: tempRepoDir,
      });
      expect(latestCommit.stdout).toContain(
        "refactor(ma): code review for task 1",
      );
    });

    it("should commit security review result to .ma/tasks/{id}/reviews/security.json", async () => {
      context.setVariable("security_request_result", {
        status: "pass",
        summary: "No vulnerabilities found",
        findings: { severe: [], high: [], medium: [], low: [] },
      });

      const gitArtifactStep = new GitArtifactStep({
        name: "commit_security_result",
        type: "GitArtifactStep",
        config: {
          source_output: "security_request_result",
          artifact_path: ".ma/tasks/1/reviews/security.json",
          commit_message: "security(ma): security review for task 1",
          format: "json",
        },
      });

      const result = await gitArtifactStep.execute(context);
      expect(result.status).toBe("success");

      const securityPath = path.join(
        tempRepoDir,
        ".ma",
        "tasks",
        "1",
        "reviews",
        "security.json",
      );
      const securityExists = await fs
        .access(securityPath)
        .then(() => true)
        .catch(() => false);
      expect(securityExists).toBe(true);
    });

    it("should commit devops review result to .ma/tasks/{id}/reviews/devops.json", async () => {
      context.setVariable("devops_request_result", {
        status: "pass",
        details: "CI/CD configured correctly",
        pipeline_status: "passing",
      });

      const gitArtifactStep = new GitArtifactStep({
        name: "commit_devops_result",
        type: "GitArtifactStep",
        config: {
          source_output: "devops_request_result",
          artifact_path: ".ma/tasks/1/reviews/devops.json",
          commit_message: "ci(ma): DevOps review for task 1",
          format: "json",
        },
      });

      const result = await gitArtifactStep.execute(context);
      expect(result.status).toBe("success");

      const devopsPath = path.join(
        tempRepoDir,
        ".ma",
        "tasks",
        "1",
        "reviews",
        "devops.json",
      );
      const devopsExists = await fs
        .access(devopsPath)
        .then(() => true)
        .catch(() => false);
      expect(devopsExists).toBe(true);
    });
  });

  describe("REQUIREMENT 3: Distributed agent recovery from git", () => {
    it("should allow second agent to read context from git", async () => {
      const contextStep = new ContextStep({
        name: "context_scan",
        type: "ContextStep",
        config: {
          repoPath: tempRepoDir,
          includePatterns: ["**/*"],
          excludePatterns: ["node_modules/**", ".git/**", ".ma/**"],
        },
      });
      await contextStep.execute(context);

      const snapshotPath = path.join(
        tempRepoDir,
        ".ma",
        "context",
        "snapshot.json",
      );
      const snapshotContent = await fs.readFile(snapshotPath, "utf-8");
      const snapshot = JSON.parse(snapshotContent);

      expect(snapshot.files).toBeInstanceOf(Array);
      expect(snapshot.totals.files).toBeGreaterThan(0);
      expect(snapshot.timestamp).toBeDefined();
    });

    it("should allow second agent to read review results from git", async () => {
      context.setVariable("qa_request_result", {
        status: "fail",
        summary: "Tests failing",
        findings: ["Test case 1 failed"],
      });

      const gitArtifactStep = new GitArtifactStep({
        name: "commit_qa_result",
        type: "GitArtifactStep",
        config: {
          source_output: "qa_request_result",
          artifact_path: ".ma/tasks/1/reviews/qa.json",
          commit_message: "test(ma): QA review for task 1",
          format: "json",
        },
      });
      await gitArtifactStep.execute(context);

      const qaPath = path.join(
        tempRepoDir,
        ".ma",
        "tasks",
        "1",
        "reviews",
        "qa.json",
      );
      const qaContent = await fs.readFile(qaPath, "utf-8");
      const qaResult = JSON.parse(qaContent);

      expect(qaResult.status).toBe("fail");
      expect(qaResult.summary).toBe("Tests failing");
      expect(qaResult.findings).toContain("Test case 1 failed");
    });
  });

  describe("REQUIREMENT 4: Workflow definitions use correct step types", () => {
    it("task-flow.yaml should use ContextStep not PersonaRequestStep for scanning", async () => {
      const workflowPath = path.join(
        process.cwd(),
        "src",
        "workflows",
        "definitions",
        "task-flow.yaml",
      );
      const workflowContent = await fs.readFile(workflowPath, "utf-8");

      expect(workflowContent).toContain("name: context_scan");
      expect(workflowContent).toContain("type: ContextStep");

      expect(workflowContent).toContain("name: context_request");
      expect(workflowContent).toContain("type: PersonaRequestStep");
    });

    it("task-flow.yaml should have GitArtifactStep after each review", async () => {
      const workflowPath = path.join(
        process.cwd(),
        "src",
        "workflows",
        "definitions",
        "task-flow.yaml",
      );
      const workflowContent = await fs.readFile(workflowPath, "utf-8");

      expect(workflowContent).toContain("name: commit_qa_result");
      expect(workflowContent).toContain("name: commit_code_review_result");
      expect(workflowContent).toContain("name: commit_security_result");
      expect(workflowContent).toContain("name: commit_devops_result");

      const qaCommitMatch = workflowContent.match(
        /name: commit_qa_result[\s\S]*?type: (\w+)/,
      );
      expect(qaCommitMatch?.[1]).toBe("GitArtifactStep");
    });

    it("in-review-task-flow.yaml should have GitArtifactStep after each review", async () => {
      const workflowPath = path.join(
        process.cwd(),
        "src",
        "workflows",
        "definitions",
        "in-review-task-flow.yaml",
      );
      const workflowContent = await fs.readFile(workflowPath, "utf-8");

      expect(workflowContent).toContain("name: commit_code_review_result");
      expect(workflowContent).toContain("name: commit_security_result");
      expect(workflowContent).toContain("name: commit_devops_result");
    });

    it("context persona payload should include snapshot references", async () => {
      const templatePath = path.join(
        process.cwd(),
        "src",
        "workflows",
        "templates",
        "step-templates.yaml",
      );
      const templateContent = await fs.readFile(templatePath, "utf-8");

      const contextTemplateSection = templateContent.match(
        /context_analysis:[\s\S]*?payload:([\s\S]*?)(?=\n {2}\w)/,
      );
      expect(contextTemplateSection).toBeDefined();
      expect(contextTemplateSection?.[0]).toContain("context_snapshot_json");
      expect(contextTemplateSection?.[0]).toContain("context_files_ndjson");
      expect(contextTemplateSection?.[0]).toContain("context_metadata");
    });
  });

  describe("REQUIREMENT 5: Audit trail and recovery", () => {
    it("should have complete git history for workflow execution", async () => {
      const contextStep = new ContextStep({
        name: "context_scan",
        type: "ContextStep",
        config: {
          repoPath: tempRepoDir,
          includePatterns: ["**/*"],
          excludePatterns: ["node_modules/**", ".git/**", ".ma/**"],
        },
      });
      await contextStep.execute(context);

      context.setVariable("qa_request_result", { status: "pass" });
      const qaStep = new GitArtifactStep({
        name: "commit_qa_result",
        type: "GitArtifactStep",
        config: {
          source_output: "qa_request_result",
          artifact_path: ".ma/tasks/1/reviews/qa.json",
          commit_message: "test(ma): QA review for task 1",
          format: "json",
        },
      });
      await qaStep.execute(context);

      context.setVariable("code_review_request_result", { status: "pass" });
      const codeStep = new GitArtifactStep({
        name: "commit_code_review_result",
        type: "GitArtifactStep",
        config: {
          source_output: "code_review_request_result",
          artifact_path: ".ma/tasks/1/reviews/code-review.json",
          commit_message: "refactor(ma): code review for task 1",
          format: "json",
        },
      });
      await codeStep.execute(context);

      const log = await runGit(["log", "--oneline", "--all"], {
        cwd: tempRepoDir,
      });
      const commits = log.stdout.trim().split("\n");

      expect(commits.length).toBeGreaterThanOrEqual(3);
      expect(log.stdout).toContain("context scan");
      expect(log.stdout).toContain("QA review");
      expect(log.stdout).toContain("code review");
    });

    it("should allow rebuilding workflow state from .ma/ directory", async () => {
      const contextStep = new ContextStep({
        name: "context_scan",
        type: "ContextStep",
        config: {
          repoPath: tempRepoDir,
          includePatterns: ["**/*"],
          excludePatterns: ["node_modules/**", ".git/**", ".ma/**"],
        },
      });
      await contextStep.execute(context);

      context.setVariable("qa_request_result", {
        status: "pass",
        summary: "Tests passing",
      });
      const qaStep = new GitArtifactStep({
        name: "commit_qa_result",
        type: "GitArtifactStep",
        config: {
          source_output: "qa_request_result",
          artifact_path: ".ma/tasks/1/reviews/qa.json",
          commit_message: "test(ma): QA review",
          format: "json",
        },
      });
      await qaStep.execute(context);

      const maPath = path.join(tempRepoDir, ".ma");
      const contextPath = path.join(maPath, "context");
      const reviewsPath = path.join(maPath, "tasks", "1", "reviews");

      const contextExists = await fs
        .access(contextPath)
        .then(() => true)
        .catch(() => false);
      const reviewsExists = await fs
        .access(reviewsPath)
        .then(() => true)
        .catch(() => false);

      expect(contextExists).toBe(true);
      expect(reviewsExists).toBe(true);

      const snapshotExists = await fs
        .access(path.join(contextPath, "snapshot.json"))
        .then(() => true)
        .catch(() => false);
      const summaryExists = await fs
        .access(path.join(contextPath, "summary.md"))
        .then(() => true)
        .catch(() => false);
      const qaExists = await fs
        .access(path.join(reviewsPath, "qa.json"))
        .then(() => true)
        .catch(() => false);

      expect(snapshotExists).toBe(true);
      expect(summaryExists).toBe(true);
      expect(qaExists).toBe(true);
    });
  });
});
