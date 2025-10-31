import { TaskPriorityCalculator, TaskPriority } from './TaskPriorityCalculator.js';
import { TaskDuplicateDetector, type ExistingTask, type DuplicateMatchStrategy } from './TaskDuplicateDetector.js';
import { TaskRouter, type MilestoneStrategy, type ParentTaskMapping } from './TaskRouter.js';

export interface TaskToEnrich {
  title: string;
  description?: string;
  priority?: TaskPriority;
  milestone_slug?: string;
  parent_task_id?: string;
  external_id?: string;
  assignee_persona?: string;
  metadata?: Record<string, any>;
  is_duplicate?: boolean;
  duplicate_of_task_id?: string | null;
  skip_reason?: string;
}

export interface EnrichedTask extends TaskToEnrich {
  priority_score: number;
  is_urgent: boolean;
}

export interface EnrichmentConfig {
  priority_mapping?: Record<string, number>;
  milestone_strategy?: MilestoneStrategy;
  parent_task_mapping?: ParentTaskMapping;
  title_prefix?: string;
  check_duplicates?: boolean;
  existing_tasks?: ExistingTask[];
  duplicate_match_strategy?: DuplicateMatchStrategy;
  workflow_run_id?: string;
  step_name?: string;
  upsert_by_external_id?: boolean;
  external_id_template?: string;
}

export class TaskEnricher {
  private priorityCalculator: TaskPriorityCalculator;
  private duplicateDetector: TaskDuplicateDetector;
  private router: TaskRouter;

  constructor() {
    this.priorityCalculator = new TaskPriorityCalculator();
    this.duplicateDetector = new TaskDuplicateDetector();
    this.router = new TaskRouter();
  }

  enrichTasks(tasks: TaskToEnrich[], config: EnrichmentConfig): EnrichedTask[] {
    if (config.priority_mapping) {
      this.priorityCalculator = new TaskPriorityCalculator(config.priority_mapping);
    }

    const enriched: EnrichedTask[] = [];

    for (const task of tasks) {
      if (task.is_duplicate) {
        continue;
      }

      const enrichedTask: EnrichedTask = {
        ...task,
        priority_score: 0,
        is_urgent: false
      };

      if (config.title_prefix) {
        enrichedTask.title = `${config.title_prefix}${task.title}`;
      }

      if (config.check_duplicates && config.existing_tasks && config.existing_tasks.length > 0) {
        const taskForDuplication = { 
          title: enrichedTask.title, 
          description: task.description || '', 
          external_id: task.external_id,
          milestone_slug: task.milestone_slug
        };
        
        const duplicateResult = this.duplicateDetector.findDuplicateWithDetails(
          taskForDuplication,
          config.existing_tasks,
          config.duplicate_match_strategy || 'title'
        );

        if (duplicateResult) {
          enrichedTask.is_duplicate = true;
          enrichedTask.duplicate_of_task_id = String(duplicateResult.duplicate.id);
          enrichedTask.skip_reason = `Duplicate detected (${duplicateResult.strategy}, ${Math.round(duplicateResult.matchScore)}% match)`;
          enriched.push(enrichedTask);
          continue;
        }
      }

      enrichedTask.priority_score = this.priorityCalculator.calculateScore(task.priority);

      const routing = this.router.routeTask(
        task.priority,
        config.milestone_strategy,
        config.parent_task_mapping
      );

      if (routing.milestone_slug) {
        enrichedTask.milestone_slug = routing.milestone_slug;
      }
      if (routing.parent_task_id) {
        enrichedTask.parent_task_id = routing.parent_task_id;
      }

      enrichedTask.is_urgent = this.priorityCalculator.isUrgent(task.priority);

      if (config.external_id_template && !enrichedTask.external_id) {
        enrichedTask.external_id = this.generateExternalId(
          config.external_id_template,
          task,
          enriched.length,
          config
        );
      } else if (config.upsert_by_external_id && !enrichedTask.external_id) {
        enrichedTask.external_id = this.generateDefaultExternalId(task, enriched.length, config);
      }

      enriched.push(enrichedTask);
    }

    return enriched;
  }

  private generateExternalId(
    template: string, 
    task: TaskToEnrich, 
    index: number, 
    config: EnrichmentConfig
  ): string {
    return template
      .replace(/\$\{workflow_run_id\}/g, config.workflow_run_id || '')
      .replace(/\$\{step_name\}/g, config.step_name || '')
      .replace(/\$\{task\.title\}/g, task.title.toLowerCase().replace(/[^a-z0-9]+/g, '-'))
      .replace(/\$\{task\.priority\}/g, task.priority || 'medium')
      .replace(/\$\{task\.milestone_slug\}/g, task.milestone_slug || '')
      .replace(/\$\{task_index\}/g, String(index));
  }

  private generateDefaultExternalId(task: TaskToEnrich, index: number, config: EnrichmentConfig): string {
    if (config.workflow_run_id && config.step_name) {
      return `${config.workflow_run_id}:${config.step_name}:${index}`;
    }
    const sanitizedTitle = task.title.toLowerCase().replace(/[^a-z0-9]+/g, '-').substring(0, 50);
    return `${sanitizedTitle}-${index}`;
  }
}
