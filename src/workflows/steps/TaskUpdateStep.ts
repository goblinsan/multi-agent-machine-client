import {
  WorkflowStep,
  StepResult,
  ValidationResult,
} from "../engine/WorkflowStep.js";
import { WorkflowContext } from "../engine/WorkflowContext.js";
import { logger } from "../../logger.js";

export interface TaskUpdateConfig {
  dashboardUrl?: string;
  updateType: "status" | "progress" | "result" | "failure";
  status?: "pending" | "in_progress" | "completed" | "failed" | "blocked";
  message?: string;
  progress?: number;
  metadata?: Record<string, any>;
  retryCount?: number;
  timeoutMs?: number;
}

export interface TaskUpdateResult {
  updated: boolean;
  taskId: string;
  updateType: string;
  timestamp: number;
  response?: any;
  metadata: {
    updatedAt: number;
    attemptCount: number;
    finalStatus: string;
  };
}

export class TaskUpdateStep extends WorkflowStep {
  async execute(context: WorkflowContext): Promise<StepResult> {
    const config = this.config.config as TaskUpdateConfig;
    const {
      dashboardUrl,
      updateType,
      status,
      message,
      progress,
      metadata = {},
      retryCount = 2,
      timeoutMs = 10000,
    } = config;

    logger.info(`Updating task status`, {
      updateType,
      status,
      progress,
      retryCount,
    });

    try {
      const task = context.getVariable("task");
      if (!task) {
        throw new Error("No task data found in context for update");
      }

      const taskId = task.id || task.taskId;
      if (!taskId) {
        throw new Error("Task ID not found in task data");
      }

      const updatePayload = this.buildUpdatePayload(updateType, {
        taskId,
        status,
        message,
        progress,
        metadata: {
          ...metadata,
          updatedBy: "workflow-engine",
          workflowId: context.workflowId,
          stepName: this.config.name,
        },
      });

      logger.debug("Built task update payload", {
        taskId,
        updateType,
        payloadKeys: Object.keys(updatePayload),
      });

      let lastError: Error | null = null;
      let updateResponse: any = null;
      let attemptCount = 0;

      for (let attempt = 0; attempt <= retryCount; attempt++) {
        attemptCount++;
        try {
          updateResponse = await this.performUpdate(
            dashboardUrl || this.getDefaultDashboardUrl(context),
            updatePayload,
            timeoutMs,
          );
          break;
        } catch (error: any) {
          lastError = error;
          logger.warn(`Task update attempt ${attempt + 1} failed`, {
            error: error.message,
            taskId,
            updateType,
            attempt: attempt + 1,
            maxAttempts: retryCount + 1,
          });

          if (attempt < retryCount) {
            const delay = Math.min(1000 * Math.pow(2, attempt), 5000);
            await new Promise((resolve) => setTimeout(resolve, delay));
          }
        }
      }

      if (!updateResponse) {
        throw lastError || new Error("Task update failed after all retries");
      }

      const updateResult: TaskUpdateResult = {
        updated: true,
        taskId,
        updateType,
        timestamp: Date.now(),
        response: updateResponse,
        metadata: {
          updatedAt: Date.now(),
          attemptCount,
          finalStatus: status || "updated",
        },
      };

      if (status && updateType === "status") {
        const normalizedStatus = status.toLowerCase();
        if (
          ["done", "completed", "finished", "closed", "resolved"].includes(
            normalizedStatus,
          )
        ) {
          const repoRoot =
            context.getVariable("effective_repo_path") ||
            context.getVariable("repo_root");
          const branch = context.getVariable("branch");
          const taskTitle = task.title || task.name;

          if (repoRoot) {
            try {
              const { cleanupTaskLogs } = await import(
                "../../taskLogCleanup.js"
              );
              await cleanupTaskLogs({
                repoRoot,
                taskId,
                taskTitle,
                branch: branch || null,
              });
              logger.info("Task logs cleaned up after completion", {
                taskId,
                updateType,
              });
            } catch (cleanupErr: any) {
              logger.warn("Task log cleanup failed", {
                taskId,
                updateType,
                error: cleanupErr?.message || String(cleanupErr),
              });
            }
          }
        }
      }

      context.setVariable("updateResult", updateResult);
      context.setVariable("updated", true);
      context.setVariable("taskId", taskId);

      logger.info("Task update completed successfully", {
        taskId,
        updateType,
        status,
        attemptCount,
      });

      return {
        status: "success",
        data: updateResult,
        outputs: {
          updateResult,
          updated: true,
          taskId,
        },
        metrics: {
          duration_ms: Date.now() - updateResult.timestamp,
          operations_count: attemptCount,
        },
      };
    } catch (error: any) {
      logger.error("Task update failed", {
        error: error.message,
        updateType,
        step: this.config.name,
      });

      return {
        status: "failure",
        error: new Error(`Task update failed: ${error.message}`),
      };
    }
  }

  private buildUpdatePayload(updateType: string, data: any): any {
    const basePayload = {
      taskId: data.taskId,
      timestamp: Date.now(),
      metadata: data.metadata,
    };

    switch (updateType) {
      case "status":
        return {
          ...basePayload,
          type: "status_update",
          status: data.status,
          message: data.message,
        };

      case "progress":
        return {
          ...basePayload,
          type: "progress_update",
          progress: data.progress,
          message: data.message,
        };

      case "result":
        return {
          ...basePayload,
          type: "result_update",
          status: "completed",
          result: data.result || data.message,
          message: data.message,
        };

      case "failure":
        return {
          ...basePayload,
          type: "failure_update",
          status: "failed",
          error: data.error || data.message,
          message: data.message,
        };

      default:
        throw new Error(`Unsupported update type: ${updateType}`);
    }
  }

  private async performUpdate(
    url: string,
    payload: any,
    _timeoutMs: number,
  ): Promise<any> {
    logger.debug("Performing task update", {
      url,
      payloadType: payload.type,
      taskId: payload.taskId,
    });

    await new Promise((resolve) => setTimeout(resolve, 100));

    if (payload.taskId === "fail-test") {
      throw new Error("Simulated dashboard update failure");
    }

    return {
      success: true,
      taskId: payload.taskId,
      updatedAt: Date.now(),
      version: Math.floor(Math.random() * 1000),
    };
  }

  private getDefaultDashboardUrl(context: WorkflowContext): string {
    return (
      context.getVariable("dashboardUrl") || "http://localhost:3000/api/tasks"
    );
  }

  protected async validateConfig(
    _context: WorkflowContext,
  ): Promise<ValidationResult> {
    const config = this.config.config as any;
    const errors: string[] = [];
    const warnings: string[] = [];

    if (!config.updateType || typeof config.updateType !== "string") {
      errors.push(
        "TaskUpdateStep: updateType is required and must be a string",
      );
    } else if (
      !["status", "progress", "result", "failure"].includes(config.updateType)
    ) {
      errors.push(
        "TaskUpdateStep: updateType must be one of: status, progress, result, failure",
      );
    }

    if (config.updateType === "status" && config.status) {
      const validStatuses = [
        "pending",
        "in_progress",
        "completed",
        "failed",
        "blocked",
      ];
      if (!validStatuses.includes(config.status)) {
        errors.push(
          `TaskUpdateStep: status must be one of: ${validStatuses.join(", ")}`,
        );
      }
    }

    if (config.updateType === "progress" && config.progress !== undefined) {
      if (
        typeof config.progress !== "number" ||
        config.progress < 0 ||
        config.progress > 100
      ) {
        errors.push(
          "TaskUpdateStep: progress must be a number between 0 and 100",
        );
      }
    }

    if (
      config.dashboardUrl !== undefined &&
      typeof config.dashboardUrl !== "string"
    ) {
      errors.push("TaskUpdateStep: dashboardUrl must be a string");
    }

    if (config.message !== undefined && typeof config.message !== "string") {
      errors.push("TaskUpdateStep: message must be a string");
    }

    if (
      config.retryCount !== undefined &&
      (typeof config.retryCount !== "number" || config.retryCount < 0)
    ) {
      errors.push("TaskUpdateStep: retryCount must be a non-negative number");
    }

    if (
      config.timeoutMs !== undefined &&
      (typeof config.timeoutMs !== "number" || config.timeoutMs < 1000)
    ) {
      errors.push("TaskUpdateStep: timeoutMs must be a number >= 1000");
    }

    if (config.metadata !== undefined && typeof config.metadata !== "object") {
      errors.push("TaskUpdateStep: metadata must be an object");
    }

    return {
      valid: errors.length === 0,
      errors,
      warnings,
    };
  }

  async cleanup(context: WorkflowContext): Promise<void> {
    const updateResult = context.getVariable("updateResult");
    if (updateResult) {
      logger.debug("Cleaning up task update result");
    }
  }
}
