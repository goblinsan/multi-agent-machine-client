import { WorkflowStep, StepResult, ValidationResult, WorkflowStepConfig } from '../engine/WorkflowStep.js';
import { WorkflowContext } from '../engine/WorkflowContext.js';
import { logger } from '../../logger.js';
import { DashboardClient, type TaskCreateInput } from '../../services/DashboardClient.js';

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
  is_duplicate?: boolean;
  duplicate_of_task_id?: string | null;
  skip_reason?: string;
}

/**
 * Existing task from dashboard (for duplicate detection)
 */
interface ExistingTask {
  id: string;
  title: string;
  status: string;
  milestone_slug?: string;
  external_id?: string;
}

/**
 * Configuration for BulkTaskCreationStep
 */
interface BulkTaskCreationConfig {
  project_id: string;
  tasks: TaskToCreate[];
  workflow_run_id?: string;  // Unique workflow execution ID for idempotency
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
  retry?: {
    max_attempts?: number;       // Default: 3
    initial_delay_ms?: number;   // Default: 1000 (1 second)
    backoff_multiplier?: number; // Default: 2 (exponential backoff)
    retryable_errors?: string[]; // Error messages that should trigger retry
  };
  options?: {
    create_milestone_if_missing?: boolean;
    upsert_by_external_id?: boolean;  // Enable idempotent task creation via external_id
    external_id_template?: string;    // Custom template, or auto-generate if upsert_by_external_id=true
    check_duplicates?: boolean;
    existing_tasks?: ExistingTask[];
    duplicate_match_strategy?: 'title' | 'title_and_milestone' | 'external_id';
    abort_on_partial_failure?: boolean; // Abort workflow if some tasks fail after retries
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
  duplicate_task_ids: string[];
  skipped_duplicates: number;
  errors: string[];
}

/**
 * Step that creates multiple tasks in a single bulk operation
 * 
 * This solves the N+1 problem by creating all tasks in one API call
 * instead of sequential individual calls.
 * 
 * **Idempotency Support (NEW in Phase 4):**
 * - Automatically generates `external_id` for each task
 * - Format: `${workflow_run_id}:${step_name}:${task_index}`
 * - Enables safe workflow re-runs (duplicate prevention via external_id)
 * - Custom templates supported via `external_id_template` config
 * 
 * **Priority-Based Routing:**
 * - `critical` / `high` priority → immediate milestone
 * - `medium` / `low` priority → deferred milestone
 * - Configurable priority scores (default: critical=1500, high=1200, medium=800, low=50)
 * 
 * **Duplicate Detection:**
 * - Three strategies: external_id (100%), title (80%), title_and_milestone (70%)
 * - Detailed match scoring with overlap percentages
 * - Automatic duplicate skipping
 * 
 * **Retry Logic:**
 * - Exponential backoff (default: 3 attempts, 1s/2s/4s delays)
 * - Smart retryable error detection (timeouts, rate limits, 5xx errors)
 * - Workflow abort signal on partial failure (opt-in)
 * 
 * Example usage in YAML:
 * ```yaml
 * - name: create_tasks_bulk
 *   type: BulkTaskCreationStep
 *   config:
 *     project_id: "${project_id}"
 *     workflow_run_id: "${workflow_run_id}"  # For idempotency
 *     tasks: "${follow_up_tasks}"
 *     priority_mapping:
 *       critical: 1500
 *       high: 1200
 *       medium: 800
 *       low: 50
 *     milestone_strategy:
 *       urgent: "${milestone_id}"
 *       deferred: "future-enhancements"
 *     retry:
 *       max_attempts: 3
 *       initial_delay_ms: 1000
 *       backoff_multiplier: 2
 *     options:
 *       create_milestone_if_missing: true
 *       upsert_by_external_id: true  # Enable idempotency
 *       external_id_template: "${workflow_run_id}:${step_name}:${task_index}"
 *       check_duplicates: true
 *       duplicate_match_strategy: "external_id"
 *       abort_on_partial_failure: false
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
   * Execute bulk task creation with retry logic
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
            duplicate_task_ids: [],
            skipped_duplicates: 0
          },
          outputs: {
            tasks_created: 0,
            urgent_tasks_created: 0,
            deferred_tasks_created: 0,
            task_ids: [],
            duplicate_task_ids: [],
            skipped_duplicates: 0
          },
          metrics: {
            duration_ms: Date.now() - startTime
          }
        };
      }

      // Process tasks and enrich with priority scores, milestones, etc.
      const enrichedTasks = this.enrichTasks(stepConfig);

      // Create tasks with retry logic
      const retryConfig = stepConfig.retry || {};
      const maxAttempts = retryConfig.max_attempts || 3;
      const initialDelay = retryConfig.initial_delay_ms || 1000;
      const backoffMultiplier = retryConfig.backoff_multiplier || 2;

      let result: BulkCreationResult | null = null;
      let lastError: Error | null = null;

      for (let attempt = 1; attempt <= maxAttempts; attempt++) {
        try {
          if (attempt > 1) {
            // Exponential backoff: 1s, 2s, 4s, 8s, ...
            const delay = initialDelay * Math.pow(backoffMultiplier, attempt - 2);
            context.logger.info('Retrying bulk task creation', {
              stepName: this.config.name,
              attempt,
              maxAttempts,
              delay_ms: delay,
              backoff_strategy: 'exponential'
            });
            await this.sleep(delay);
          }

          context.logger.info(`Bulk task creation attempt ${attempt}/${maxAttempts}`, {
            stepName: this.config.name,
            projectId: stepConfig.project_id,
            taskCount: enrichedTasks.length
          });

          // Create tasks via dashboard API
          result = await this.createTasksViaDashboard(
            stepConfig.project_id,
            enrichedTasks,
            stepConfig.options || {}
          );

          // Success if no errors
          if (result.errors.length === 0) {
            context.logger.info('Bulk task creation succeeded', {
              stepName: this.config.name,
              attempt,
              tasksCreated: result.tasks_created,
              urgentTasks: result.urgent_tasks_created,
              deferredTasks: result.deferred_tasks_created,
              skipped: result.skipped_duplicates
            });
            break; // Success, exit retry loop
          }

          // Partial success - check if we should retry
          const hasRetryableErrors = this.hasRetryableErrors(
            result.errors,
            retryConfig.retryable_errors
          );

          if (!hasRetryableErrors) {
            context.logger.warn('Bulk task creation has non-retryable errors, stopping retries', {
              stepName: this.config.name,
              attempt,
              errorCount: result.errors.length,
              errors: result.errors
            });
            break; // Non-retryable errors, stop retrying
          }

          if (attempt < maxAttempts) {
            context.logger.warn('Bulk task creation partially failed, will retry', {
              stepName: this.config.name,
              attempt,
              errorCount: result.errors.length,
              tasksCreated: result.tasks_created,
              tasksFailed: result.errors.length
            });
            lastError = new Error(`Partial failure: ${result.errors.length} tasks failed`);
          }

        } catch (error: any) {
          lastError = error instanceof Error ? error : new Error(String(error));
          
          context.logger.error('Bulk task creation attempt failed', {
            stepName: this.config.name,
            attempt,
            maxAttempts,
            error: lastError.message,
            stack: lastError.stack
          });

          if (attempt === maxAttempts) {
            // Final attempt failed
            break;
          }
        }
      }

      // Check final result
      if (!result) {
        throw lastError || new Error('Bulk task creation failed after all retry attempts');
      }

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
        context.logger.warn('Some tasks failed to create after all retries', {
          stepName: this.config.name,
          errorCount: result.errors.length,
          errors: result.errors
        });

        // Check if we should abort workflow on partial failure
        if (stepConfig.options?.abort_on_partial_failure && result.errors.length > 0) {
          context.logger.error('Aborting workflow due to partial failure after retries', {
            stepName: this.config.name,
            tasksCreated: result.tasks_created,
            tasksFailed: result.errors.length
          });
          
          // Signal workflow abort
          context.setVariable('workflow_abort_requested', true);
          context.setVariable('workflow_abort_reason', `BulkTaskCreationStep: ${result.errors.length} tasks failed after retries`);
          
          return {
            status: 'failure',
            error: new Error(`Partial failure: ${result.errors.length} tasks failed after ${maxAttempts} attempts`),
            data: result,
            outputs: {
              tasks_created: result.tasks_created,
              urgent_tasks_created: result.urgent_tasks_created,
              deferred_tasks_created: result.deferred_tasks_created,
              task_ids: result.task_ids,
              duplicate_task_ids: result.duplicate_task_ids,
              skipped_duplicates: result.skipped_duplicates,
              workflow_abort_requested: true
            },
            metrics: {
              duration_ms: Date.now() - startTime,
              operations_count: result.tasks_created
            }
          };
        }
      }

      return {
        status: result.errors.length === 0 ? 'success' : 'failure',
        data: result,
        outputs: {
          tasks_created: result.tasks_created,
          urgent_tasks_created: result.urgent_tasks_created,
          deferred_tasks_created: result.deferred_tasks_created,
          task_ids: result.task_ids,
          duplicate_task_ids: result.duplicate_task_ids,
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
   * Check if errors contain retryable error messages
   */
  private hasRetryableErrors(errors: string[], retryablePatterns?: string[]): boolean {
    if (!retryablePatterns || retryablePatterns.length === 0) {
      // Default retryable patterns
      const defaultPatterns = [
        'timeout',
        'ETIMEDOUT',
        'ECONNRESET',
        'ECONNREFUSED',
        'network',
        'rate limit',
        '429',
        '500',
        '502',
        '503',
        '504'
      ];
      retryablePatterns = defaultPatterns;
    }

    return errors.some(error => {
      const lowerError = error.toLowerCase();
      return retryablePatterns!.some(pattern => 
        lowerError.includes(pattern.toLowerCase())
      );
    });
  }

  /**
   * Sleep for specified milliseconds
   */
  private sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  /**
   * Enrich tasks with priority scores, milestone assignments, etc.
   * Also performs duplicate detection if configured
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
      // Skip if already marked as duplicate by PM
      if (task.is_duplicate === true) {
        logger.info('Skipping duplicate task (marked by PM)', {
          title: task.title,
          duplicateOf: task.duplicate_of_task_id
        });
        continue;
      }

      const enrichedTask: any = { ...task };

      // Add title prefix if configured
      if (config.title_prefix) {
        enrichedTask.title = `${config.title_prefix}: ${task.title}`;
      }

      // Check for duplicates in existing tasks
      if (config.options?.check_duplicates && config.options.existing_tasks) {
        const duplicateInfo = this.findDuplicateWithDetails(
          enrichedTask,
          config.options.existing_tasks,
          config.options.duplicate_match_strategy || 'title_and_milestone'
        );
        
        if (duplicateInfo) {
          logger.info('Duplicate task detected', {
            title: enrichedTask.title,
            duplicateOf: duplicateInfo.duplicate.id,
            matchStrategy: duplicateInfo.strategy,
            matchScore: duplicateInfo.matchScore,
            titleOverlap: duplicateInfo.titleOverlap ? `${(duplicateInfo.titleOverlap * 100).toFixed(1)}%` : 'N/A',
            descriptionOverlap: duplicateInfo.descriptionOverlap ? `${(duplicateInfo.descriptionOverlap * 100).toFixed(1)}%` : 'N/A'
          });
          enrichedTask.is_duplicate = true;
          enrichedTask.duplicate_of_task_id = duplicateInfo.duplicate.id;
          enrichedTask.skip_reason = `Duplicate of existing task #${duplicateInfo.duplicate.id} (${duplicateInfo.matchScore.toFixed(0)}% match)`;
          continue; // Skip this task
        }
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

      // Generate external_id if template provided or auto-generate if enabled
      if (!task.external_id) {
        if (config.options?.external_id_template) {
          // Use custom template
          enrichedTask.external_id = this.generateExternalId(
            config.options.external_id_template,
            task,
            enriched.length // task_index
          );
        } else if (config.options?.upsert_by_external_id) {
          // Auto-generate default format for idempotency
          enrichedTask.external_id = this.generateDefaultExternalId(
            task,
            enriched.length // task_index
          );
        }
      }

      enriched.push(enrichedTask);
    }

    return enriched;
  }

  /**
   * Find duplicate task in existing tasks list
   */
  private findDuplicate(
    task: TaskToCreate,
    existingTasks: ExistingTask[],
    strategy: 'title' | 'title_and_milestone' | 'external_id'
  ): ExistingTask | null {
    const result = this.findDuplicateWithDetails(task, existingTasks, strategy);
    return result ? result.duplicate : null;
  }

  /**
   * Find duplicate task with detailed match information
   */
  private findDuplicateWithDetails(
    task: TaskToCreate,
    existingTasks: ExistingTask[],
    strategy: 'title' | 'title_and_milestone' | 'external_id'
  ): { 
    duplicate: ExistingTask; 
    strategy: string;
    matchScore: number;
    titleOverlap?: number;
    descriptionOverlap?: number;
  } | null {
    const normalizeTitle = (title: string) => title.toLowerCase().trim();
    const extractWords = (text: string): Set<string> => {
      if (!text) return new Set();
      return new Set(
        text
          .toLowerCase()
          .match(/\b\w{3,}\b/g) || []
      );
    };

    for (const existing of existingTasks) {
      let matchScore = 0;
      let titleOverlap: number | undefined;
      let descriptionOverlap: number | undefined;

      switch (strategy) {
        case 'external_id':
          if (task.external_id && existing.external_id === task.external_id) {
            return { 
              duplicate: existing, 
              strategy: 'external_id',
              matchScore: 100
            };
          }
          break;

        case 'title': {
          const taskTitle = normalizeTitle(task.title);
          const existingTitle = normalizeTitle(existing.title);
          
          if (taskTitle === existingTitle) {
            matchScore = 100;
          } else {
            // Calculate word overlap
            const taskWords = extractWords(task.title);
            const existingWords = extractWords(existing.title);
            const intersection = new Set([...taskWords].filter(w => existingWords.has(w)));
            titleOverlap = taskWords.size > 0 ? intersection.size / taskWords.size : 0;
            matchScore = titleOverlap * 100;
          }

          if (matchScore >= 80) { // 80% title match threshold
            return {
              duplicate: existing,
              strategy: 'title',
              matchScore,
              titleOverlap
            };
          }
          break;
        }

        case 'title_and_milestone': {
          const taskTitle = normalizeTitle(task.title);
          const existingTitle = normalizeTitle(existing.title);
          
          if (existing.milestone_slug === task.milestone_slug) {
            if (taskTitle === existingTitle) {
              matchScore = 100;
            } else {
              // Calculate word overlap for title
              const taskWords = extractWords(task.title);
              const existingWords = extractWords(existing.title);
              const intersection = new Set([...taskWords].filter(w => existingWords.has(w)));
              titleOverlap = taskWords.size > 0 ? intersection.size / taskWords.size : 0;
              
              // Calculate description overlap if both have descriptions
              if (task.description && (existing as any).description) {
                const taskDescWords = extractWords(task.description);
                const existingDescWords = extractWords((existing as any).description);
                const descIntersection = new Set([...taskDescWords].filter(w => existingDescWords.has(w)));
                descriptionOverlap = taskDescWords.size > 0 ? descIntersection.size / taskDescWords.size : 0;
                
                // Weighted average: 70% title, 30% description
                matchScore = (titleOverlap * 0.7 + descriptionOverlap * 0.3) * 100;
              } else {
                matchScore = titleOverlap * 100;
              }
            }

            if (matchScore >= 70) { // 70% match threshold with same milestone
              return {
                duplicate: existing,
                strategy: 'title_and_milestone',
                matchScore,
                titleOverlap,
                descriptionOverlap
              };
            }
          }
          break;
        }
      }
    }

    return null;
  }

  /**
   * Generate default external ID for idempotency
   * Format: ${workflow_run_id}:${step_name}:${task_index}
   * 
   * This ensures tasks are idempotent across workflow re-runs:
   * - Same workflow run + step + task index = same external_id
   * - Different workflow runs = different external_ids
   * 
   * Example: "wf-550e8400-e29b:create_tasks_bulk:0"
   */
  private generateDefaultExternalId(task: TaskToCreate, taskIndex: number): string {
    // Get workflow_run_id and step_name from config or context
    // Note: These should be passed through config from the workflow engine
    const workflowRunId = (this.config.config as any).workflow_run_id || 'unknown';
    const stepName = this.config.name;
    
    return `${workflowRunId}:${stepName}:${taskIndex}`;
  }

  /**
   * Generate external ID from template
   * 
   * Available template variables:
   * - ${workflow_run_id} - Unique workflow execution ID
   * - ${step_name} - Name of the current step
   * - ${task_index} - Index of task in array (0-based)
   * - ${task.title_slug} - Slugified task title
   * - ${task.title} - Original task title
   * - ${task.priority} - Task priority (critical, high, medium, low)
   * - ${task.milestone_slug} - Milestone slug if set
   * 
   * Template example: "${workflow_run_id}:${step_name}:${task_index}"
   * Result: "wf-550e8400-e29b:create_tasks_bulk:0"
   */
  private generateExternalId(template: string, task: TaskToCreate, taskIndex: number): string {
    // Get workflow_run_id and step_name from config or context
    const workflowRunId = (this.config.config as any).workflow_run_id || 'unknown';
    const stepName = this.config.name;
    
    const titleSlug = task.title
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-|-$/g, '');

    return template
      .replace(/\$\{workflow_run_id\}/g, workflowRunId)
      .replace(/\$\{step_name\}/g, stepName)
      .replace(/\$\{task_index\}/g, taskIndex.toString())
      .replace(/\$\{task\.title_slug\}/g, titleSlug)
      .replace(/\$\{task\.title\}/g, task.title)
      .replace(/\$\{task\.priority\}/g, task.priority || 'medium')
      .replace(/\$\{task\.milestone_slug\}/g, task.milestone_slug || '');
  }

  /**
   * Create tasks via dashboard API (bulk endpoint)
   * 
   * TODO: This is a placeholder - implement actual dashboard bulk API call
   * For now, falls back to sequential creation with duplicate tracking
   */
  private async createTasksViaDashboard(
    projectId: string,
    tasks: TaskToCreate[],
    options: { 
      create_milestone_if_missing?: boolean; 
      upsert_by_external_id?: boolean;
      check_duplicates?: boolean;
      existing_tasks?: ExistingTask[];
    }
  ): Promise<BulkCreationResult> {
    const result: BulkCreationResult = {
      tasks_created: 0,
      urgent_tasks_created: 0,
      deferred_tasks_created: 0,
      task_ids: [],
      duplicate_task_ids: [],
      skipped_duplicates: 0,
      errors: []
    };

    // Get dashboard client configuration from environment or config
    const dashboardBaseUrl = process.env.DASHBOARD_API_URL || 'http://localhost:8080';
    const dashboardClient = new DashboardClient({ baseUrl: dashboardBaseUrl });

    // Convert tasks to dashboard API format
    const tasksToCreate: TaskCreateInput[] = tasks
      .filter(t => !t.is_duplicate) // Only create non-duplicates
      .map(task => ({
        title: task.title,
        description: task.description,
        status: 'open',
        priority_score: this.priorityToPriorityScore(task.priority),
        milestone_id: task.milestone_slug ? undefined : undefined, // TODO: Resolve milestone slug to ID
        parent_task_id: task.parent_task_id ? parseInt(task.parent_task_id) : undefined,
        external_id: task.external_id,
        labels: task.metadata?.labels as string[] | undefined
      }));

    // Handle tasks already marked as duplicates
    for (const task of tasks.filter(t => t.is_duplicate)) {
      result.skipped_duplicates++;
      if (task.duplicate_of_task_id) {
        result.duplicate_task_ids.push(task.duplicate_of_task_id);
      }
      logger.info('Skipping pre-identified duplicate task', {
        title: task.title,
        duplicateOf: task.duplicate_of_task_id,
        reason: task.skip_reason
      });
    }

    // If no tasks to create, return early
    if (tasksToCreate.length === 0) {
      logger.info('No tasks to create (all duplicates or empty)', {
        totalTasks: tasks.length,
        skippedDuplicates: result.skipped_duplicates
      });
      return result;
    }

    try {
      // Call dashboard bulk create endpoint
      const response = await dashboardClient.bulkCreateTasks(parseInt(projectId), {
        tasks: tasksToCreate
      });

      // Process created tasks
      for (const createdTask of response.created) {
        result.task_ids.push(String(createdTask.id));
        result.tasks_created++;

        // Determine if urgent based on priority score
        const isUrgent = createdTask.priority_score >= 1000;
        if (isUrgent) {
          result.urgent_tasks_created++;
        } else {
          result.deferred_tasks_created++;
        }

        logger.info('Task created successfully', {
          taskId: createdTask.id,
          title: createdTask.title,
          priority_score: createdTask.priority_score,
          milestone: createdTask.milestone_slug,
          external_id: createdTask.external_id
        });
      }

      // Process skipped tasks (idempotent duplicates from dashboard)
      if (response.skipped) {
        for (const skipped of response.skipped) {
          result.skipped_duplicates++;
          result.duplicate_task_ids.push(String(skipped.task.id));
          
          logger.info('Task skipped by dashboard (duplicate external_id)', {
            taskId: skipped.task.id,
            title: skipped.task.title,
            external_id: skipped.external_id,
            reason: skipped.reason
          });
        }
      }

      logger.info('Bulk task creation completed', {
        workflowId: context.workflowId,
        stepName: this.config.name,
        projectId,
        tasksCreated: result.tasks_created,
        urgentTasks: result.urgent_tasks_created,
        deferredTasks: result.deferred_tasks_created,
        skipped: result.skipped_duplicates,
        errors: result.errors.length
      });

    } catch (error: any) {
      const errorMessage = `Bulk task creation failed: ${error.message}`;
      result.errors.push(errorMessage);
      logger.error('Bulk task creation failed', {
        error: error.message,
        stack: error.stack,
        projectId,
        taskCount: tasksToCreate.length
      });
    }

    return result;
  }

  /**
   * Convert priority string to priority_score number
   */
  private priorityToPriorityScore(priority?: 'critical' | 'high' | 'medium' | 'low'): number {
    switch (priority) {
      case 'critical':
        return 1500;
      case 'high':
        return 1200;
      case 'medium':
        return 800;
      case 'low':
        return 50;
      default:
        return 500; // Default priority
    }
  }
}
