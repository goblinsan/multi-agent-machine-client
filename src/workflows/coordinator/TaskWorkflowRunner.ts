import type { MessageTransport } from "../../transport/index.js";
import { logger } from "../../logger.js";
import { WorkflowEngine } from "../WorkflowEngine.js";
import { WorkflowSelector } from "./WorkflowSelector.js";
import { createTaskInjectedWorkflow } from "../helpers/taskWorkflowAdapter.js";
import { abortWorkflowWithReason } from "../helpers/workflowAbort.js";

export interface TaskWorkflowContext {
  workflowId: string;
  projectId: string;
  projectName: string;
  repoSlug: string;
  repoRoot: string;
  branch: string;
  remote?: string | null;
  force_rescan?: boolean;
}

export class TaskWorkflowRunner {
  constructor(
    private readonly engine: WorkflowEngine,
    private readonly workflowSelector: WorkflowSelector,
  ) {}

  async executeWorkflow(
    transport: MessageTransport,
    workflow: any,
    task: any,
    context: TaskWorkflowContext,
  ): Promise<any> {
    if (!task || typeof task !== "object" || Array.isArray(task)) {
      logger.error("CRITICAL: Invalid task data received", {
        workflowId: context.workflowId,
        projectId: context.projectId,
        taskType: typeof task,
        isArray: Array.isArray(task),
        reason:
          "Task must be a valid object with id, title, and description fields",
      });
      throw new Error(
        `CRITICAL: Invalid task data - received ${typeof task}${Array.isArray(task) ? " (array)" : ""}. Cannot proceed with workflow execution.`,
      );
    }

    if (!task.id) {
      logger.error("CRITICAL: Task missing required 'id' field", {
        workflowId: context.workflowId,
        projectId: context.projectId,
        taskKeys: Object.keys(task),
        reason: "Task ID is required for workflow execution",
      });
      throw new Error(
        "CRITICAL: Task missing required 'id' field. Cannot proceed with workflow execution.",
      );
    }

    logger.debug("Preparing workflow initial variables", {
      workflowId: context.workflowId,
      taskId: task?.id,
      taskHasMilestone: !!task?.milestone,
      milestoneId: task?.milestone?.id,
      milestoneName: task?.milestone?.name,
      taskKeys: Object.keys(task || {}),
    });

    const initialVariables = {
      task: {
        id: task?.id || task?.key || "unknown",
        type: this.workflowSelector.determineTaskType(task),
        persona: "lead_engineer",
        data: {
          ...task,
          description:
            task?.description ||
            task?.summary ||
            task?.name ||
            "No description provided",
          requirements: task?.requirements || [],
        },
        timestamp: Date.now(),
      },
      taskId: task?.id || task?.key,
      taskName: task?.name || task?.title || task?.summary,
      taskType: this.workflowSelector.determineTaskType(task),
      taskScope: this.workflowSelector.determineTaskScope(task),
      projectId: context.projectId,
      projectName: context.projectName,
      repoSlug: context.repoSlug,
      milestone: task?.milestone || null,
      milestone_name: task?.milestone?.name || task?.milestone_name || null,
      milestoneId: task?.milestone?.id || task?.milestone_id || null,
      milestone_slug: task?.milestone?.slug || task?.milestone_slug || null,
      milestone_description: task?.milestone?.description || null,
      milestone_status: task?.milestone?.status || null,
      task_slug: task?.slug || task?.task_slug || null,
      featureBranchName: this.workflowSelector.computeFeatureBranchName(
        task,
        context.repoSlug,
      ),
      SKIP_PULL_TASK: true,
      repo_root: context.repoRoot,
      repo_remote: context.remote,
      effective_repo_path: context.repoRoot,
      force_rescan: context.force_rescan || false,
    };

    if (!context.remote) {
      logger.error(
        "No repository remote URL available for workflow execution",
        {
          workflowId: context.workflowId,
          taskId: task?.id,
          projectId: context.projectId,
        },
      );
      throw new Error(
        "Cannot execute workflow: no repository remote URL. Configure the repository URL in the project dashboard.",
      );
    }

    const modifiedWorkflow = createTaskInjectedWorkflow(workflow, task);

    const result = await this.engine.executeWorkflowDefinition(
      modifiedWorkflow,
      context.projectId,
      context.repoRoot,
      context.branch,
      transport,
      initialVariables,
    );

    if (!result.success) {
      logger.error("Workflow execution failed", {
        workflowId: context.workflowId,
        taskId: task?.id,
        failedStep: result.failedStep,
        error: result.error?.message,
      });

      if (result.finalContext) {
        await abortWorkflowWithReason(
          result.finalContext,
          "workflow_step_failure",
          {
            taskId: task?.id,
            failedStep: result.failedStep,
            error: result.error?.message,
            completedSteps: result.completedSteps,
          },
        );
      }
    }

    return {
      success: result.success,
      workflowName: workflow.name,
      taskId: task?.id,
      completedSteps: result.completedSteps?.length || 0,
      failedStep: result.failedStep,
      duration: result.duration,
      error: result.error?.message,
    };
  }
}
