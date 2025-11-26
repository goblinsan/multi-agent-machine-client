import {
  StepResult,
  ValidationResult,
  WorkflowStep,
} from "../engine/WorkflowStep.js";
import { WorkflowContext } from "../engine/WorkflowContext.js";
import { logger } from "../../logger.js";
import { TaskAPI } from "../../dashboard/TaskAPI.js";
import { resolveVariablePath } from "../engine/conditionUtils.js";

interface DependencyStatusConfig {
  dependency_variable?: string;
  fallback_task_field?: string;
  resolved_statuses?: string[];
}

interface DependencyTaskSummary {
  id: string;
  status: string;
  task: any;
  error?: string;
}

const taskAPI = new TaskAPI();

export class DependencyStatusStep extends WorkflowStep {
  async execute(context: WorkflowContext): Promise<StepResult> {
    const config = this.config.config as DependencyStatusConfig;
    const dependencyVariable = config.dependency_variable ||
      "blocked_dependencies";
    const fallbackField = config.fallback_task_field ||
      "task.blocked_dependencies";
    const resolvedStatuses = (config.resolved_statuses || [
      "done",
      "completed",
      "finished",
      "closed",
      "resolved",
    ]).map((status) => status.toLowerCase());

    const projectId =
      (context.getVariable("projectId") ??
        context.getVariable("project_id")) ||
      null;

    if (!projectId) {
      return {
        status: "failure",
        error: new Error(
          "DependencyStatusStep requires projectId in workflow context",
        ),
      };
    }

    let dependencyIds = this.collectDependencyIds(
      context,
      dependencyVariable,
      fallbackField,
    );

    if (dependencyIds.length === 0) {
      const refreshed = await this.refreshDependenciesFromTask(
        context,
        projectId,
      );
      if (refreshed.length > 0) {
        dependencyIds = refreshed;
        context.setVariable("blocked_dependencies", refreshed);

        logger.info("DependencyStatusStep: refreshed dependencies from task", {
          workflowId: context.workflowId,
          dependencyCount: refreshed.length,
        });
      }
    }

    if (!dependencyIds.length) {
      const summary = {
        dependencyIds: [] as string[],
        dependencyCount: 0,
        resolved: [] as DependencyTaskSummary[],
        resolvedCount: 0,
        pending: [] as DependencyTaskSummary[],
        pendingCount: 0,
        allResolved: true,
      };

      context.setVariable("blocked_dependencies", []);
      context.setVariable("dependency_status", summary);

      logger.info("No dependency tasks found", {
        workflowId: context.workflowId,
      });

      return {
        status: "success",
        data: summary,
        outputs: summary,
      };
    }

    const uniqueIds = Array.from(new Set(dependencyIds.map(String))).filter(
      (id) => id.length > 0,
    );

    const resolved: DependencyTaskSummary[] = [];
    const pending: DependencyTaskSummary[] = [];
    const errors: Record<string, string> = {};

    for (const depId of uniqueIds) {
      try {
        const task = await taskAPI.fetchTask(depId, projectId);
        if (!task) {
          pending.push({
            id: depId,
            status: "unknown",
            task: null,
            error: "not_found",
          });
          errors[depId] = "Task not found";
          continue;
        }

        const status = String(task.status || task.state || "unknown").toLowerCase();
        const summary: DependencyTaskSummary = {
          id: depId,
          status,
          task,
        };

        if (resolvedStatuses.includes(status)) {
          resolved.push(summary);
        } else {
          pending.push(summary);
        }
      } catch (error: any) {
        const message = error?.message || String(error);
        logger.warn("Dependency lookup failed", {
          workflowId: context.workflowId,
          dependencyId: depId,
          projectId,
          error: message,
        });

        pending.push({
          id: depId,
          status: "error",
          task: null,
          error: message,
        });
        errors[depId] = message;
      }
    }

    const summary = {
      dependencyIds: uniqueIds,
      dependencyCount: uniqueIds.length,
      resolved,
      resolvedCount: resolved.length,
      pending,
      pendingCount: pending.length,
      allResolved: pending.length === 0,
      errors: Object.keys(errors).length ? errors : undefined,
    };

    context.setVariable("blocked_dependencies", uniqueIds);
    context.setVariable("dependency_status", summary);

    logger.info("Dependency status evaluated", {
      workflowId: context.workflowId,
      dependencyCount: summary.dependencyCount,
      resolvedCount: summary.resolvedCount,
      pendingCount: summary.pendingCount,
      allResolved: summary.allResolved,
    });

    return {
      status: "success",
      data: summary,
      outputs: summary,
    };
  }

  async validate(_context: WorkflowContext): Promise<ValidationResult> {
    const config = this.config.config as DependencyStatusConfig;

    if (
      config.dependency_variable !== undefined &&
      typeof config.dependency_variable !== "string"
    ) {
      return {
        valid: false,
        errors: [
          "DependencyStatusStep: dependency_variable must be a string when provided",
        ],
        warnings: [],
      };
    }

    if (
      config.fallback_task_field !== undefined &&
      typeof config.fallback_task_field !== "string"
    ) {
      return {
        valid: false,
        errors: [
          "DependencyStatusStep: fallback_task_field must be a string when provided",
        ],
        warnings: [],
      };
    }

    if (
      config.resolved_statuses !== undefined &&
      !Array.isArray(config.resolved_statuses)
    ) {
      return {
        valid: false,
        errors: [
          "DependencyStatusStep: resolved_statuses must be an array when provided",
        ],
        warnings: [],
      };
    }

    return {
      valid: true,
      errors: [],
      warnings: [],
    };
  }

  private collectDependencyIds(
    context: WorkflowContext,
    variableName: string,
    fallbackField: string,
  ): string[] {
    const ids: string[] = [];

    const directValue = context.getVariable(variableName);
    this.appendIds(ids, directValue);

    if (fallbackField && fallbackField !== variableName) {
      const fallbackValue = resolveVariablePath(fallbackField, context);
      this.appendIds(ids, fallbackValue);
    }

    return ids;
  }

  private appendIds(target: string[], source: any): void {
    if (!source) return;

    if (Array.isArray(source)) {
      for (const value of source) {
        if (value === null || value === undefined) continue;
        target.push(String(value));
      }
      return;
    }

    if (typeof source === "string" && source.trim().length > 0) {
      const split = source.split(/[\s,]+/).map((s) => s.trim()).filter(Boolean);
      target.push(...split);
      return;
    }

    if (typeof source === "number") {
      target.push(String(source));
    }
  }

  private async refreshDependenciesFromTask(
    context: WorkflowContext,
    projectId: string,
  ): Promise<string[]> {
    const taskId = this.resolveTaskId(context);
    if (!taskId) {
      return [];
    }

    try {
      const latestTask = await taskAPI.fetchTask(taskId, projectId);
      if (!latestTask) {
        return [];
      }

      const existingTask = context.getVariable("task") || {};
      context.setVariable("task", { ...existingTask, ...latestTask });

      const dependencies = this.extractDependenciesFromTask(latestTask);
      return dependencies;
    } catch (error: any) {
      logger.warn("DependencyStatusStep: failed to refresh dependencies", {
        workflowId: context.workflowId,
        taskId,
        error: error?.message || String(error),
      });
      return [];
    }
  }

  private resolveTaskId(context: WorkflowContext): string | null {
    const task = context.getVariable("task");
    const value =
      context.getVariable("taskId") ||
      context.getVariable("task_id") ||
      task?.id;
    return value ? String(value) : null;
  }

  private extractDependenciesFromTask(task: any): string[] {
    if (!task) {
      return [];
    }

    const direct = task.blocked_dependencies;
    if (direct && direct.length) {
      return this.normalizeIds(direct);
    }

    if (task.metadata?.blocked_dependencies) {
      return this.normalizeIds(task.metadata.blocked_dependencies);
    }

    return [];
  }

  private normalizeIds(value: unknown): string[] {
    if (!value) {
      return [];
    }

    if (Array.isArray(value)) {
      return value
        .filter((entry) => entry !== null && entry !== undefined)
        .map((entry) => String(entry).trim())
        .filter((entry) => entry.length > 0);
    }

    if (typeof value === "string") {
      return value
        .split(/[\s,]+/)
        .map((entry) => entry.trim())
        .filter((entry) => entry.length > 0);
    }

    if (typeof value === "number") {
      return [String(value)];
    }

    return [];
  }
}
