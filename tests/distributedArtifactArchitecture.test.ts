import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
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

const publishTaskMock = vi.hoisted(() => vi.fn());
const publishProjectMock = vi.hoisted(() => vi.fn());
const fetchTaskMock = vi.hoisted(() => vi.fn());
const fetchProjectMock = vi.hoisted(() => vi.fn());

vi.mock("../src/dashboard/ArtifactAPI.js", () => ({
  ArtifactAPI: class {
    publishTaskArtifact = publishTaskMock;
    publishProjectArtifact = publishProjectMock;
    fetchTaskArtifacts = fetchTaskMock;
    fetchProjectArtifacts = fetchProjectMock;
  },
}));

describe("Distributed Artifact Architecture - CRITICAL REQUIREMENTS", () => {
  let tempRepoDir: string;
  let transport: LocalTransport;
  let context: WorkflowContext;

  beforeEach(async () => {
    publishTaskMock.mockReset().mockResolvedValue({ ok: true, artifactId: 1 });
    publishProjectMock.mockReset().mockResolvedValue({ ok: true, artifactId: 1 });
    fetchTaskMock.mockReset().mockResolvedValue(null);
    fetchProjectMock.mockReset().mockResolvedValue(null);

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

  describe("REQUIREMENT 1: Context artifacts are published to the API, not committed", () => {
    it("publishes the context snapshot to the dashboard", async () => {
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

      const kinds = publishProjectMock.mock.calls.map((c) => c[0].kind);
      expect(kinds.length).toBeGreaterThan(0);
    });

    it("creates no commits in the target repository", async () => {
      const before = await runGit(["rev-parse", "HEAD"], { cwd: tempRepoDir });

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

      const after = await runGit(["rev-parse", "HEAD"], { cwd: tempRepoDir });
      expect(after.stdout.trim()).toBe(before.stdout.trim());
    });
  });

  describe("REQUIREMENT 2: Review results are published to the API, not committed", () => {
    const reviews = [
      { name: "commit_qa_result", artifact: ".ma/tasks/1/reviews/qa.json", kind: "qa" },
      {
        name: "commit_code_review_result",
        artifact: ".ma/tasks/1/reviews/code-review.json",
        kind: "code_review",
      },
      {
        name: "commit_security_result",
        artifact: ".ma/tasks/1/reviews/security.json",
        kind: "security",
      },
      {
        name: "commit_devops_result",
        artifact: ".ma/tasks/1/reviews/devops.json",
        kind: "devops",
      },
    ];

    for (const review of reviews) {
      it(`publishes the ${review.kind} review without writing it into the repo`, async () => {
        context.setVariable("review_result", {
          status: "pass",
          summary: `${review.kind} ok`,
        });

        const step = new GitArtifactStep({
          name: review.name,
          type: "GitArtifactStep",
          config: {
            source_output: "review_result",
            artifact_path: review.artifact,
            commit_message: `test(ma): ${review.kind} review for task 1`,
            format: "json",
          },
        });

        const result = await step.execute(context);
        expect(result.status).toBe("success");

        expect(publishTaskMock).toHaveBeenCalledWith(
          expect.objectContaining({ kind: review.kind, taskId: "1" }),
        );

        await expect(
          fs.access(path.join(tempRepoDir, review.artifact)),
        ).rejects.toThrow();
      });
    }

    it("leaves the working tree clean after every review", async () => {
      context.setVariable("review_result", { status: "pass" });

      for (const review of reviews) {
        const step = new GitArtifactStep({
          name: review.name,
          type: "GitArtifactStep",
          config: {
            source_output: "review_result",
            artifact_path: review.artifact,
            commit_message: `test(ma): ${review.kind}`,
            format: "json",
          },
        });
        await step.execute(context);
      }

      const status = await runGit(["status", "--short"], { cwd: tempRepoDir });
      expect(status.stdout.trim()).toBe("");
    });
  });

  describe("REQUIREMENT 3: A second agent recovers state from the API", () => {
    it("hydrates context artifacts published by another agent", async () => {
      const snapshot = {
        files: [{ path: "src/example.ts", bytes: 30, lines: 1, sha: "abc" }],
        totals: { files: 1, bytes: 30 },
        timestamp: Date.now(),
      };

      const { CONTEXT_ARTIFACT_KINDS, hydrateContextArtifacts } = await import(
        "../src/workflows/steps/context/ContextArtifacts.js"
      );

      fetchProjectMock.mockImplementation(async ({ kind }: any) => {
        if (kind === CONTEXT_ARTIFACT_KINDS.snapshot) {
          return [{ kind, content: JSON.stringify(snapshot) }];
        }
        if (kind === CONTEXT_ARTIFACT_KINDS.summary) {
          return [{ kind, content: "# Summary" }];
        }
        if (kind === CONTEXT_ARTIFACT_KINDS.filesNdjson) {
          return [
            {
              kind,
              content: JSON.stringify({ path: "src/example.ts", bytes: 30 }) + "\n",
            },
          ];
        }
        return null;
      });

      const hydrated = await hydrateContextArtifacts(tempRepoDir, 1);
      expect(hydrated).toBe(true);

      const written = await fs.readFile(
        path.join(tempRepoDir, ".ma/context/snapshot.json"),
        "utf-8",
      );
      expect(JSON.parse(written).totals.files).toBe(1);
    });

    it("reads review results published by another agent", async () => {
      const { fetchArtifactContentFromApi } = await import(
        "../src/workflows/helpers/artifactReader.js"
      );

      fetchTaskMock.mockResolvedValue([
        {
          kind: "qa",
          content: JSON.stringify({
            status: "fail",
            summary: "Tests failing",
            findings: ["Test case 1 failed"],
          }),
        },
      ]);

      const content = await fetchArtifactContentFromApi({
        projectId: 1,
        taskId: 1,
        kind: "qa",
      });

      const qaResult = JSON.parse(content as string);
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
      expect(contextTemplateSection?.[0]).toContain("context_snapshot_slim");
      expect(contextTemplateSection?.[0]).toContain("context_summary_md");
      expect(contextTemplateSection?.[0]).toContain("context_metadata");
    });
  });

  describe("REQUIREMENT 5: The target repository stays free of workflow artifacts", () => {
    it("excludes .ma/ from the repository via git info/exclude", async () => {
      const { ensureMaExcludes } = await import("../src/git/setup/RepoSetup.js");

      await ensureMaExcludes(tempRepoDir);

      const excludeContents = await fs.readFile(
        path.join(tempRepoDir, ".git", "info", "exclude"),
        "utf8",
      );
      expect(excludeContents).toContain(".ma/");
    });

    it("keeps .ma/ untracked even after artifacts are written locally", async () => {
      const { ensureMaExcludes } = await import("../src/git/setup/RepoSetup.js");
      await ensureMaExcludes(tempRepoDir);

      await fs.mkdir(path.join(tempRepoDir, ".ma/context"), { recursive: true });
      await fs.writeFile(
        path.join(tempRepoDir, ".ma/context/snapshot.json"),
        JSON.stringify({ files: [] }),
      );

      const status = await runGit(["status", "--short"], { cwd: tempRepoDir });
      expect(status.stdout).not.toContain(".ma/");
    });
  });
});
