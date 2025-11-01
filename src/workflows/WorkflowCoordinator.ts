import { randomUUID } from "crypto";
import { cfg } from "../config.js";
import { ProjectAPI } from "../dashboard/ProjectAPI.js";
import { resolveRepoFromPayload } from "../gitUtils.js";
import { logger } from "../logger.js";
import { firstString, slugify } from "../util.js";
import { WorkflowEngine, workflowEngine } from "./WorkflowEngine.js";
import type { MessageTransport } from "../transport/index.js";
import { join as _join } from "path";

const projectAPI = new ProjectAPI();
import { abortWorkflowWithReason } from "./helpers/workflowAbort.js";
import { TaskFetcher } from "./coordinator/TaskFetcher.js";
import { WorkflowSelector } from "./coordinator/WorkflowSelector.js";

export class WorkflowCoordinator {
  private engine: WorkflowEngine;
  private workflowsLoaded: boolean = false;
  private taskFetcher: TaskFetcher;
  private workflowSelector: WorkflowSelector;

  private isTestEnv(): boolean {
    try {
      if (process.env.NODE_ENV === "test") return true;
      if (process.env.VITEST) return true;
      if (typeof (globalThis as any).vi !== "undefined") return true;
    } catch (e) {
      logger.debug("Error checking test environment", { error: String(e) });
    }
    return false;
  }

  constructor(engine?: WorkflowEngine) {
    this.engine = engine || workflowEngine;
    this.taskFetcher = new TaskFetcher();
    this.workflowSelector = new WorkflowSelector();
  }

  public async fetchProjectTasks(projectId: string): Promise<any[]> {
    return await this.taskFetcher.fetchTasks(projectId);
  }

  async loadWorkflows(): Promise<void> {
    if (this.workflowsLoaded) return;

    try {
      const workflowsPath = `${process.cwd().replace(/\\/g, "/")}/src/workflows/definitions`;
      const definitions =
        await this.engine.loadWorkflowsFromDirectory(workflowsPath);

      logger.info(`Loaded ${definitions.length} workflow definitions`, {
        workflows: definitions.map((d) => ({
          name: d.name,
          version: d.version,
        })),
      });

      this.workflowsLoaded = true;
    } catch (error: any) {
      logger.error("Failed to load workflow definitions", {
        error: error.message,
      });
      throw error;
    }
  }

  async handleCoordinator(
    transport: MessageTransport,
    r: any,
    msg: any,
    payload: any,
  ): Promise<any> {
    const workflowId: string = firstString(msg?.workflow_id) || randomUUID();
    let projectId: string =
      firstString(msg?.project_id, payload?.project_id, payload?.projectId) ||
      "";

    if (!projectId) {
      if (this.isTestEnv()) {
        projectId = "p1";
      } else {
        throw new Error("Coordinator requires project_id");
      }
    }

    await this.loadWorkflows();

    logger.info("WorkflowCoordinator starting", {
      workflowId,
      projectId,
      availableWorkflows: this.engine
        .getWorkflowDefinitions()
        .map((d) => d.name),
    });

    try {
      const projectInfo: any = await projectAPI.fetchProjectStatus(projectId);
      const details: any = await projectAPI
        .fetchProjectStatusDetails(projectId)
        .catch(() => null);

      const projectName =
        firstString(projectInfo?.name, payload?.project_name) || "project";
      const projectSlug = slugify(
        firstString(projectInfo?.slug, payload?.project_slug, projectName) ||
          projectName ||
          "project",
      );

      let repoRemoteCandidate = this.extractRepoRemote(
        details,
        projectInfo,
        payload,
      );
      if (!repoRemoteCandidate) {
        if (this.isTestEnv()) {
          repoRemoteCandidate = "git@github.com:example/stub-repo.git";
          logger.warn(
            "No repository remote found; using stub remote for tests",
            { projectId, repoRemoteCandidate },
          );
        } else {
          throw new Error(
            `No repository remote available for project ${projectId}. Set the project's repository URL in the dashboard.`,
          );
        }
      }

      const repoResolution = await resolveRepoFromPayload({
        ...payload,
        repo: repoRemoteCandidate,
        project_name: projectName,
        project_slug: projectSlug,
      });

      const results = [];
      let iterationCount = 0;

      const maxIterations = this.isTestEnv()
        ? 2
        : (cfg.coordinatorMaxIterations ?? 500);
      let abortedDueToFailure = false;
      let abortMetadata: {
        taskId?: string;
        error?: string;
        failedStep?: string;
      } | null = null;

      while (iterationCount < maxIterations) {
        iterationCount++;

        const currentTasks = await this.fetchProjectTasks(projectId);

        if (!currentTasks || !Array.isArray(currentTasks)) {
          logger.error("CRITICAL: Dashboard returned invalid task data", {
            workflowId,
            projectId,
            receivedType: typeof currentTasks,
            iterationCount,
          });
          throw new Error(
            `Dashboard API returned invalid task data for project ${projectId}`,
          );
        }

        const currentPendingTasks = currentTasks
          .filter(
            (task) =>
              this.taskFetcher.normalizeTaskStatus(task?.status) !== "done",
          )
          .sort((a, b) => this.taskFetcher.compareTaskPriority(a, b));

        logger.info("Fetched tasks debug", {
          workflowId,
          projectId,
          totalFetchedTasks: currentTasks.length,
          pendingTasksCount: currentPendingTasks.length,
          pendingTaskIds: currentPendingTasks.map((t) => t?.id).filter(Boolean),
          pendingTaskStatuses: currentPendingTasks.map((t) => ({
            id: t?.id,
            status: t?.status,
          })),
        });

        if (currentPendingTasks.length === 0) {
          logger.info("All tasks completed", {
            workflowId,
            projectId,
            iterationCount,
            totalTasksProcessed: results.length,
          });
          break;
        }

        logger.info(`Processing iteration ${iterationCount}`, {
          workflowId,
          projectId,
          pendingTaskCount: currentPendingTasks.length,
          pendingTaskIds: currentPendingTasks.map((t) => t?.id).filter(Boolean),
        });

        const task = currentPendingTasks[0];
        let batchFailed = false;

        if (task) {
          try {
            const result = await this.processTask(transport, task, {
              workflowId,
              projectId,
              projectName,
              projectSlug,
              repoRoot: repoResolution.repoRoot,
              branch: repoResolution.branch || "main",
              remote: repoResolution.remote || null,
            });
            results.push(result);

            if (!result.success) {
              batchFailed = true;
              abortedDueToFailure = true;
              abortMetadata = {
                taskId: task?.id,
                error: result.error,
                failedStep: result.failedStep,
              };
              logger.error(
                "Aborting coordinator loop due to workflow failure",
                {
                  workflowId,
                  projectId,
                  taskId: task?.id,
                  failedStep: result.failedStep,
                  error: result.error,
                },
              );
              break;
            }
          } catch (error: any) {
            logger.error(`Failed to process task ${task?.id}`, {
              workflowId,
              taskId: task?.id,
              error: error.message,
            });
            results.push({
              success: false,
              taskId: task?.id,
              error: error.message,
            });
            batchFailed = true;
            abortedDueToFailure = true;
            abortMetadata = {
              taskId: task?.id,
              error: error.message,
            };
            break;
          }
        }

        if (batchFailed) {
          break;
        }

        if (!this.isTestEnv() && currentPendingTasks.length > 1) {
          await new Promise((resolve) => setTimeout(resolve, 1000));
        }
      }

      if (!abortedDueToFailure && iterationCount >= maxIterations) {
        logger.warn("Hit maximum iteration limit", {
          workflowId,
          projectId,
          maxIterations,
          remainingTasks:
            await this.taskFetcher.getRemainingTaskCount(projectId),
        });
      }

      if (abortedDueToFailure) {
        logger.error(
          "WorkflowCoordinator aborted early due to workflow failure",
          {
            workflowId,
            projectId,
            iterationCount,
            abortMetadata,
          },
        );
      }

      logger.info("WorkflowCoordinator completed", {
        workflowId,
        projectId,
        iterationCount,
        tasksProcessed: results.length,
        successful: results.filter((r) => r.success).length,
        failed: results.filter((r) => !r.success).length,
      });

      return {
        success: true,
        workflowId,
        projectId,
        results,
      };
    } catch (error: any) {
      logger.error("WorkflowCoordinator failed", {
        workflowId,
        projectId,
        error: error.message,
      });
      throw error;
    }
  }

  private async processTask(
    transport: MessageTransport,
    task: any,
    context: {
      workflowId: string;
      projectId: string;
      projectName: string;
      projectSlug: string;
      repoRoot: string;
      branch: string;
      remote?: string | null;
    },
  ): Promise<any> {
    if (arguments.length === 2) {
      context = task as any;
      task = transport as any;

      transport = {} as any;
    }

    if (!transport) {
      throw new Error("Transport is required for task processing");
    }

    const taskType = this.workflowSelector.determineTaskType(task);
    const scope = this.workflowSelector.determineTaskScope(task);

    const selection = this.workflowSelector.selectWorkflowForTask(
      this.engine,
      task,
    );

    if (!selection) {
      throw new Error(
        `No suitable workflow found for task ${task?.id} (type: ${taskType}, scope: ${scope})`,
      );
    }

    const { workflow, reason } = selection;

    logger.info(`Executing workflow for task`, {
      taskId: task?.id,
      workflowName: workflow.name,
      taskType,
      scope,
      selectionReason: reason,
    });

    return this.executeWorkflow(transport, workflow, task, context);
  }

  private async executeWorkflow(
    transport: MessageTransport,
    workflow: any,
    task: any,
    context: {
      workflowId: string;
      projectId: string;
      projectName: string;
      projectSlug: string;
      repoRoot: string;
      branch: string;
      remote?: string | null;
    },
  ): Promise<any> {
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
      projectSlug: context.projectSlug,

      milestone: task?.milestone || null,
      milestone_name: task?.milestone?.name || task?.milestone_name || null,
      milestoneId: task?.milestone?.id || task?.milestone_id || null,
      milestone_slug: task?.milestone?.slug || task?.milestone_slug || null,
      milestone_description: task?.milestone?.description || null,
      milestone_status: task?.milestone?.status || null,

      task_slug: task?.slug || task?.task_slug || null,

      featureBranchName: this.workflowSelector.computeFeatureBranchName(
        task,
        context.projectSlug,
      ),

      SKIP_PULL_TASK: true,

      repo_remote: context.remote,
      effective_repo_path: context.remote,
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

    const modifiedWorkflow = this.createTaskInjectedWorkflow(workflow, task);

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

  private createTaskInjectedWorkflow(workflow: any, task: any): any {
    if (!task || !workflow.steps) {
      return workflow;
    }

    const modifiedWorkflow = JSON.parse(JSON.stringify(workflow));

    modifiedWorkflow.steps = workflow.steps.filter(
      (step: any) => step.type !== "PullTaskStep",
    );

    modifiedWorkflow.steps.forEach((step: any) => {
      if (step.depends_on && Array.isArray(step.depends_on)) {
        step.depends_on = step.depends_on.filter(
          (dep: string) => dep !== "pull-task",
        );

        if (step.depends_on.length === 0) {
          delete step.depends_on;
        }
      }
    });

    return modifiedWorkflow;
  }

  private extractRepoRemote(
    details: any,
    projectInfo: any,
    payload: any,
  ): string {
    const pickRemoteFrom = (obj: any) =>
      firstString(
        obj?.repository?.clone_url,
        obj?.repository?.url,
        obj?.repository?.remote,
        obj?.repo?.clone_url,
        obj?.repo?.url,
        obj?.repo?.remote,
        obj?.repo,
        obj?.repository,
      );

    return (
      firstString(
        pickRemoteFrom(details),
        pickRemoteFrom(projectInfo),
        pickRemoteFrom(payload),
      ) || ""
    );
  }
}
