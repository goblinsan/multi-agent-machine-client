import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { ContextExtractor } from "../../src/personas/context/ContextExtractor.js";
import { logger } from "../../src/logger.js";
import fs from "fs/promises";
import path from "path";
import { cfg } from "../../src/config.js";

describe("ContextExtractor", () => {
  let extractor: ContextExtractor;
  let tempDir: string;

  beforeEach(async () => {
    extractor = new ContextExtractor();

    tempDir = path.join(process.cwd(), "test-temp-" + Date.now());
    await fs.mkdir(tempDir, { recursive: true });
  });

  afterEach(async () => {
    try {
      await fs.rm(tempDir, { recursive: true, force: true });
    } catch (_error) {
      void 0;
    }
    vi.restoreAllMocks();
  });

  describe("extractUserText", () => {
    it("should prioritize user_text over all other sources", async () => {
      const userText = await extractor.extractUserText({
        persona: "test",
        workflowId: "wf-1",
        intent: "planning",
        payload: {
          user_text: "Explicit user text",
          task: {
            description: "Task description",
            title: "Task title",
          },
          description: "Payload description",
        },
      });

      expect(userText).toBe("Explicit user text");
    });

    it("should use task description when available", async () => {
      const userText = await extractor.extractUserText({
        persona: "implementation-planner",
        workflowId: "wf-1",
        intent: "planning",
        payload: {
          task: {
            id: 1,
            title: "Implement feature X",
            description: "Add feature X with Y functionality",
            type: "feature",
            scope: "medium",
          },
        },
      });

      expect(userText).toContain("Task: Implement feature X");
      expect(userText).toContain(
        "Description: Add feature X with Y functionality",
      );
      expect(userText).toContain("Type: feature");
      expect(userText).toContain("Scope: medium");
    });

    it("should use payload.description if no task.description", async () => {
      const userText = await extractor.extractUserText({
        persona: "test",
        workflowId: "wf-1",
        intent: "planning",
        payload: {
          description: "Simple description from payload",
        },
      });

      expect(userText).toBe("Simple description from payload");
    });

    it("should extract from task.data.description (dashboard structure)", async () => {
      const userText = await extractor.extractUserText({
        persona: "implementation-planner",
        workflowId: "wf-1",
        intent: "planning",
        payload: {
          task: {
            id: 1,
            type: "feature",
            persona: "lead_engineer",
            data: {
              id: 1,
              title: "Config loader and schema validation",
              description:
                "Implement hierarchical config (env, file, CLI) with JSON schema validation and a .example.env. Include defaults for log paths, store, and LM Studio endpoint.",
              status: "in_progress",
              priority_score: 0,
              milestone_id: 1,
              labels: ["backend", "config", "infra"],
              milestone: {
                id: 1,
                name: "Foundation & Config",
                slug: "foundation-config",
                status: "active",
              },
              requirements: [],
            },
            timestamp: 1761884350933,
          },
        },
      });

      expect(userText).toContain("Task: Config loader and schema validation");
      expect(userText).toContain("Description: Implement hierarchical config");
      expect(userText).toContain("JSON schema validation");
      expect(userText).toContain(".example.env");
    });

    it("should throw error if task has no description", async () => {
      await expect(
        extractor.extractUserText({
          persona: "implementation-planner",
          workflowId: "wf-1",
          intent: "planning",
          payload: {
            task: {
              id: 5,
              title: "Task without description",
            },
          },
        }),
      ).rejects.toThrow("has no description");
    });

    it("should throw error if task.data exists but has no description", async () => {
      await expect(
        extractor.extractUserText({
          persona: "implementation-planner",
          workflowId: "wf-1",
          intent: "planning",
          payload: {
            task: {
              id: 5,
              type: "feature",
              persona: "lead_engineer",
              data: {
                id: 5,
                title: "Task without description",
                status: "open",
                priority_score: 0,
                milestone_id: 1,
              },
              timestamp: Date.now(),
            },
          },
        }),
      ).rejects.toThrow("has no description");
    });

    it("should throw error instead of falling back to intent when no task context available", async () => {
      await expect(
        extractor.extractUserText({
          persona: "test",
          workflowId: "wf-1",
          intent: "custom_intent",
          payload: {},
        }),
      ).rejects.toThrow("CRITICAL: No task context found");
    });
  });

  describe("readArtifactFromGit", () => {
    it("should read artifact from git repo", async () => {
      const repoName = "test-repo";
      const repoPath = path.join(tempDir, repoName);
      const artifactPath = "artifacts/plan.md";
      const fullPath = path.join(repoPath, artifactPath);

      await fs.mkdir(path.dirname(fullPath), { recursive: true });
      await fs.writeFile(fullPath, "# Test Plan\n\nThis is a test plan.");

      const originalProjectBase = cfg.projectBase;
      cfg.projectBase = tempDir;

      try {
        const content = await extractor.readArtifactFromGit(
          artifactPath,
          `https://github.com/test/${repoName}.git`,
        );

        expect(content).toBe("# Test Plan\n\nThis is a test plan.");
      } finally {
        cfg.projectBase = originalProjectBase;
      }
    });

    it("should throw error if repo URL not provided", async () => {
      await expect(
        extractor.readArtifactFromGit("artifacts/plan.md", undefined),
      ).rejects.toThrow("Repository path or URL is required");
    });

    it("should throw error if artifact file does not exist", async () => {
      const originalProjectBase = cfg.projectBase;
      cfg.projectBase = tempDir;

      try {
        await expect(
          extractor.readArtifactFromGit(
            "nonexistent/file.md",
            "https://github.com/test/repo.git",
          ),
        ).rejects.toThrow("Failed to read artifact");
      } finally {
        cfg.projectBase = originalProjectBase;
      }
    });

    it("should prefer repo_root when provided", async () => {
      const repoRoot = path.join(tempDir, "custom-root");
      const artifactPath = ".ma/tasks/1/03-plan-final.md";
      const fullPath = path.join(repoRoot, artifactPath);

      await fs.mkdir(path.dirname(fullPath), { recursive: true });
      await fs.writeFile(fullPath, "Plan via repo_root", "utf8");

      const originalProjectBase = cfg.projectBase;
      cfg.projectBase = path.join(tempDir, "project-base");

      try {
        const content = await extractor.readArtifactFromGit(
          artifactPath,
          "https://github.com/test/machine-client-log-summarizer.git",
          repoRoot,
        );

        expect(content).toBe("Plan via repo_root");
      } finally {
        cfg.projectBase = originalProjectBase;
      }
    });

    it("should read artifact when only repo_root is supplied", async () => {
      const repoRoot = path.join(tempDir, "root-only");
      const artifactPath = "docs/plan.md";
      const fullPath = path.join(repoRoot, artifactPath);

      await fs.mkdir(path.dirname(fullPath), { recursive: true });
      await fs.writeFile(fullPath, "root only content", "utf8");

      const content = await extractor.readArtifactFromGit(
        artifactPath,
        undefined,
        repoRoot,
      );

      expect(content).toBe("root only content");
    });
  });

  describe("resolveArtifactPath", () => {
    it("should resolve {repo} placeholder", () => {
      const resolved = extractor.resolveArtifactPath(
        "artifacts/{repo}/plan.md",
        {
          repo: "https://github.com/owner/my-repo.git",
        },
      );

      expect(resolved).toBe("artifacts/my-repo/plan.md");
    });

    it("should resolve {branch} placeholder", () => {
      const resolved = extractor.resolveArtifactPath(
        "artifacts/{branch}/context.md",
        {
          branch: "feature/new-feature",
        },
      );

      expect(resolved).toBe("artifacts/feature/new-feature/context.md");
    });

    it("should resolve {workflow_id} placeholder", () => {
      const resolved = extractor.resolveArtifactPath(
        "workflows/{workflow_id}/output.json",
        {
          workflow_id: "wf-12345",
        },
      );

      expect(resolved).toBe("workflows/wf-12345/output.json");
    });

    it("should resolve multiple placeholders", () => {
      const resolved = extractor.resolveArtifactPath(
        "{repo}/{branch}/{workflow_id}/plan.md",
        {
          repo: "https://github.com/owner/test-repo.git",
          branch: "main",
          workflow_id: "wf-abc",
        },
      );

      expect(resolved).toBe("test-repo/main/wf-abc/plan.md");
    });

    it("should keep unresolved placeholders if variable not found", () => {
      const resolved = extractor.resolveArtifactPath(
        "artifacts/{unknown}/plan.md",
        {
          repo: "test-repo",
        },
      );

      expect(resolved).toBe("artifacts/{unknown}/plan.md");
    });
  });

  describe("extractContext", () => {
    it("should extract all context components", async () => {
      const context = await extractor.extractContext({
        persona: "implementation-planner",
        workflowId: "wf-1",
        intent: "planning",
        payload: {
          task: {
            id: 1,
            title: "Test task",
            description: "Test description",
          },
        },
      });

      expect(context.userText).toContain("Test task");
      expect(context.userText).toContain("Test description");
      expect(context.scanSummary).toBeNull();
      expect(context.dashboardContext).toBeNull();
    });
  });

  describe("artifact reading with fallback", () => {
    it("should handle plan_artifact", async () => {
      const repoName = "test-repo";
      const repoPath = path.join(tempDir, repoName);
      const artifactPath = "artifacts/plan.md";
      const fullPath = path.join(repoPath, artifactPath);

      await fs.mkdir(path.dirname(fullPath), { recursive: true });
      await fs.writeFile(fullPath, "# Approved Plan\n\nImplement feature.");

      const originalProjectBase = cfg.projectBase;
      cfg.projectBase = tempDir;

      try {
        const userText = await extractor.extractUserText({
          persona: "lead-engineer",
          workflowId: "wf-1",
          intent: "implementation",
          payload: {
            plan_artifact: artifactPath,
            repo: `https://github.com/test/${repoName}.git`,
            repo_root: repoPath,
          },
          repo: `https://github.com/test/${repoName}.git`,
        });

        expect(userText).toContain("Approved Plan");
        expect(userText).toContain("Implement feature");
      } finally {
        cfg.projectBase = originalProjectBase;
      }
    });

    it("should throw error instead of falling back to intent when artifact reading fails and no task context", async () => {
      await expect(
        extractor.extractUserText({
          persona: "test",
          workflowId: "wf-1",
          intent: "fallback_intent",
          payload: {
            plan_artifact: "nonexistent/file.md",
            repo: "https://github.com/test/repo.git",
          },
          repo: "https://github.com/test/repo.git",
        }),
      ).rejects.toThrow("CRITICAL: No task context found");
    });
  });

  describe("logging behavior", () => {
    it("should log when using task description", async () => {
      const infoSpy = vi.spyOn(logger, "info");

      await extractor.extractUserText({
        persona: "implementation-planner",
        workflowId: "wf-1",
        intent: "planning",
        payload: {
          task: {
            id: 1,
            title: "Test task",
            description: "Test description",
          },
        },
      });

      expect(infoSpy).toHaveBeenCalledWith(
        "PersonaConsumer: Using task description",
        expect.objectContaining({
          persona: "implementation-planner",
          workflowId: "wf-1",
          hasDescription: true,
        }),
      );
    });

    it("should log error when task has no description", async () => {
      const errorSpy = vi.spyOn(logger, "error");

      try {
        await extractor.extractUserText({
          persona: "implementation-planner",
          workflowId: "wf-1",
          intent: "planning",
          payload: {
            task: {
              id: 5,
              title: "Task without description",
            },
          },
        });
      } catch (_error) {
        void 0;
      }

      expect(errorSpy).toHaveBeenCalledWith(
        "PersonaConsumer: CRITICAL - Task has no description",
        expect.objectContaining({
          persona: "implementation-planner",
          reason:
            "Task description is required for planning and implementation",
        }),
      );
    });
  });
});
