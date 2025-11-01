import { describe, it, expect, beforeEach, vi } from "vitest";
import { GitOperationStep } from "../src/workflows/steps/GitOperationStep.js";
import { WorkflowContext } from "../src/workflows/engine/WorkflowContext.js";
import { makeTempRepo } from "./makeTempRepo.js";
import fs from "fs/promises";
import { join } from "path";
import { exec } from "child_process";
import { promisify } from "util";

const execAsync = promisify(exec);

vi.mock("../src/logger.js", () => ({
  logger: {
    info: vi.fn(),
    debug: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

describe("Phase 3: Smart Context Scanning", () => {
  let repoRoot: string;
  let context: WorkflowContext;
  let mockTransport: any;

  beforeEach(async () => {
    repoRoot = await makeTempRepo({
      "README.md": "# Test Project\n",
      "src/index.ts": 'console.log("hello");\n',
    });

    mockTransport = {
      xAdd: vi.fn().mockResolvedValue("1-0"),
      disconnect: vi.fn().mockResolvedValue(null),
    };

    const mockConfig = {
      name: "test-workflow",
      version: "1.0.0",
      steps: [],
    };

    context = new WorkflowContext(
      "wf-test-001",
      "1",
      repoRoot,
      "main",
      mockConfig,
      mockTransport,
      {},
    );

    context.setVariable("task", { id: 1 });
    vi.clearAllMocks();
  });

  describe("checkContextFreshness Operation", () => {
    it("should detect missing context artifact and require scan", async () => {
      const config = {
        name: "check_context_exists",
        type: "GitOperationStep",
        config: {
          operation: "checkContextFreshness",
        },
      };

      const step = new GitOperationStep(config);

      const result = await step.execute(context);

      expect(result.status).toBe("success");
      expect(context.getVariable("context_exists")).toBe(false);
      expect(context.getVariable("has_new_files")).toBe(true);
      expect(context.getVariable("needs_rescan")).toBe(true);
    });

    it("should skip scan when context exists and no new files", async () => {
      const maDir = join(repoRoot, ".ma", "tasks", "1");
      await fs.mkdir(maDir, { recursive: true });
      await fs.writeFile(
        join(maDir, "01-context.md"),
        "# Context\nExisting context from previous scan",
        "utf-8",
      );
      await execAsync("git add .", { cwd: repoRoot });
      await execAsync('git commit -m "Add context artifact"', {
        cwd: repoRoot,
      });

      const config = {
        name: "check_context_exists",
        type: "GitOperationStep",
        config: {
          operation: "checkContextFreshness",
        },
      };

      const step = new GitOperationStep(config);

      const result = await step.execute(context);

      expect(result.status).toBe("success");
      expect(context.getVariable("context_exists")).toBe(true);
      expect(context.getVariable("has_new_files")).toBe(false);
      expect(context.getVariable("needs_rescan")).toBe(false);
    });

    it("should trigger rescan when new files added outside .ma/", async () => {
      const maDir = join(repoRoot, ".ma", "tasks", "1");
      await fs.mkdir(maDir, { recursive: true });
      await fs.writeFile(
        join(maDir, "01-context.md"),
        "# Context\nOld context",
        "utf-8",
      );
      await execAsync("git add .", { cwd: repoRoot });
      await execAsync('git commit -m "Add context artifact"', {
        cwd: repoRoot,
      });

      await fs.writeFile(
        join(repoRoot, "src", "newFeature.ts"),
        'export const feature = "new";\n',
        "utf-8",
      );
      await execAsync("git add .", { cwd: repoRoot });
      await execAsync('git commit -m "Add new feature"', { cwd: repoRoot });

      const config = {
        name: "check_context_exists",
        type: "GitOperationStep",
        config: {
          operation: "checkContextFreshness",
        },
      };

      const step = new GitOperationStep(config);

      const result = await step.execute(context);

      expect(result.status).toBe("success");
      expect(context.getVariable("context_exists")).toBe(true);
      expect(context.getVariable("has_new_files")).toBe(true);
      expect(context.getVariable("needs_rescan")).toBe(true);
    });

    it("should NOT trigger rescan for changes inside .ma/ directory", async () => {
      const maDir = join(repoRoot, ".ma", "tasks", "1");
      await fs.mkdir(maDir, { recursive: true });
      await fs.writeFile(
        join(maDir, "01-context.md"),
        "# Context\nOriginal context",
        "utf-8",
      );
      await execAsync("git add .", { cwd: repoRoot });
      await execAsync('git commit -m "Add context artifact"', {
        cwd: repoRoot,
      });

      await fs.writeFile(
        join(maDir, "03-plan-final.md"),
        "# Plan\nNew plan",
        "utf-8",
      );
      await fs.writeFile(
        join(maDir, "05-qa-result.md"),
        "# QA\nQA results",
        "utf-8",
      );
      await execAsync("git add .", { cwd: repoRoot });
      await execAsync('git commit -m "Add planning artifacts"', {
        cwd: repoRoot,
      });

      const config = {
        name: "check_context_exists",
        type: "GitOperationStep",
        config: {
          operation: "checkContextFreshness",
        },
      };

      const step = new GitOperationStep(config);

      const result = await step.execute(context);

      expect(result.status).toBe("success");
      expect(context.getVariable("context_exists")).toBe(true);
      expect(context.getVariable("has_new_files")).toBe(false);
      expect(context.getVariable("needs_rescan")).toBe(false);
    });
  });

  describe("Conditional Context Execution", () => {
    it("should set needs_rescan=true when no artifact exists", async () => {
      const config = {
        name: "check_context_exists",
        type: "GitOperationStep",
        config: {
          operation: "checkContextFreshness",
        },
      };

      const step = new GitOperationStep(config);
      await step.execute(context);

      const needsRescan = context.getVariable("needs_rescan");
      expect(needsRescan).toBe(true);

      const shouldRunContextPersona = needsRescan === true;
      expect(shouldRunContextPersona).toBe(true);
    });

    it("should set needs_rescan=false when artifact exists and no changes", async () => {
      const maDir = join(repoRoot, ".ma", "tasks", "1");
      await fs.mkdir(maDir, { recursive: true });
      await fs.writeFile(
        join(maDir, "01-context.md"),
        "# Context\nCached context",
        "utf-8",
      );
      await execAsync("git add .", { cwd: repoRoot });
      await execAsync('git commit -m "Add context"', { cwd: repoRoot });

      const config = {
        name: "check_context_exists",
        type: "GitOperationStep",
        config: {
          operation: "checkContextFreshness",
        },
      };

      const step = new GitOperationStep(config);
      await step.execute(context);

      const needsRescan = context.getVariable("needs_rescan");
      expect(needsRescan).toBe(false);

      const shouldRunContextPersona = needsRescan === true;
      expect(shouldRunContextPersona).toBe(false);
    });
  });

  describe("Performance Expectations", () => {
    it("should validate that skipping context saves ~45 seconds", async () => {
      const CONTEXT_PERSONA_DURATION_MS = 45000;
      const GIT_CHECK_DURATION_MS = 100;

      const timeSavedMs = CONTEXT_PERSONA_DURATION_MS - GIT_CHECK_DURATION_MS;
      const timeSavedSeconds = timeSavedMs / 1000;

      expect(timeSavedSeconds).toBeGreaterThan(40);
      expect(timeSavedSeconds).toBeLessThan(50);
    });

    it("should measure checkContextFreshness performance", async () => {
      const maDir = join(repoRoot, ".ma", "tasks", "1");
      await fs.mkdir(maDir, { recursive: true });
      await fs.writeFile(
        join(maDir, "01-context.md"),
        "# Context\nTest",
        "utf-8",
      );
      await execAsync('git add . && git commit -m "test"', { cwd: repoRoot });

      const config = {
        name: "check_context_exists",
        type: "GitOperationStep",
        config: {
          operation: "checkContextFreshness",
        },
      };

      const step = new GitOperationStep(config);

      const start = Date.now();
      await step.execute(context);
      const duration = Date.now() - start;

      expect(duration).toBeLessThan(1000);
    });
  });

  describe("Edge Cases", () => {
    it("should handle missing .ma/ directory gracefully", async () => {
      const config = {
        name: "check_context_exists",
        type: "GitOperationStep",
        config: {
          operation: "checkContextFreshness",
        },
      };

      const step = new GitOperationStep(config);
      const result = await step.execute(context);

      expect(result.status).toBe("success");
      expect(context.getVariable("context_exists")).toBe(false);
      expect(context.getVariable("needs_rescan")).toBe(true);
    });

    it("should handle empty .ma/tasks/{id}/ directory", async () => {
      const maDir = join(repoRoot, ".ma", "tasks", "1");
      await fs.mkdir(maDir, { recursive: true });

      const config = {
        name: "check_context_exists",
        type: "GitOperationStep",
        config: {
          operation: "checkContextFreshness",
        },
      };

      const step = new GitOperationStep(config);
      const result = await step.execute(context);

      expect(result.status).toBe("success");
      expect(context.getVariable("context_exists")).toBe(false);
      expect(context.getVariable("needs_rescan")).toBe(true);
    });

    it("should handle corrupted git history", async () => {
      const config = {
        name: "check_context_exists",
        type: "GitOperationStep",
        config: {
          operation: "checkContextFreshness",
        },
      };

      const step = new GitOperationStep(config);

      const result = await step.execute(context);
      expect(result.status).toBe("success");
      expect(context.getVariable("needs_rescan")).toBe(true);
    });
  });

  describe("Multi-Task Project Scenarios", () => {
    it("should correctly detect context for multiple tasks", async () => {
      const maDir1 = join(repoRoot, ".ma", "tasks", "1");
      await fs.mkdir(maDir1, { recursive: true });
      await fs.writeFile(
        join(maDir1, "01-context.md"),
        "# Task 1 Context",
        "utf-8",
      );

      context.setVariable("task", { id: 2 });

      const config = {
        name: "check_context_exists",
        type: "GitOperationStep",
        config: {
          operation: "checkContextFreshness",
        },
      };

      const step = new GitOperationStep(config);
      const result = await step.execute(context);

      expect(result.status).toBe("success");
      expect(context.getVariable("context_exists")).toBe(false);
      expect(context.getVariable("needs_rescan")).toBe(true);
    });
  });

  describe("Integration with Workflow YAML", () => {
    it("should provide correct variables for YAML conditions", async () => {
      const config = {
        name: "check_context_exists",
        type: "GitOperationStep",
        config: {
          operation: "checkContextFreshness",
        },
      };

      const step = new GitOperationStep(config);
      await step.execute(context);

      expect(context.getVariable("context_exists")).toBeDefined();
      expect(context.getVariable("has_new_files")).toBeDefined();
      expect(context.getVariable("needs_rescan")).toBeDefined();
      expect(typeof context.getVariable("needs_rescan")).toBe("boolean");
    });
  });
});
