import {
  WorkflowStep,
  StepResult,
  ValidationResult,
} from "../engine/WorkflowStep.js";
import { WorkflowContext } from "../engine/WorkflowContext.js";
import { logger } from "../../logger.js";
import { ProjectAPI } from "../../dashboard/ProjectAPI.js";

const projectAPI = new ProjectAPI();

interface FetchProjectTasksConfig {
  project_id?: string;
  store_variable?: string;
  statuses?: string[];
  exclude_statuses?: string[];
  include_completed?: boolean;
  limit?: number;
}

export class FetchProjectTasksStep extends WorkflowStep {
  async execute(context: WorkflowContext): Promise<StepResult> {
    const config = (this.config.config || {}) as FetchProjectTasksConfig;

    const projectIdRaw =
      this.resolveVariable(config.project_id, context) ||
      context.getVariable("projectId") ||
      context.getVariable("project_id");

    if (!projectIdRaw) {
      const error = new Error(
        "FetchProjectTasksStep: project_id is required but not provided",
      );
      logger.error(error.message, {
        stepName: this.config.name,
        availableVariables: Object.keys(context.getAllVariables()),
      });
      return { status: "failure", error };
    }

    const projectId = String(projectIdRaw);

    try {
      logger.info("Fetching dashboard tasks for project", {
        stepName: this.config.name,
        projectId,
      });

      const tasks = await projectAPI.fetchProjectTasks(projectId);

      let filtered = Array.isArray(tasks) ? [...tasks] : [];

      if (Array.isArray(config.statuses) && config.statuses.length > 0) {
        const allowed = new Set(
          config.statuses.map((status) => status.toLowerCase()),
        );
        filtered = filtered.filter((task: any) =>
          allowed.has(String(task.status || "").toLowerCase()),
        );
      }

      if (
        Array.isArray(config.exclude_statuses) &&
        config.exclude_statuses.length > 0
      ) {
        const excluded = new Set(
          config.exclude_statuses.map((status) => status.toLowerCase()),
        );
        filtered = filtered.filter(
          (task: any) =>
            !excluded.has(String(task.status || "").toLowerCase()),
        );
      }

      if (config.include_completed === false) {
        filtered = filtered.filter((task: any) => {
          const status = String(task.status || "").toLowerCase();
          return status !== "done" && status !== "completed";
        });
      }

      if (typeof config.limit === "number" && config.limit > 0) {
        filtered = filtered.slice(0, config.limit);
      }

      const storeVariable =
        this.sanitizeVariableName(
          this.resolveVariable(config.store_variable, context) ||
            "existing_tasks",
        ) || "existing_tasks";

      context.setVariable(storeVariable, filtered);

      logger.info("Dashboard tasks fetched", {
        stepName: this.config.name,
        projectId,
        count: filtered.length,
        storeVariable,
      });

      return {
        status: "success",
        data: {
          tasks: filtered,
          count: filtered.length,
          projectId,
          storeVariable,
        },
        outputs: {
          tasks: filtered,
          count: filtered.length,
          projectId,
          storeVariable,
        },
      } satisfies StepResult;
    } catch (error: any) {
      logger.error("Failed to fetch dashboard tasks", {
        stepName: this.config.name,
        projectId,
        error: error?.message || String(error),
      });

      return {
        status: "failure",
        error: error instanceof Error ? error : new Error(String(error)),
      } satisfies StepResult;
    }
  }

  protected async validateConfig(
    _context: WorkflowContext,
  ): Promise<ValidationResult> {
    return { valid: true, errors: [], warnings: [] };
  }

  private resolveVariable(
    value: string | undefined,
    context: WorkflowContext,
  ): string | undefined {
    if (!value) return undefined;
    if (value.startsWith("${") && value.endsWith("}")) {
      const variableName = value.slice(2, -1).trim();
      const resolved = context.getVariable(variableName);
      return resolved !== undefined && resolved !== null
        ? String(resolved)
        : undefined;
    }
    return value;
  }

  private sanitizeVariableName(name: string): string {
    return name.replace(/[^a-zA-Z0-9_]/g, "_");
  }
}
