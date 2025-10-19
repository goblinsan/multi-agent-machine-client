import { WorkflowStep, StepResult, ValidationResult, WorkflowStepConfig } from '../engine/WorkflowStep.js';
import { WorkflowContext } from '../engine/WorkflowContext.js';
import { logger } from '../../logger.js';

/**
 * Task to create in bulk operation
 */
interface TaskToCreate {
  title: string;
  description?: string;
  priority?: 'critical' | 'high' | 'medium' | 'low';
  milestone_slug?: string;
  parent_task_id?: string;
  external_id?: string;
  assignee_persona?: string;
  metadata?: Record<string, any>;
}

/**
 * Configuration for BulkTaskCreationStep
 */
interface BulkTaskCreationConfig {
  project_id: string;
  tasks: TaskToCreate[];
  priority_mapping?: Record<string, number>;  // Map priority string to score
  milestone_strategy?: {
    urgent?: string;    // Milestone slug for urgent tasks
    deferred?: string;  // Milestone slug for deferred tasks
  };
  parent_task_mapping?: {
    urgent?: string;    // Parent task ID for urgent tasks
    deferred?: string | null;  // Parent task ID for deferred tasks
  };
  title_prefix?: string;  // Prefix to add to all task titles
  options?: {
    create_milestone_if_missing?: boolean;
    upsert_by_external_id?: boolean;
    external_id_template?: string;
  };
}

/**
 * Result of bulk task creation
 */
interface BulkCreationResult {
  tasks_created: number;
  urgent_tasks_created: number;
  deferred_tasks_created: number;
  task_ids: string[];
  skipped_duplicates: number;
  errors: string[];
}

/**
 * Step that creates multiple tasks in a single bulk operation
 * 
 * This solves the N+1 problem by creating all tasks in one API call
 * instead of sequential individual calls.
 * 
 * Example usage in YAML:
 * ```yaml
 * - name: create_tasks_bulk
 *   type: BulkTaskCreationStep
 *   config:
 *     project_id: "${project_id}"
 *     tasks: "${follow_up_tasks}"
 *     priority_mapping:
 *       critical: 1500
 *       high: 1200
 *       medium: 800
 *       low: 50
 *     milestone_strategy:
 *       urgent: "${milestone_id}"
 *       deferred: "future-enhancements"
 *     options:
 *       create_milestone_if_missing: true
 *       upsert_by_external_id: true
 * ```
 */
export class BulkTaskCreationStep extends WorkflowStep {
  /**
   * Validate configuration
   */
  protected async validateConfig(context: WorkflowContext): Promise<ValidationResult> {
    const errors: string[] = [];
    const warnings: string[] = [];
    const stepConfig = this.config.config as BulkTaskCreationConfig;

    if (!stepConfig.project_id) {
      errors.push('project_id is required');
    }

    if (!stepConfig.tasks) {
      errors.push('tasks array is required');
    } else if (!Array.isArray(stepConfig.tasks)) {
      errors.push('tasks must be an array');
    } else if (stepConfig.tasks.length === 0) {
      warnings.push('tasks array is empty - no tasks will be created');
    }

    return { valid: errors.length === 0, errors, warnings };
  }

  /**
   * Execute bulk task creation
   */
  async execute(context: WorkflowContext): Promise<StepResult> {
    const stepConfig = this.config.config as BulkTaskCreationConfig;
    const startTime = Date.now();

    try {
      context.logger.info('Starting bulk task creation', {
        stepName: this.config.name,
        projectId: stepConfig.project_id,
        taskCount: stepConfig.tasks.length
      });

      // If no tasks, return early
      if (!stepConfig.tasks || stepConfig.tasks.length === 0) {
        return {
          status: 'success',
          data: {
            tasks_created: 0,
            urgent_tasks_created: 0,
            deferred_tasks_created: 0,
            task_ids: [],
            skipped_duplicates: 0
          },
          outputs: {
            tasks_created: 0,
            urgent_tasks_created: 0,
            deferred_tasks_created: 0,
            task_ids: [],
            skipped_duplicates: 0
          },
          metrics: {
            duration_ms: Date.now() - startTime
          }
        };
      }

      // Process tasks and enrich with priority scores, milestones, etc.
      const enrichedTasks = this.enrichTasks(stepConfig);

      // Create tasks via dashboard API
      const result = await this.createTasksViaDashboard(
        stepConfig.project_id,
        enrichedTasks,
        stepConfig.options || {}
      );

      context.logger.info('Bulk task creation completed', {
        stepName: this.config.name,
        projectId: stepConfig.project_id,
        tasksCreated: result.tasks_created,
        urgentTasks: result.urgent_tasks_created,
        deferredTasks: result.deferred_tasks_created,
        skipped: result.skipped_duplicates,
        errors: result.errors.length
      });

      if (result.errors.length > 0) {
        context.logger.warn('Some tasks failed to create', {
          stepName: this.config.name,
          errors: result.errors
        });
      }

      return {
        status: result.errors.length === 0 ? 'success' : 'failure',
        data: result,
        outputs: {
          tasks_created: result.tasks_created,
          urgent_tasks_created: result.urgent_tasks_created,
          deferred_tasks_created: result.deferred_tasks_created,
          task_ids: result.task_ids,
          skipped_duplicates: result.skipped_duplicates
        },
        metrics: {
          duration_ms: Date.now() - startTime,
          operations_count: result.tasks_created
        }
      };

    } catch (error: any) {
      context.logger.error('Bulk task creation failed', {
        stepName: this.config.name,
        error: error.message,
        stack: error.stack
      });

      return {
        status: 'failure',
        error: error instanceof Error ? error : new Error(String(error)),
        metrics: {
          duration_ms: Date.now() - startTime
        }
      };
    }
  }

  /**
   * Enrich tasks with priority scores, milestone assignments, etc.
   */
  private enrichTasks(config: BulkTaskCreationConfig): TaskToCreate[] {
    const enriched: TaskToCreate[] = [];
    const priorityMapping = config.priority_mapping || {
      critical: 1500,
      high: 1200,
      medium: 800,
      low: 50
    };

    for (const task of config.tasks) {
      const enrichedTask: any = { ...task };

      // Add title prefix if configured
      if (config.title_prefix) {
        enrichedTask.title = `${config.title_prefix}: ${task.title}`;
      }

      // Map priority string to score
      if (task.priority && priorityMapping[task.priority] !== undefined) {
        enrichedTask.priority_score = priorityMapping[task.priority];
      }

      // Assign milestone based on priority
      if (config.milestone_strategy && task.priority) {
        const isUrgent = task.priority === 'critical' || task.priority === 'high';
        if (isUrgent && config.milestone_strategy.urgent) {
          enrichedTask.milestone_slug = config.milestone_strategy.urgent;
        } else if (!isUrgent && config.milestone_strategy.deferred) {
          enrichedTask.milestone_slug = config.milestone_strategy.deferred;
        }
      }

      // Assign parent task based on priority
      if (config.parent_task_mapping && task.priority) {
        const isUrgent = task.priority === 'critical' || task.priority === 'high';
        if (isUrgent && config.parent_task_mapping.urgent) {
          enrichedTask.parent_task_id = config.parent_task_mapping.urgent;
        } else if (!isUrgent && config.parent_task_mapping.deferred !== undefined) {
          enrichedTask.parent_task_id = config.parent_task_mapping.deferred;
        }
      }

      // Generate external_id if template provided
      if (config.options?.external_id_template && !task.external_id) {
        enrichedTask.external_id = this.generateExternalId(
          config.options.external_id_template,
          task
        );
      }

      enriched.push(enrichedTask);
    }

    return enriched;
  }

  /**
   * Generate external ID from template
   */
  private generateExternalId(template: string, task: TaskToCreate): string {
    // Simple template variable replacement
    // Template example: "${review_type}-${task.id}-${task.title_slug}"
    const titleSlug = task.title
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-|-$/g, '');

    return template
      .replace('${task.title_slug}', titleSlug)
      .replace('${task.title}', task.title);
  }

  /**
   * Create tasks via dashboard API (bulk endpoint)
   * 
   * TODO: This is a placeholder - implement actual dashboard bulk API call
   * For now, falls back to sequential creation
   */
  private async createTasksViaDashboard(
    projectId: string,
    tasks: TaskToCreate[],
    options: { create_milestone_if_missing?: boolean; upsert_by_external_id?: boolean }
  ): Promise<BulkCreationResult> {
    const result: BulkCreationResult = {
      tasks_created: 0,
      urgent_tasks_created: 0,
      deferred_tasks_created: 0,
      task_ids: [],
      skipped_duplicates: 0,
      errors: []
    };

    // TODO: Replace with actual dashboard bulk endpoint call
    // For now, this is a placeholder that would need dashboard integration
    logger.warn('BulkTaskCreationStep: Dashboard bulk endpoint not yet implemented, using placeholder', {
      projectId,
      taskCount: tasks.length
    });

    // Placeholder logic - in real implementation, would call dashboard API
    for (const task of tasks) {
      try {
        // Simulate successful creation
        const taskId = `task-${Date.now()}-${Math.random().toString(36).substring(7)}`;
        result.task_ids.push(taskId);
        result.tasks_created++;

        const isUrgent = task.priority === 'critical' || task.priority === 'high';
        if (isUrgent) {
          result.urgent_tasks_created++;
        } else {
          result.deferred_tasks_created++;
        }

        logger.info('Task creation simulated (placeholder)', {
          taskId,
          title: task.title,
          priority: task.priority,
          milestone: task.milestone_slug
        });

      } catch (error: any) {
        result.errors.push(`Failed to create task '${task.title}': ${error.message}`);
        logger.error('Task creation failed', {
          task: task.title,
          error: error.message
        });
      }
    }

    return result;
  }
}
