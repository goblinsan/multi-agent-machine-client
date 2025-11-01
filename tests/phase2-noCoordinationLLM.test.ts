import { describe, it, expect, beforeEach, vi } from "vitest";
import { WorkflowCoordinator } from "../src/workflows/WorkflowCoordinator.js";
import { ProjectAPI } from "../src/dashboard/ProjectAPI.js";
import { makeTempRepo } from "./makeTempRepo.js";
import * as persona from "../src/agents/persona.js";

vi.mock("../src/dashboard/ProjectAPI.js");
vi.mock("../src/agents/persona.js");
vi.mock("../src/gitUtils.js", () => ({
  resolveRepoFromPayload: vi.fn().mockResolvedValue({
    repoRoot: "/test/repo",
    remote: "git@github.com:test/repo.git",
    branch: "main",
  }),
  runGit: vi.fn().mockResolvedValue(""),
}));
vi.mock("../src/logger.js", () => ({
  logger: {
    info: vi.fn(),
    debug: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

describe("Phase 2: Remove Coordination Persona LLM Call", () => {
  let coordinator: WorkflowCoordinator;
  let mockTransport: any;
  let _repoRoot: string;

  beforeEach(async () => {
    _repoRoot = await makeTempRepo();

    coordinator = new WorkflowCoordinator();

    mockTransport = {
      xAdd: vi.fn().mockResolvedValue("1-0"),
      xGroupCreate: vi.fn().mockResolvedValue(null),
      xReadGroup: vi.fn().mockResolvedValue({}),
      xAck: vi.fn().mockResolvedValue(null),
      disconnect: vi.fn().mockResolvedValue(null),
    };

    vi.mocked(ProjectAPI.prototype.fetchProjectStatus).mockResolvedValue({
      id: "1",
      name: "Test Project",
      slug: "test-project",
      repository: {
        clone_url: "git@github.com:test/repo.git",
      },
    });

    vi.mocked(ProjectAPI.prototype.fetchProjectStatusDetails).mockResolvedValue(
      {
        milestones: [],
      },
    );

    vi.spyOn(coordinator, "fetchProjectTasks").mockResolvedValue([]);

    vi.clearAllMocks();
  });

  describe("Coordinator Startup", () => {
    it("should NOT call coordination persona on startup", async () => {
      const msg = {
        workflow_id: "wf-coord-test",
        project_id: "1",
        step: "00",
        from: "user",
        to_persona: "coordination",
        intent: "orchestrate_milestone",
        corr_id: "corr-123",
      };

      const payload = {
        project_id: "1",
      };

      await coordinator.handleCoordinator(mockTransport, {}, msg, payload);

      expect(persona.sendPersonaRequest).not.toHaveBeenCalled();
      expect(persona.waitForPersonaCompletion).not.toHaveBeenCalled();
    });

    it("should fetch tasks directly from dashboard", async () => {
      const mockTasks = [
        { id: 1, status: "open", priority_score: 100 },
        { id: 2, status: "in_progress", priority_score: 200 },
      ];

      vi.spyOn(coordinator, "fetchProjectTasks").mockResolvedValue(mockTasks);

      const msg = {
        workflow_id: "wf-coord-test",
        project_id: "1",
      };

      const payload = {
        project_id: "1",
      };

      await coordinator.handleCoordinator(mockTransport, {}, msg, payload);

      expect(coordinator.fetchProjectTasks).toHaveBeenCalledWith("1");
      expect(persona.sendPersonaRequest).not.toHaveBeenCalled();
    });
  });

  describe("Task Priority Selection", () => {
    it("should select highest priority_score task without LLM", async () => {
      const mockTasks = [
        { id: 1, status: "open", priority_score: 100, name: "Low priority" },
        { id: 2, status: "open", priority_score: 500, name: "High priority" },
        { id: 3, status: "open", priority_score: 200, name: "Medium priority" },
      ];

      const mockWorkflow = {
        name: "task-flow",
        version: "3.0.0",
        steps: [],
        trigger: { condition: "task_type == 'task' || task_type == 'feature'" },
      };
      const mockEngine = {
        loadWorkflowsFromDirectory: vi.fn().mockResolvedValue([mockWorkflow]),
        getWorkflowDefinitions: vi.fn().mockReturnValue([mockWorkflow]),
        getWorkflowDefinition: vi.fn().mockReturnValue(null),
        findWorkflowByCondition: vi.fn().mockReturnValue(mockWorkflow),
        executeWorkflowDefinition: vi.fn().mockResolvedValue({
          success: true,
          completedSteps: [],
          duration: 0,
        }),
      };

      coordinator = new WorkflowCoordinator(mockEngine as any);

      vi.spyOn(coordinator, "fetchProjectTasks")
        .mockResolvedValueOnce(mockTasks)
        .mockResolvedValueOnce([]);

      const msg = { workflow_id: "wf-test", project_id: "1" };
      const payload = { project_id: "1" };

      await coordinator.handleCoordinator(mockTransport, {}, msg, payload);

      expect(mockEngine.executeWorkflowDefinition).toHaveBeenCalled();
      const executeCall = vi.mocked(mockEngine.executeWorkflowDefinition).mock
        .calls[0];
      const initialVars = executeCall[5];
      expect(initialVars.task.id).toBe(2);
      expect(initialVars.taskName).toBe("High priority");

      expect(persona.sendPersonaRequest).not.toHaveBeenCalled();
    });

    it("should prioritize blocked/in_review over open tasks", async () => {
      const mockTasks = [
        { id: 1, status: "open", priority_score: 100 },
        { id: 2, status: "blocked", priority_score: 100 },
        { id: 3, status: "in_review", priority_score: 50 },
      ];

      const mockWorkflow = {
        name: "task-flow",
        version: "3.0.0",
        steps: [],
        trigger: { condition: "task_type == 'task' || task_type == 'feature'" },
      };
      const mockEngine = {
        loadWorkflowsFromDirectory: vi.fn().mockResolvedValue([]),
        getWorkflowDefinitions: vi.fn().mockReturnValue([mockWorkflow]),
        getWorkflowDefinition: vi.fn().mockReturnValue(null),
        findWorkflowByCondition: vi.fn().mockReturnValue(mockWorkflow),
        executeWorkflowDefinition: vi.fn().mockResolvedValue({
          success: true,
          completedSteps: [],
          duration: 0,
        }),
      };

      coordinator = new WorkflowCoordinator(mockEngine as any);

      vi.spyOn(coordinator, "fetchProjectTasks")
        .mockResolvedValueOnce(mockTasks)
        .mockResolvedValueOnce([]);

      const msg = { workflow_id: "wf-test", project_id: "1" };
      const payload = { project_id: "1" };

      await coordinator.handleCoordinator(mockTransport, {}, msg, payload);

      expect(mockEngine.executeWorkflowDefinition).toHaveBeenCalled();
      const executeCall = vi.mocked(mockEngine.executeWorkflowDefinition).mock
        .calls[0];
      const initialVars = executeCall[5];
      expect(initialVars.task.id).toBe(2);

      expect(persona.sendPersonaRequest).not.toHaveBeenCalled();
    });
  });

  describe("Performance Validation", () => {
    it("should complete coordinator startup in < 1 second (no LLM overhead)", async () => {
      vi.spyOn(coordinator, "fetchProjectTasks").mockResolvedValue([]);

      const msg = { workflow_id: "wf-perf-test", project_id: "1" };
      const payload = { project_id: "1" };

      const start = Date.now();
      await coordinator.handleCoordinator(mockTransport, {}, msg, payload);
      const duration = Date.now() - start;

      expect(duration).toBeLessThan(1000);
      expect(persona.sendPersonaRequest).not.toHaveBeenCalled();
    });
  });

  describe("Engineering Work Validation", () => {
    it("should NOT invoke planning loop at coordinator level", async () => {
      const mockTasks = [{ id: 1, status: "open", name: "Test task" }];

      const mockWorkflow = {
        name: "task-flow",
        version: "3.0.0",
        steps: [],
        trigger: { condition: "task_type == 'task' || task_type == 'feature'" },
      };
      const mockEngine = {
        loadWorkflowsFromDirectory: vi.fn().mockResolvedValue([]),
        getWorkflowDefinitions: vi.fn().mockReturnValue([mockWorkflow]),
        getWorkflowDefinition: vi.fn().mockReturnValue(null),
        findWorkflowByCondition: vi.fn().mockReturnValue(mockWorkflow),
        executeWorkflowDefinition: vi.fn().mockResolvedValue({
          success: true,
          completedSteps: [],
          duration: 0,
        }),
      };

      coordinator = new WorkflowCoordinator(mockEngine as any);

      vi.spyOn(coordinator, "fetchProjectTasks")
        .mockResolvedValueOnce(mockTasks)
        .mockResolvedValueOnce([]);

      const msg = { workflow_id: "wf-test", project_id: "1" };
      const payload = { project_id: "1" };

      await coordinator.handleCoordinator(mockTransport, {}, msg, payload);

      expect(mockEngine.executeWorkflowDefinition).toHaveBeenCalledTimes(1);

      expect(persona.sendPersonaRequest).not.toHaveBeenCalled();
    });
  });
});
