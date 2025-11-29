import { logger } from "../../logger.js";
import { TaskFetcher } from "./TaskFetcher.js";

export type DependencySelection = {
  selectedTask: any;
  parentTaskId?: string | number;
  dependencyId?: string | number;
  parentDependencyCount?: number;
  queueSnapshot?: Array<{
    dependencyId: string | number;
    parentTaskId: string | number;
  }>;
};

export class DependencyQueueManager {
  constructor(
    private readonly taskFetcher: TaskFetcher,
    private readonly logLimit: number,
  ) {}

  selectNextDependencyTask(tasks: any[]): DependencySelection | null {
    if (!Array.isArray(tasks) || tasks.length === 0) return null;

    const dependencyQueue = this.buildDependencyQueue(tasks);

    if (dependencyQueue.length === 0) {
      return null;
    }

    const head = dependencyQueue[0];

    return {
      selectedTask: head.task,
      parentTaskId: head.parentTaskId,
      dependencyId: head.dependencyId,
      parentDependencyCount: head.parentDependencyCount,
      queueSnapshot: dependencyQueue.slice(0, this.logLimit).map((item) => ({
        dependencyId: item.dependencyId,
        parentTaskId: item.parentTaskId,
      })),
    };
  }

  private buildDependencyQueue(tasks: any[]): Array<{
    task: any;
    parentTaskId: string | number;
    dependencyId: string | number;
    parentDependencyCount: number;
  }> {
    if (!Array.isArray(tasks) || tasks.length === 0) return [];

    const tasksById = new Map<string, any>();
    for (const task of tasks) {
      const key = this.normalizeId(task?.id);
      if (key) tasksById.set(key, task);
    }

    const queue: Array<{
      task: any;
      parentTaskId: string | number;
      dependencyId: string | number;
      parentDependencyCount: number;
    }> = [];

    const seenDependencies = new Set<string>();

    for (const task of tasks) {
      if (this.taskFetcher.normalizeTaskStatus(task?.status) !== "blocked") {
        continue;
      }

      const dependencyIds = this.parseBlockedDependencies(
        task?.blocked_dependencies,
      );

      if (dependencyIds.length === 0) continue;

      let pendingDependenciesFound = 0;

      for (const dependencyId of dependencyIds) {
        if (seenDependencies.has(dependencyId)) continue;

        const dependencyTask = tasksById.get(dependencyId);

        if (!dependencyTask) {
          logger.warn("Dependency task missing from dashboard payload", {
            parentTaskId: task?.id,
            dependencyId,
          });
          continue;
        }

        const dependencyStatus = this.taskFetcher.normalizeTaskStatus(
          dependencyTask?.status,
        );

        if (dependencyStatus === "done") {
          continue;
        }

        pendingDependenciesFound++;
        seenDependencies.add(dependencyId);
        queue.push({
          task: dependencyTask,
          parentTaskId: task?.id,
          dependencyId,
          parentDependencyCount: dependencyIds.length,
        });
      }

      if (pendingDependenciesFound === 0 && dependencyIds.length > 0) {
        logger.info("All dependencies resolved but parent still blocked", {
          parentTaskId: task?.id,
          dependencyIds,
        });
      }
    }

    return queue.sort((a, b) =>
      this.taskFetcher.compareTaskPriority(a.task, b.task),
    );
  }

  private parseBlockedDependencies(input: any): string[] {
    if (!input) return [];

    if (Array.isArray(input)) {
      return input.map((value) => this.normalizeId(value)).filter(Boolean);
    }

    if (typeof input === "string") {
      try {
        const parsed = JSON.parse(input);
        if (Array.isArray(parsed)) {
          return parsed
            .map((value) => this.normalizeId(value))
            .filter(Boolean);
        }
      } catch {
        return [this.normalizeId(input)].filter(Boolean);
      }
    }

    return [];
  }

  private normalizeId(value: any): string {
    if (value === null || value === undefined) return "";
    return String(value).trim();
  }
}
