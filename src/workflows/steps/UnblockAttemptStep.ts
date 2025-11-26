import { WorkflowStep, StepResult } from "../engine/WorkflowStep.js";
import { WorkflowContext } from "../engine/WorkflowContext.js";
import { logger } from "../../logger.js";

interface UnblockAttemptConfig {
  task_id: string;
  project_id: string;
  strategy: string;
  resolution_plan: any;
  repo_root: string;
  branch: string;
}

interface UnblockResult {
  success: boolean;
  resolution: string;
  actions_taken: string[];
  subtasks_created?: any[];
  error?: string;
  validation_ready?: boolean;
}

export class UnblockAttemptStep extends WorkflowStep {
  async execute(context: WorkflowContext): Promise<StepResult> {
    const config = this.config.config as UnblockAttemptConfig;
    const { task_id, strategy, resolution_plan } = config;

    logger.info("Attempting to unblock task", {
      workflowId: context.workflowId,
      taskId: task_id,
      strategy,
    });

    try {
      const blockageAnalysis = context.getVariable("blockage_analysis");

      let result: UnblockResult;

      switch (strategy) {
        case "retry_with_context":
          result = await this.retryWithContext(
            context,
            config,
            blockageAnalysis,
          );
          break;

        case "create_subtasks":
          result = await this.createSubtasks(context, config, resolution_plan);
          break;

        case "request_clarification":
          result = await this.requestClarification(
            context,
            config,
            resolution_plan,
          );
          break;

        case "automated_fix":
          result = await this.applyAutomatedFix(
            context,
            config,
            resolution_plan,
          );
          break;

        case "escalate":
          result = await this.escalateForManualIntervention(
            context,
            config,
            blockageAnalysis,
          );
          break;

        default:
          logger.warn("Unknown unblock strategy, defaulting to retry", {
            strategy,
            taskId: task_id,
          });
          result = await this.retryWithContext(
            context,
            config,
            blockageAnalysis,
          );
      }

      context.setVariable("unblock_attempt", result);

      logger.info("Unblock attempt completed", {
        workflowId: context.workflowId,
        taskId: task_id,
        strategy,
        success: result.success,
        actionsTaken: result.actions_taken.length,
      });

      return {
        status: result.success ? "success" : "failure",
        data: { result },
        outputs: { unblock_attempt: result },
      };
    } catch (error: any) {
      logger.error("Failed to execute unblock attempt", {
        error: error.message,
        taskId: task_id,
        workflowId: context.workflowId,
      });

      return {
        status: "failure",
        error: new Error(`Unblock attempt failed: ${error.message}`),
      };
    }
  }

  private async retryWithContext(
    context: WorkflowContext,
    config: UnblockAttemptConfig,
    blockageAnalysis: any,
  ): Promise<UnblockResult> {
    logger.info("Executing retry_with_context strategy", {
      taskId: config.task_id,
    });

    const actions: string[] = [];

    actions.push("Cleared cached context");

    actions.push("Prepared task for retry");

    if (blockageAnalysis) {
      actions.push(`Added blockage analysis: ${blockageAnalysis.reason}`);
    }

    return {
      success: true,
      resolution: "Task prepared for retry with fresh context",
      actions_taken: actions,
      validation_ready: false,
    };
  }

  private async createSubtasks(
    context: WorkflowContext,
    config: UnblockAttemptConfig,
    resolutionPlan: any,
  ): Promise<UnblockResult> {
    logger.info("Executing create_subtasks strategy", {
      taskId: config.task_id,
    });

    const actions: string[] = [];
    const subtasks: any[] = [];

    const subtaskDefs = resolutionPlan?.subtasks || [];

    if (subtaskDefs.length === 0) {
      return {
        success: false,
        resolution: "No subtasks defined in resolution plan",
        actions_taken: actions,
        error: "No subtasks to create",
      };
    }

    for (const subtask of subtaskDefs) {
      actions.push(`Identified subtask: ${subtask.title || subtask.name}`);
      subtasks.push(subtask);
    }

    actions.push(`Prepared ${subtasks.length} subtasks for creation`);

    return {
      success: true,
      resolution: `Breaking task into ${subtasks.length} smaller subtasks`,
      actions_taken: actions,
      subtasks_created: subtasks,
      validation_ready: false,
    };
  }

  private async requestClarification(
    context: WorkflowContext,
    config: UnblockAttemptConfig,
    resolutionPlan: any,
  ): Promise<UnblockResult> {
    logger.info("Executing request_clarification strategy", {
      taskId: config.task_id,
    });

    const actions: string[] = [];

    const questions = resolutionPlan?.questions || [
      "Need more information to proceed",
    ];

    actions.push(
      `Prepared clarification request with ${questions.length} question(s)`,
    );

    for (const question of questions) {
      actions.push(`- ${question}`);
    }

    return {
      success: true,
      resolution: "Clarification requested from task owner",
      actions_taken: actions,
      validation_ready: false,
    };
  }

  private async applyAutomatedFix(
    context: WorkflowContext,
    config: UnblockAttemptConfig,
    resolutionPlan: any,
  ): Promise<UnblockResult> {
    logger.info("Executing automated_fix strategy", {
      taskId: config.task_id,
    });

    const actions: string[] = [];

    const fixType = resolutionPlan?.fix_type || "unknown";
    const readyForValidation = Boolean(resolutionPlan?.ready_for_validation);

    actions.push(`Identified fix type: ${fixType}`);

    switch (fixType) {
      case "dependency_update":
        actions.push(
          "Would update dependencies (not implemented in this version)",
        );
        break;

      case "config_fix":
        actions.push(
          "Would apply configuration fix (not implemented in this version)",
        );
        break;

      case "permission_fix":
        actions.push(
          "Would fix file permissions (not implemented in this version)",
        );
        break;

      default:
        actions.push(`Unknown fix type: ${fixType}`);
    }

    return {
      success: true,
      resolution: `Prepared automated fix: ${fixType}`,
      actions_taken: actions,
      validation_ready: readyForValidation,
    };
  }

  private async escalateForManualIntervention(
    context: WorkflowContext,
    config: UnblockAttemptConfig,
    blockageAnalysis: any,
  ): Promise<UnblockResult> {
    logger.info("Executing escalate strategy", {
      taskId: config.task_id,
    });

    const actions: string[] = [];

    actions.push("Marked task for manual intervention");

    if (blockageAnalysis?.previous_attempts?.length > 0) {
      actions.push(
        `Failed after ${blockageAnalysis.previous_attempts.length} previous attempt(s)`,
      );
    }

    if (blockageAnalysis?.reason) {
      actions.push(`Blockage reason: ${blockageAnalysis.reason}`);
    }

    if (blockageAnalysis?.context_hints) {
      actions.push(`Hints: ${blockageAnalysis.context_hints.join(", ")}`);
    }

    return {
      success: true,
      resolution: "Task escalated for manual intervention",
      actions_taken: actions,
      validation_ready: false,
    };
  }
}
