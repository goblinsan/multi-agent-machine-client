import {
  WorkflowStep,
  StepResult,
  ValidationResult,
} from "../engine/WorkflowStep.js";
import { WorkflowContext } from "../engine/WorkflowContext.js";
import { logger } from "../../logger.js";
import { TaskAPI } from "../../dashboard/TaskAPI.js";

interface RegisterDependenciesConfig {
  project_id?: string | number;
  parent_task_id?: string | number;
  dependency_task_ids?: string[] | string | number;
  dependency_field?: string;
  allow_clear?: boolean;
}

const taskAPI = new TaskAPI();

export class RegisterBlockedDependenciesStep extends WorkflowStep {
  async execute(context: WorkflowContext): Promise<StepResult> {
    const config = this.config.config as RegisterDependenciesConfig;
    const projectId = this.resolveProjectId(config, context);
    const parentTaskId = this.resolveParentTaskId(config, context);
    const dependencyField = config.dependency_field || "blocked_dependencies";
    const collectedDependencyIds = this.collectDependencyIds(config, context);

    if (!projectId) {
      return {
        status: "failure",
        error: new Error("RegisterBlockedDependenciesStep requires project_id"),
      };
    }

    if (!parentTaskId) {
      return {
        status: "failure",
        error: new Error(
          "RegisterBlockedDependenciesStep requires parent_task_id",
        ),
      };
    }

    const dependencyIds = this.filterDependencyIds(
      collectedDependencyIds,
      parentTaskId,
    );

    if (dependencyIds.length !== collectedDependencyIds.length) {
      logger.info("Filtered dependency ids before registration", {
        workflowId: context.workflowId,
        stepName: this.config.name,
        parentTaskId,
        originalCount: collectedDependencyIds.length,
        filteredCount: dependencyIds.length,
      });
    }

    if (dependencyIds.length === 0) {
      if (config.allow_clear) {
        await taskAPI.updateBlockedDependencies(parentTaskId, projectId, []);
        context.setVariable(dependencyField, []);

        logger.info("Cleared blocked task dependencies", {
          workflowId: context.workflowId,
          stepName: this.config.name,
          parentTaskId,
        });

        return {
          status: "success",
          data: {
            updated: true,
            dependencyCount: 0,
            addedDependencies: 0,
          },
          outputs: {
            updated: true,
            dependencyCount: 0,
            dependencies: [],
          },
        } satisfies StepResult;
      }

      logger.info("No dependency ids provided, skipping registration", {
        workflowId: context.workflowId,
        stepName: this.config.name,
      });
      return {
        status: "success",
        data: {
          updated: false,
          dependencyCount: 0,
          addedDependencies: 0,
        },
        outputs: {
          updated: false,
          dependencyCount: 0,
        },
      };
    }

    try {
      const parentTask = await taskAPI.fetchTask(parentTaskId, projectId);
      if (!parentTask) {
        return {
          status: "failure",
          error: new Error(
            `Failed to load parent task ${parentTaskId} for dependency registration`,
          ),
        };
      }

      const existingDependencies = this.normalizeIds(
        parentTask[dependencyField] ||
          parentTask.metadata?.[dependencyField] ||
          [],
      );

      const merged = this.mergeDependencies(
        existingDependencies,
        dependencyIds,
      );

      const added = merged.length - existingDependencies.length;

      if (added === 0) {
        logger.info("Dependency list already up to date", {
          workflowId: context.workflowId,
          stepName: this.config.name,
          parentTaskId,
          dependencyCount: merged.length,
        });
        context.setVariable(dependencyField, merged);
        return {
          status: "success",
          data: {
            updated: false,
            dependencyCount: merged.length,
            addedDependencies: 0,
          },
          outputs: {
            updated: false,
            dependencyCount: merged.length,
          },
        };
      }

      await taskAPI.updateBlockedDependencies(parentTaskId, projectId, merged);

      context.setVariable(dependencyField, merged);

      logger.info("Registered new blocked task dependencies", {
        workflowId: context.workflowId,
        stepName: this.config.name,
        parentTaskId,
        dependencyCount: merged.length,
        added,
      });

      return {
        status: "success",
        data: {
          updated: true,
          dependencyCount: merged.length,
          addedDependencies: added,
        },
        outputs: {
          updated: true,
          dependencyCount: merged.length,
          dependencies: merged,
        },
      };
    } catch (error: any) {
      logger.error("Failed to register blocked task dependencies", {
        workflowId: context.workflowId,
        stepName: this.config.name,
        parentTaskId,
        error: error.message,
      });

      return {
        status: "failure",
        error: new Error(
          `Failed to register blocked task dependencies: ${error.message}`,
        ),
      };
    }
  }

  protected async validateConfig(
    _context: WorkflowContext,
  ): Promise<ValidationResult> {
    const config = this.config.config as RegisterDependenciesConfig;
    const errors: string[] = [];

    if (
      config.project_id !== undefined &&
      typeof config.project_id !== "string" &&
      typeof config.project_id !== "number"
    ) {
      errors.push("project_id must be a string or number when provided");
    }

    if (
      config.parent_task_id !== undefined &&
      typeof config.parent_task_id !== "string" &&
      typeof config.parent_task_id !== "number"
    ) {
      errors.push("parent_task_id must be a string or number when provided");
    }

    if (
      config.dependency_task_ids !== undefined &&
      !Array.isArray(config.dependency_task_ids) &&
      typeof config.dependency_task_ids !== "string" &&
      typeof config.dependency_task_ids !== "number"
    ) {
      errors.push(
        "dependency_task_ids must be an array, string, or number when provided",
      );
    }

    if (
      config.dependency_field !== undefined &&
      typeof config.dependency_field !== "string"
    ) {
      errors.push("dependency_field must be a string when provided");
    }

    if (
      config.allow_clear !== undefined &&
      typeof config.allow_clear !== "boolean"
    ) {
      errors.push("allow_clear must be a boolean when provided");
    }

    return {
      valid: errors.length === 0,
      errors,
      warnings: [],
    };
  }

  private resolveProjectId(
    config: RegisterDependenciesConfig,
    context: WorkflowContext,
  ): string | null {
    const value =
      config.project_id ||
      context.getVariable("project_id") ||
      context.getVariable("projectId");
    return value ? String(value) : null;
  }

  private resolveParentTaskId(
    config: RegisterDependenciesConfig,
    context: WorkflowContext,
  ): string | null {
    const task = context.getVariable("task");
    const value =
      config.parent_task_id ||
      context.getVariable("parent_task_id") ||
      context.getVariable("taskId") ||
      task?.id;
    return value ? String(value) : null;
  }

  private collectDependencyIds(
    config: RegisterDependenciesConfig,
    context: WorkflowContext,
  ): string[] {
    if (config.dependency_task_ids !== undefined) {
      return this.normalizeIds(config.dependency_task_ids);
    }

    const fromContext =
      context.getVariable("dependency_task_ids") ||
      context.getVariable("task_ids");

    return this.normalizeIds(fromContext);
  }

  private filterDependencyIds(ids: string[], parentTaskId: string): string[] {
    const filtered: string[] = [];

    for (const id of ids) {
      if (id === parentTaskId) {
        continue;
      }

      if (!filtered.includes(id)) {
        filtered.push(id);
      }
    }

    return filtered;
  }

  private normalizeIds(value: unknown): string[] {
    if (!value) return [];

    if (Array.isArray(value)) {
      return value
        .map((entry) => (entry === null || entry === undefined ? "" : String(entry)))
        .map((entry) => entry.trim())
        .filter((entry) => entry.length > 0);
    }

    if (typeof value === "string") {
      return value
        .split(/[,\s]+/)
        .map((entry) => entry.trim())
        .filter((entry) => entry.length > 0);
    }

    if (typeof value === "number") {
      return [String(value)];
    }

    return [];
  }

  private mergeDependencies(existing: string[], incoming: string[]): string[] {
    const merged = [...existing];
    for (const candidate of incoming) {
      if (!merged.includes(candidate)) {
        merged.push(candidate);
      }
    }
    return merged;
  }
}
