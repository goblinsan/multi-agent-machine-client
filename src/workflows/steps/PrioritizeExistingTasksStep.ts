import {
  WorkflowStep,
  type StepResult,
  type ValidationResult,
} from "../engine/WorkflowStep.js";
import { WorkflowContext } from "../engine/WorkflowContext.js";
import {
  createDashboardClient,
  type TaskUpdateInput,
} from "../../services/DashboardClient.js";
import { logger } from "../../logger.js";

interface PrioritizeExistingTasksConfig {
  project_id?: string | number;
  task_ids?: Array<string | number> | string | number;
  priority_score?: number;
  status?: TaskUpdateInput["status"];
  ensure_labels?: string[];
}

interface PrioritizeResult {
  updatedTaskIds: string[];
  skippedTaskIds: string[];
}

export class PrioritizeExistingTasksStep extends WorkflowStep {
  async execute(context: WorkflowContext): Promise<StepResult> {
    const config = this.config.config as PrioritizeExistingTasksConfig;
    const projectId = this.resolveProjectId(config, context);

    if (projectId === null) {
      return {
        status: "failure",
        error: new Error(
          "PrioritizeExistingTasksStep requires project_id or projectId in context",
        ),
      } satisfies StepResult;
    }

    const taskIds = this.normalizeTaskIds(
      config.task_ids ?? context.getVariable("duplicate_task_ids"),
    );

    if (taskIds.length === 0) {
      logger.info("PrioritizeExistingTasksStep: no task ids provided, skipping", {
        workflowId: context.workflowId,
        stepName: this.config.name,
      });
      return this.successResult([], []);
    }

    const ensureLabels = this.normalizeLabels(config.ensure_labels);
    const baseUpdates: TaskUpdateInput = {};

    if (typeof config.priority_score === "number") {
      baseUpdates.priority_score = config.priority_score;
    }

    if (config.status) {
      baseUpdates.status = config.status;
    }

    if (
      baseUpdates.priority_score === undefined &&
      !baseUpdates.status &&
      ensureLabels.length === 0
    ) {
      logger.warn(
        "PrioritizeExistingTasksStep configured without priority, status, or labels",
        {
          workflowId: context.workflowId,
          stepName: this.config.name,
        },
      );
      return this.successResult([], []);
    }

    const dashboardClient = createDashboardClient();
    const projectIdNumber = Number(projectId);
    if (Number.isNaN(projectIdNumber)) {
      return {
        status: "failure",
        error: new Error("project_id must be numeric"),
      } satisfies StepResult;
    }

    const updatedTaskIds: string[] = [];
    const skippedTaskIds: string[] = [];

    for (const rawId of taskIds) {
      const taskId = Number(rawId);
      if (Number.isNaN(taskId)) {
        skippedTaskIds.push(String(rawId));
        continue;
      }

      try {
        const updatePayload: TaskUpdateInput = { ...baseUpdates };

        if (ensureLabels.length > 0) {
          const existingTask = await dashboardClient.getTask(
            projectIdNumber,
            taskId,
          );
          const mergedLabels = new Set(existingTask?.labels || []);
          for (const label of ensureLabels) {
            mergedLabels.add(label);
          }
          updatePayload.labels = Array.from(mergedLabels);
        }

        if (Object.keys(updatePayload).length === 0) {
          skippedTaskIds.push(String(taskId));
          continue;
        }

        await dashboardClient.updateTask(
          projectIdNumber,
          taskId,
          updatePayload,
        );

        logger.info("Prioritized existing follow-up task", {
          workflowId: context.workflowId,
          stepName: this.config.name,
          taskId,
          updates: Object.keys(updatePayload),
        });

        updatedTaskIds.push(String(taskId));
      } catch (error: any) {
        logger.error("Failed to prioritize existing task", {
          workflowId: context.workflowId,
          stepName: this.config.name,
          taskId,
          error: error?.message || String(error),
        });
        return {
          status: "failure",
          error: new Error(
            `Failed to update existing task ${taskId}: ${error?.message || error}`,
          ),
        } satisfies StepResult;
      }
    }

    return this.successResult(updatedTaskIds, skippedTaskIds);
  }

  protected async validateConfig(
    _context: WorkflowContext,
  ): Promise<ValidationResult> {
    const config = this.config.config as PrioritizeExistingTasksConfig;
    const errors: string[] = [];

    if (
      config.project_id !== undefined &&
      typeof config.project_id !== "string" &&
      typeof config.project_id !== "number"
    ) {
      errors.push("project_id must be a string or number when provided");
    }

    if (
      config.task_ids !== undefined &&
      !Array.isArray(config.task_ids) &&
      typeof config.task_ids !== "string" &&
      typeof config.task_ids !== "number"
    ) {
      errors.push("task_ids must be an array, string, or number when provided");
    }

    if (
      config.priority_score !== undefined &&
      typeof config.priority_score !== "number"
    ) {
      errors.push("priority_score must be a number when provided");
    }

    if (
      config.ensure_labels !== undefined &&
      !Array.isArray(config.ensure_labels)
    ) {
      errors.push("ensure_labels must be an array when provided");
    }

    return {
      valid: errors.length === 0,
      errors,
      warnings: [],
    } satisfies ValidationResult;
  }

  private resolveProjectId(
    config: PrioritizeExistingTasksConfig,
    context: WorkflowContext,
  ): string | number | null {
    const fromConfig = config.project_id;
    if (fromConfig !== undefined) {
      return fromConfig;
    }

    return (
      context.getVariable("project_id") ??
      context.getVariable("projectId") ??
      null
    );
  }

  private normalizeTaskIds(value: unknown): Array<string | number> {
    if (value === null || value === undefined) {
      return [];
    }

    if (Array.isArray(value)) {
      return value.filter((entry) => entry !== undefined && entry !== null);
    }

    if (typeof value === "string") {
      return value
        .split(/[\s,]+/)
        .map((entry) => entry.trim())
        .filter((entry) => entry.length > 0);
    }

    if (typeof value === "number") {
      return [value];
    }

    return [];
  }

  private normalizeLabels(labels?: string[]): string[] {
    if (!labels || labels.length === 0) {
      return [];
    }

    return labels
      .map((label) => label?.trim())
      .filter((label): label is string => Boolean(label && label.length > 0));
  }

  private successResult(
    updatedTaskIds: string[],
    skippedTaskIds: string[],
  ): StepResult {
    const result: PrioritizeResult = {
      updatedTaskIds,
      skippedTaskIds,
    };

    return {
      status: "success",
      data: result,
      outputs: {
        updated_task_ids: updatedTaskIds,
        skipped_task_ids: skippedTaskIds,
        updated_count: updatedTaskIds.length,
      },
    } satisfies StepResult;
  }
}
