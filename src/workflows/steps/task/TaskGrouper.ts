import { logger } from '../../../logger.js';
import { TaskDefinition } from './TaskGenerator.js';

/**
 * Groups related tasks together
 */
export class TaskGrouper {
  /**
   * Group related tasks by category
   */
  groupRelatedTasks(tasks: TaskDefinition[]): TaskDefinition[] {
    // Simple grouping by category - could be enhanced with more sophisticated similarity detection
    const grouped = new Map<string, TaskDefinition[]>();
    
    for (const task of tasks) {
      const key = task.category;
      if (!grouped.has(key)) {
        grouped.set(key, []);
      }
      grouped.get(key)!.push(task);
    }
    
    const result: TaskDefinition[] = [];
    
    for (const [category, categoryTasks] of grouped) {
      if (categoryTasks.length === 1) {
        result.push(categoryTasks[0]);
      } else {
        // Create a parent task with subtasks
        const parentTask = this.createGroupedTask(category, categoryTasks);
        result.push(parentTask);
      }
    }
    
    logger.info('Grouped related tasks', {
      categories: grouped.size,
      originalTasks: tasks.length,
      groupedTasks: result.length
    });
    
    return result;
  }

  /**
   * Create a parent task that groups multiple related tasks
   */
  private createGroupedTask(category: string, tasks: TaskDefinition[]): TaskDefinition {
    return {
      id: `grouped-${category}-${Date.now()}`,
      title: `Address ${category} issues (${tasks.length} items)`,
      description: `Group of related ${category} issues:\n\n${tasks.map(t => `- ${t.title}`).join('\n')}`,
      priority: this.getHighestPriority(tasks),
      category,
      confidence: tasks.reduce((sum, task) => sum + task.confidence, 0) / tasks.length,
      labels: ['grouped', category],
      subtasks: tasks,
      sourceData: {
        type: 'manual',
        sourceId: `grouped-${category}`,
        confidence: 0.8
      },
      acceptanceCriteria: [
        'All subtasks are completed',
        `All ${category} issues are resolved`,
        'No regression in related functionality'
      ]
    };
  }

  /**
   * Get the highest priority from a list of tasks
   */
  private getHighestPriority(tasks: TaskDefinition[]): TaskDefinition['priority'] {
    const order = { critical: 4, high: 3, medium: 2, low: 1 };
    return tasks.reduce((highest, task) => {
      return order[task.priority] > order[highest] ? task.priority : highest;
    }, 'low' as TaskDefinition['priority']);
  }
}
