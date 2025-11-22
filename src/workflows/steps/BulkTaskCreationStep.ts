import {
  WorkflowStep,
  StepResult,
  ValidationResult,
  WorkflowStepConfig,
} from "../engine/WorkflowStep.js";
import { WorkflowContext } from "../engine/WorkflowContext.js";
import { logger } from "../../logger.js";
import {
  DashboardClient,
  type TaskCreateInput,
} from "../../services/DashboardClient.js";
import { TaskPriority } from "./helpers/TaskPriorityCalculator.js";
import {
  type ExistingTask as DetectorExistingTask,
  type DuplicateMatchStrategy,
} from "./helpers/TaskDuplicateDetector.js";
import {
  type MilestoneStrategy,
  type ParentTaskMapping,
} from "./helpers/TaskRouter.js";
import { RetryHandler } from "./helpers/RetryHandler.js";
import {
  TaskEnricher,
  type EnrichmentConfig,
  type EnrichedTask,
} from "./helpers/TaskEnricher.js";
import { sleep } from "../../util/retry.js";

interface TaskToCreate {
  title: string;
  description?: string;
  priority?: TaskPriority;
  milestone_slug?: string;
  milestone_id?: number | string;
  parent_task_id?: string;
  external_id?: string;
  assignee_persona?: string;
  metadata?: Record<string, any>;
  is_duplicate?: boolean;
  duplicate_of_task_id?: string | null;
  skip_reason?: string;
}

type ExistingTask = DetectorExistingTask;

interface BulkTaskCreationConfig {
  project_id: string;
  tasks: TaskToCreate[];
  workflow_run_id?: string;
  priority_mapping?: Record<string, number>;
  milestone_strategy?: MilestoneStrategy;
  parent_task_mapping?: ParentTaskMapping;
  title_prefix?: string;
  retry?: {
    max_attempts?: number;
    initial_delay_ms?: number;
    backoff_multiplier?: number;
    retryable_errors?: string[];
  };
  options?: {
    create_milestone_if_missing?: boolean;
    upsert_by_external_id?: boolean;
    external_id_template?: string;
    check_duplicates?: boolean;
    existing_tasks?: ExistingTask[];
    duplicate_match_strategy?: DuplicateMatchStrategy;
    abort_on_partial_failure?: boolean;
  };
}

interface BulkCreationResult {
  tasks_created: number;
  urgent_tasks_created: number;
  deferred_tasks_created: number;
  task_ids: string[];
  duplicate_task_ids: string[];
  skipped_duplicates: number;
  errors: string[];
}

export class BulkTaskCreationStep extends WorkflowStep {
  private retryHandler: RetryHandler;
  private taskEnricher: TaskEnricher;

  constructor(config: WorkflowStepConfig) {
    super(config);
    this.retryHandler = new RetryHandler();
    this.taskEnricher = new TaskEnricher();
  }

  protected async validateConfig(
    _context: WorkflowContext,
  ): Promise<ValidationResult> {
    const errors: string[] = [];
    const warnings: string[] = [];
    const stepConfig = this.config.config as BulkTaskCreationConfig;

    if (!stepConfig.project_id) {
      errors.push("project_id is required");
    }

    if (!stepConfig.tasks) {
      errors.push("tasks array is required");
    } else if (!Array.isArray(stepConfig.tasks)) {
      errors.push("tasks must be an array");
    } else if (stepConfig.tasks.length === 0) {
      warnings.push("tasks array is empty - no tasks will be created");
    }

    return { valid: errors.length === 0, errors, warnings };
  }

  async execute(context: WorkflowContext): Promise<StepResult> {
    const stepConfig = this.config.config as BulkTaskCreationConfig;
    const startTime = Date.now();

    try {
      context.logger.info("Starting bulk task creation", {
        stepName: this.config.name,
        projectId: stepConfig.project_id,
        taskCount: stepConfig.tasks.length,
      });

      if (!stepConfig.tasks || stepConfig.tasks.length === 0) {
        return {
          status: "success",
          data: {
            tasks_created: 0,
            urgent_tasks_created: 0,
            deferred_tasks_created: 0,
            task_ids: [],
            duplicate_task_ids: [],
            skipped_duplicates: 0,
          },
          outputs: {
            tasks_created: 0,
            urgent_tasks_created: 0,
            deferred_tasks_created: 0,
            task_ids: [],
            duplicate_task_ids: [],
            skipped_duplicates: 0,
          },
          metrics: {
            duration_ms: Date.now() - startTime,
          },
        };
      }

      const enrichmentConfig: EnrichmentConfig = {
        priority_mapping: stepConfig.priority_mapping,
        milestone_strategy: stepConfig.milestone_strategy,
        parent_task_mapping: stepConfig.parent_task_mapping,
        title_prefix: stepConfig.title_prefix,
        check_duplicates: stepConfig.options?.check_duplicates,
        existing_tasks: stepConfig.options?.existing_tasks,
        duplicate_match_strategy: stepConfig.options?.duplicate_match_strategy,
        upsert_by_external_id: stepConfig.options?.upsert_by_external_id,
        external_id_template: stepConfig.options?.external_id_template,
        workflow_run_id: stepConfig.workflow_run_id,
        step_name: this.config.name,
      };

      const enrichedTasks = this.taskEnricher.enrichTasks(
        stepConfig.tasks,
        enrichmentConfig,
      );

      const retryConfig = stepConfig.retry || {};
      const maxAttempts = retryConfig.max_attempts || 3;
      const initialDelay = retryConfig.initial_delay_ms || 1000;
      const backoffMultiplier = retryConfig.backoff_multiplier || 2;

      let result: BulkCreationResult | null = null;
      let lastError: Error | null = null;

      for (let attempt = 1; attempt <= maxAttempts; attempt++) {
        try {
          if (attempt > 1) {
            const delay =
              initialDelay * Math.pow(backoffMultiplier, attempt - 2);
            context.logger.info("Retrying bulk task creation", {
              stepName: this.config.name,
              attempt,
              maxAttempts,
              delay_ms: delay,
              backoff_strategy: "exponential",
            });
            await sleep(delay);
          }

          context.logger.info(
            `Bulk task creation attempt ${attempt}/${maxAttempts}`,
            {
              stepName: this.config.name,
              projectId: stepConfig.project_id,
              taskCount: enrichedTasks.length,
            },
          );

          result = await this.createTasksViaDashboard(
            stepConfig.project_id,
            enrichedTasks,
            stepConfig.options || {},
          );

          if (result.errors.length === 0) {
            context.logger.info("Bulk task creation succeeded", {
              stepName: this.config.name,
              attempt,
              tasksCreated: result.tasks_created,
              urgentTasks: result.urgent_tasks_created,
              deferredTasks: result.deferred_tasks_created,
              skipped: result.skipped_duplicates,
            });
            break;
          }

          const hasRetryableErrors = this.hasRetryableErrors(
            result.errors,
            retryConfig.retryable_errors,
          );

          if (!hasRetryableErrors) {
            context.logger.warn(
              "Bulk task creation has non-retryable errors, stopping retries",
              {
                stepName: this.config.name,
                attempt,
                errorCount: result.errors.length,
                errors: result.errors,
              },
            );
            break;
          }

          if (attempt < maxAttempts) {
            context.logger.warn(
              "Bulk task creation partially failed, will retry",
              {
                stepName: this.config.name,
                attempt,
                errorCount: result.errors.length,
                tasksCreated: result.tasks_created,
                tasksFailed: result.errors.length,
              },
            );
            lastError = new Error(
              `Partial failure: ${result.errors.length} tasks failed`,
            );
          }
        } catch (error: any) {
          lastError = error instanceof Error ? error : new Error(String(error));

          context.logger.error("Bulk task creation attempt failed", {
            stepName: this.config.name,
            attempt,
            maxAttempts,
            error: lastError.message,
            stack: lastError.stack,
          });

          if (attempt === maxAttempts) {
            break;
          }
        }
      }

      if (!result) {
        throw (
          lastError ||
          new Error("Bulk task creation failed after all retry attempts")
        );
      }

      context.logger.info("Bulk task creation completed", {
        stepName: this.config.name,
        projectId: stepConfig.project_id,
        tasksCreated: result.tasks_created,
        urgentTasks: result.urgent_tasks_created,
        deferredTasks: result.deferred_tasks_created,
        skipped: result.skipped_duplicates,
        errors: result.errors.length,
      });

      if (result.errors.length > 0) {
        context.logger.warn("Some tasks failed to create after all retries", {
          stepName: this.config.name,
          errorCount: result.errors.length,
          errors: result.errors,
        });

        if (
          stepConfig.options?.abort_on_partial_failure &&
          result.errors.length > 0
        ) {
          context.logger.error(
            "Aborting workflow due to partial failure after retries",
            {
              stepName: this.config.name,
              tasksCreated: result.tasks_created,
              tasksFailed: result.errors.length,
            },
          );

          if (typeof (context as any).setVariable === "function") {
            context.setVariable("workflow_abort_requested", true);
            context.setVariable(
              "workflow_abort_reason",
              `BulkTaskCreationStep: ${result.errors.length} tasks failed after retries`,
            );
          }

          return {
            status: "failure",
            error: new Error(
              `Partial failure: ${result.errors.length} tasks failed after ${maxAttempts} attempts`,
            ),
            data: result,
            outputs: {
              tasks_created: result.tasks_created,
              urgent_tasks_created: result.urgent_tasks_created,
              deferred_tasks_created: result.deferred_tasks_created,
              task_ids: result.task_ids,
              duplicate_task_ids: result.duplicate_task_ids,
              skipped_duplicates: result.skipped_duplicates,
              workflow_abort_requested: true,
            },
            metrics: {
              duration_ms: Date.now() - startTime,
              operations_count: result.tasks_created,
            },
          };
        }
      }

      return {
        status: result.errors.length === 0 ? "success" : "failure",
        data: result,
        outputs: {
          tasks_created: result.tasks_created,
          urgent_tasks_created: result.urgent_tasks_created,
          deferred_tasks_created: result.deferred_tasks_created,
          task_ids: result.task_ids,
          duplicate_task_ids: result.duplicate_task_ids,
          skipped_duplicates: result.skipped_duplicates,
        },
        metrics: {
          duration_ms: Date.now() - startTime,
          operations_count: result.tasks_created,
        },
      };
    } catch (error: any) {
      context.logger.error("Bulk task creation failed", {
        stepName: this.config.name,
        error: error.message,
        stack: error.stack,
      });

      return {
        status: "failure",
        error: error instanceof Error ? error : new Error(String(error)),
        metrics: {
          duration_ms: Date.now() - startTime,
        },
      };
    }
  }

  private hasRetryableErrors(
    errors: string[],
    retryablePatterns?: string[],
  ): boolean {
    return this.retryHandler.hasRetryableErrors(errors, retryablePatterns);
  }

  private async createTasksViaDashboard(
    projectId: string,
    tasks: EnrichedTask[],
    _options: {
      create_milestone_if_missing?: boolean;
      upsert_by_external_id?: boolean;
      check_duplicates?: boolean;
      existing_tasks?: ExistingTask[];
    },
  ): Promise<BulkCreationResult> {
    const result: BulkCreationResult = {
      tasks_created: 0,
      urgent_tasks_created: 0,
      deferred_tasks_created: 0,
      task_ids: [],
      duplicate_task_ids: [],
      skipped_duplicates: 0,
      errors: [],
    };

    const dashboardBaseUrl =
      process.env.DASHBOARD_API_URL || "http://localhost:8080";
    const dashboardClient = new DashboardClient({ baseUrl: dashboardBaseUrl });

    const createCandidates: EnrichedTask[] = tasks.filter(
      (t) => !t.is_duplicate,
    );

    const tasksToCreate: TaskCreateInput[] = createCandidates.map((task) => ({
      title: task.title,
      description: task.description,
      status: "open",
      priority_score: task.priority_score,
      milestone_id: this.normalizeMilestoneId(task.milestone_id),
      parent_task_id: task.parent_task_id
        ? parseInt(task.parent_task_id)
        : undefined,
      external_id: task.external_id,
      labels: task.metadata?.labels as string[] | undefined,
    }));

    for (const task of tasks.filter((t) => t.is_duplicate)) {
      result.skipped_duplicates++;
      if (task.duplicate_of_task_id) {
        result.duplicate_task_ids.push(task.duplicate_of_task_id);
      }
      logger.info("Skipping pre-identified duplicate task", {
        title: task.title,
        duplicateOf: task.duplicate_of_task_id,
        reason: task.skip_reason,
      });
    }

    if (tasksToCreate.length === 0) {
      logger.info("No tasks to create (all duplicates or empty)", {
        totalTasks: tasks.length,
        skippedDuplicates: result.skipped_duplicates,
      });
      return result;
    }

    try {
      const response = await dashboardClient.bulkCreateTasks(
        parseInt(projectId),
        {
          tasks: tasksToCreate,
        },
      );

      for (const createdTask of response.created) {
        result.task_ids.push(String(createdTask.id));
        result.tasks_created++;

        const isUrgent = createdTask.priority_score >= 1000;
        if (isUrgent) {
          result.urgent_tasks_created++;
        } else {
          result.deferred_tasks_created++;
        }

        logger.info("Task created successfully", {
          taskId: createdTask.id,
          title: createdTask.title,
          priority_score: createdTask.priority_score,
          milestone: createdTask.milestone_slug,
          external_id: createdTask.external_id,
        });
      }

      if (response.skipped) {
        for (const skipped of response.skipped) {
          result.skipped_duplicates++;
          result.duplicate_task_ids.push(String(skipped.task.id));

          logger.info("Task skipped by dashboard (duplicate external_id)", {
            taskId: skipped.task.id,
            title: skipped.task.title,
            external_id: skipped.external_id,
            reason: skipped.reason,
          });
        }
      }

      logger.info("Bulk task creation completed", {
        stepName: this.config.name,
        projectId,
        tasksCreated: result.tasks_created,
        urgentTasks: result.urgent_tasks_created,
        deferredTasks: result.deferred_tasks_created,
        skipped: result.skipped_duplicates,
        errors: result.errors.length,
      });
    } catch (error: any) {
      const errorMessage = `Bulk task creation failed: ${error.message}`;
      result.errors.push(errorMessage);
      logger.error("Bulk task creation failed", {
        error: error.message,
        stack: error.stack,
        projectId,
        taskCount: tasksToCreate.length,
      });
    }

    return result;
  }

  private normalizeMilestoneId(
    value: number | string | undefined,
  ): number | undefined {
    if (value === undefined || value === null) {
      return undefined;
    }
    if (typeof value === "number" && Number.isFinite(value)) {
      return value;
    }
    if (typeof value === "string") {
      const parsed = Number(value);
      if (!Number.isNaN(parsed)) {
        return parsed;
      }
    }
    return undefined;
  }
}
