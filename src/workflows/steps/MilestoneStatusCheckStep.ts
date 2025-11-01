import {
  WorkflowStep,
  StepResult,
  ValidationResult,
} from "../engine/WorkflowStep.js";
import { WorkflowContext } from "../engine/WorkflowContext.js";
import { ProjectAPI } from "../../dashboard/ProjectAPI.js";
import { logger } from "../../logger.js";

const projectAPI = new ProjectAPI();

export interface MilestoneStatusCheckConfig {
  check_type?: "incomplete_tasks" | "all_tasks" | "milestone_complete";
  include_cancelled?: boolean;
}

export class MilestoneStatusCheckStep extends WorkflowStep {
  async execute(context: WorkflowContext): Promise<StepResult> {
    const config = (this.config.config as MilestoneStatusCheckConfig) || {};
    const checkType = config.check_type || "incomplete_tasks";
    const includeCancelled = config.include_cancelled ?? false;

    const milestone = context.getVariable("milestone");
    const projectId = context.getVariable("projectId");

    logger.info("Checking milestone status", {
      workflowId: context.workflowId,
      milestoneId: milestone?.id,
      milestoneName: milestone?.name,
      projectId,
      checkType,
    });

    if (!milestone?.id) {
      logger.debug("No milestone found, skipping status check");
      return {
        status: "success",
        data: {
          has_remaining_tasks: false,
          remaining_tasks: [],
          total_tasks: 0,
          completion_percentage: 100,
        },
        outputs: {
          has_remaining_tasks: false,
          remaining_tasks: [],
          total_tasks: 0,
          completion_percentage: 100,
        },
      };
    }

    try {
      const projectStatus = (await projectAPI.fetchProjectStatusDetails(
        projectId,
      )) as any;

      const milestoneTasks = (projectStatus.tasks || []).filter(
        (t: any) =>
          t.milestone_id === milestone.id || t.milestoneId === milestone.id,
      );

      logger.debug("Milestone tasks found", {
        milestoneId: milestone.id,
        totalTasks: milestoneTasks.length,
      });

      const completeStatuses = [
        "done",
        "completed",
        "closed",
        "shipped",
        "delivered",
      ];
      if (!includeCancelled) {
        completeStatuses.push("cancelled", "canceled", "archived");
      }

      const incompleteTasks = milestoneTasks.filter((t: any) => {
        const status = (t.status || "").toLowerCase();
        const normalizedStatus = (
          t.normalized_status ||
          t.normalizedStatus ||
          ""
        ).toLowerCase();
        return (
          !completeStatuses.includes(status) &&
          !completeStatuses.includes(normalizedStatus)
        );
      });

      const completedTasks = milestoneTasks.length - incompleteTasks.length;
      const completionPercentage =
        milestoneTasks.length > 0
          ? Math.round((completedTasks / milestoneTasks.length) * 100)
          : 100;

      logger.info("Milestone status check results", {
        workflowId: context.workflowId,
        milestoneId: milestone.id,
        milestoneName: milestone.name,
        totalTasks: milestoneTasks.length,
        completedTasks,
        incompleteTasks: incompleteTasks.length,
        completionPercentage,
        hasRemainingTasks: incompleteTasks.length > 0,
      });

      const result = {
        has_remaining_tasks: incompleteTasks.length > 0,
        remaining_tasks: incompleteTasks,
        total_tasks: milestoneTasks.length,
        completed_tasks: completedTasks,
        completion_percentage: completionPercentage,
        milestone_complete:
          incompleteTasks.length === 0 && milestoneTasks.length > 0,
      };

      context.setVariable(
        "milestone_has_remaining_tasks",
        result.has_remaining_tasks,
      );
      context.setVariable(
        "milestone_completion_percentage",
        result.completion_percentage,
      );
      context.setVariable("milestone_complete", result.milestone_complete);

      return {
        status: "success",
        data: result,
        outputs: result,
      };
    } catch (error) {
      const errorMessage =
        error instanceof Error ? error.message : "Unknown error";
      logger.error("Failed to check milestone status", {
        workflowId: context.workflowId,
        milestoneId: milestone?.id,
        error: errorMessage,
      });

      return {
        status: "failure",
        error: new Error(`Failed to check milestone status: ${errorMessage}`),
        data: {
          has_remaining_tasks: true,
          remaining_tasks: [],
          total_tasks: 0,
          completion_percentage: 0,
        },
      };
    }
  }

  protected async validateConfig(
    _context: WorkflowContext,
  ): Promise<ValidationResult> {
    const config = (this.config.config as MilestoneStatusCheckConfig) || {};
    const errors: string[] = [];

    if (config.check_type) {
      const validTypes = [
        "incomplete_tasks",
        "all_tasks",
        "milestone_complete",
      ];
      if (!validTypes.includes(config.check_type)) {
        errors.push(
          `Invalid check_type: ${config.check_type}. Must be one of: ${validTypes.join(", ")}`,
        );
      }
    }

    return {
      valid: errors.length === 0,
      errors,
      warnings: [],
    };
  }

  async cleanup(_context: WorkflowContext): Promise<void> {
    logger.debug("Milestone status check cleanup completed", {
      stepName: this.config.name,
    });
  }
}
