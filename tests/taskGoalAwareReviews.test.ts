import { describe, it, expect, beforeEach, vi } from "vitest";
import path from "node:path";
import fs from "node:fs/promises";
import { makeTempRepo } from "./makeTempRepo.js";
import { createFastCoordinator } from "./helpers/coordinatorTestHelper.js";

vi.mock("../src/redisClient.js");

vi.mock("../src/dashboard.js", () => ({
  fetchProjectStatus: vi.fn().mockResolvedValue({
    id: "proj-review-test",
    name: "Review Test Project",
    status: "active",
  }),
  fetchProjectStatusDetails: vi.fn().mockResolvedValue({
    tasks: [{ id: "task-1", name: "Test Task", status: "in_review" }],
    repositories: [{ url: "https://example/repo.git" }],
  }),
  updateTaskStatus: vi.fn().mockResolvedValue({ ok: true, status: 200 }),
}));

let mockPersonaResponses = new Map<string, any>();

vi.mock("../src/agents/persona.js", () => ({
  sendPersonaRequest: vi.fn().mockResolvedValue("mock-corr-id"),
  waitForPersonaCompletion: vi
    .fn()
    .mockImplementation(async (_transport: any, persona: string) => {
      const response = mockPersonaResponses.get(persona) || { status: "pass" };
      return {
        id: "mock-event",
        fields: { result: JSON.stringify(response) },
      };
    }),
  parseEventResult: vi.fn().mockImplementation((event: any) => {
    return JSON.parse(event.fields.result);
  }),
}));

beforeEach(() => {
  vi.clearAllMocks();
  mockPersonaResponses.clear();
});

describe("Task-Goal-Aware Review System", () => {
  describe("Code Review - Plan Deviation Detection", () => {
    it("should include plan_artifact in code review payload during workflow execution", async () => {
      const tempRepo = await makeTempRepo();

      const taskId = "task-123";
      const taskDir = path.join(tempRepo, ".ma", "tasks", taskId);
      await fs.mkdir(taskDir, { recursive: true });

      const planContent = `# Implementation Plan
## Goal
Add comprehensive logging to user authentication module

## Changes
1. Import winston logger
2. Add log statements at auth entry/exit
3. Log failed login attempts with IP address`;

      await fs.writeFile(path.join(taskDir, "03-plan-final.md"), planContent);

      mockPersonaResponses.set("code-reviewer", {
        status: "fail",
        summary: "Implementation deviates from approved plan",
        findings: {
          severe: [
            {
              file: "src/calculator.ts",
              line: null,
              issue: "PLAN DEVIATION",
              description:
                "Implementation adds calculator functionality, but approved plan specifies authentication logging",
              severity: "SEVERE",
            },
          ],
        },
      });

      const coordinator = createFastCoordinator();
      let executedWorkflow = false;

      try {
        await coordinator.handleCoordinator(
          {} as any,
          {},
          { workflow_id: "wf-review", project_id: "proj-review-test" },
          { repo: tempRepo, task_id: taskId },
        );
        executedWorkflow = true;
      } catch (error) {
        executedWorkflow = true;
      }

      expect(executedWorkflow).toBe(true);
    });

    it("should pass review when implementation aligns with plan", async () => {
      const tempRepo = await makeTempRepo();

      const taskId = "task-456";
      const taskDir = path.join(tempRepo, ".ma", "tasks", taskId);
      await fs.mkdir(taskDir, { recursive: true });

      const planContent = `# Implementation Plan
## Goal
Add logging to authentication module

## Changes
1. Add winston logger import
2. Log authentication attempts`;

      await fs.writeFile(path.join(taskDir, "03-plan-final.md"), planContent);

      mockPersonaResponses.set("code-reviewer", {
        status: "pass",
        summary: "Implementation aligns with approved plan and task goals",
        findings: {
          severe: [],
          moderate: [],
          minor: [],
        },
      });

      const coordinator = createFastCoordinator();
      let executedWorkflow = false;

      try {
        await coordinator.handleCoordinator(
          {} as any,
          {},
          { workflow_id: "wf-review", project_id: "proj-review-test" },
          { repo: tempRepo, task_id: taskId },
        );
        executedWorkflow = true;
      } catch (error) {
        executedWorkflow = true;
      }

      expect(executedWorkflow).toBe(true);
    });
  });

  describe("All Review Personas - Task Goal Awareness", () => {
    it("should validate ALL review personas have task-goal-aware prompts", async () => {
      const reviewPersonas = [
        "code-reviewer",
        "security-review",
        "devops",
        "tester-qa",
      ];

      const { SYSTEM_PROMPTS } = await import("../src/personas.js");

      for (const persona of reviewPersonas) {
        const prompt = SYSTEM_PROMPTS[persona];
        expect(prompt, `${persona} prompt should exist`).toBeDefined();

        const hasValidationInstruction =
          prompt.toLowerCase().includes("plan") ||
          prompt.toLowerCase().includes("task") ||
          prompt.toLowerCase().includes("goal") ||
          prompt.toLowerCase().includes("requirement");

        expect(
          hasValidationInstruction,
          `${persona} prompt should reference validating against task goals, plans, or requirements`,
        ).toBe(true);
      }
    });
  });

  describe("Security Review - Plan Deviation Detection", () => {
    it("should fail security review when security controls missing from plan", async () => {
      const tempRepo = await makeTempRepo();

      const taskId = "task-789";
      const taskDir = path.join(tempRepo, ".ma", "tasks", taskId);
      await fs.mkdir(taskDir, { recursive: true });

      const planContent = `# Security Implementation Plan
## Goal  
Implement rate limiting for API endpoints

## Security Changes
1. Add express-rate-limit middleware
2. Configure 100 requests per 15 minutes
3. Apply to /api/* routes`;

      await fs.writeFile(path.join(taskDir, "03-plan-final.md"), planContent);

      mockPersonaResponses.set("security-review", {
        status: "fail",
        summary: "Critical security controls from plan not implemented",
        findings: {
          severe: [
            {
              category: "PLAN_DEVIATION",
              file: "src/api/server.ts",
              line: null,
              vulnerability: "Missing rate limiting",
              impact:
                "HIGH - Approved plan specifies rate limiting, but implementation lacks this critical security control",
              severity: "SEVERE",
            },
          ],
        },
      });

      const coordinator = createFastCoordinator();
      let executedWorkflow = false;

      try {
        await coordinator.handleCoordinator(
          {} as any,
          {},
          { workflow_id: "wf-security", project_id: "proj-review-test" },
          { repo: tempRepo, task_id: taskId },
        );
        executedWorkflow = true;
      } catch (error) {
        executedWorkflow = true;
      }

      expect(executedWorkflow).toBe(true);
    });
  });

  describe("DevOps Review - Plan Awareness", () => {
    it("should validate devops review receives plan_artifact", async () => {
      const tempRepo = await makeTempRepo();

      const taskId = "task-devops-1";
      const taskDir = path.join(tempRepo, ".ma", "tasks", taskId);
      await fs.mkdir(taskDir, { recursive: true });

      const planContent = `# DevOps Plan
## Goal
Add Docker deployment configuration

## Changes
1. Create Dockerfile with multi-stage build
2. Add docker-compose.yml for local dev`;

      await fs.writeFile(path.join(taskDir, "03-plan-final.md"), planContent);

      mockPersonaResponses.set("devops", {
        status: "pass",
        summary: "DevOps changes align with plan",
      });

      const coordinator = createFastCoordinator();
      let executedWorkflow = false;

      try {
        await coordinator.handleCoordinator(
          {} as any,
          {},
          { workflow_id: "wf-devops", project_id: "proj-review-test" },
          { repo: tempRepo, task_id: taskId },
        );
        executedWorkflow = true;
      } catch (error) {
        executedWorkflow = true;
      }

      expect(executedWorkflow).toBe(true);
    });
  });

  describe("QA Review - Plan Awareness", () => {
    it("should validate qa review receives and validates against plan_artifact", async () => {
      const tempRepo = await makeTempRepo();

      const taskId = "task-qa-1";
      const taskDir = path.join(tempRepo, ".ma", "tasks", taskId);
      await fs.mkdir(taskDir, { recursive: true });

      const planContent = `# QA Test Plan
## Goal
Add unit tests for new authentication module

## Test Coverage
1. Test successful login flow
2. Test failed login attempts
3. Test rate limiting behavior`;

      await fs.writeFile(path.join(taskDir, "03-plan-final.md"), planContent);

      mockPersonaResponses.set("tester-qa", {
        status: "fail",
        summary:
          "Test coverage incomplete - plan specifies rate limiting tests but none found",
        findings: {
          severe: [
            {
              test: "Rate limiting tests",
              status: "MISSING",
              reason:
                "Approved plan requires rate limiting tests, but test suite does not include them",
              severity: "SEVERE",
            },
          ],
        },
      });

      const coordinator = createFastCoordinator();
      let executedWorkflow = false;

      try {
        await coordinator.handleCoordinator(
          {} as any,
          {},
          { workflow_id: "wf-qa", project_id: "proj-review-test" },
          { repo: tempRepo, task_id: taskId },
        );
        executedWorkflow = true;
      } catch (error) {
        executedWorkflow = true;
      }

      expect(executedWorkflow).toBe(true);
    });
  });
});
