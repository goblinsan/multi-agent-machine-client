import { vi } from "vitest";
import { WorkflowCoordinator } from "../../src/workflows/WorkflowCoordinator.js";

export function createFastCoordinator(): WorkflowCoordinator {
  const coordinator = new WorkflowCoordinator();

  vi.spyOn(coordinator as any, "fetchProjectTasks").mockImplementation(
    async () => {
      return [];
    },
  );

  vi.spyOn(coordinator, "loadWorkflows").mockResolvedValue(undefined);
  return coordinator;
}

export function createDynamicTaskMocking(
  initialTasks: Array<{
    id: string;
    name: string;
    status: string;
    order?: number;
  }>,
) {
  const taskStatuses = new Map(initialTasks.map((t) => [t.id, t.status]));
  const taskData = new Map(initialTasks.map((t) => [t.id, t]));

  return {
    getStatus(taskId: string): string | undefined {
      return taskStatuses.get(taskId);
    },

    setStatus(taskId: string, status: string) {
      taskStatuses.set(taskId, status);
    },

    markDone(taskId: string) {
      taskStatuses.set(taskId, "done");
    },

    async setupDashboardMocks() {
      const { ProjectAPI } = await import("../../src/dashboard/ProjectAPI.js");
      const { TaskAPI } = await import("../../src/dashboard/TaskAPI.js");

      vi.spyOn(
        ProjectAPI.prototype,
        "fetchProjectStatusDetails",
      ).mockImplementation(async () => ({
        tasks: Array.from(taskStatuses.entries()).map(([id, status]) => {
          const task = taskData.get(id)!;
          return { ...task, status };
        }),
        repositories: [{ url: "https://example/repo.git" }],
      }));

      vi.spyOn(TaskAPI.prototype, "updateTaskStatus").mockImplementation(
        async (taskId: string, status: string) => {
          taskStatuses.set(taskId, status);
          return { ok: true, status: 200, body: {} };
        },
      );
    },
  };
}
