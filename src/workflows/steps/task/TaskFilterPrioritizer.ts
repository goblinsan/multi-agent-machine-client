import { logger } from '../../../logger.js';
import { TaskDefinition } from './TaskGenerator.js';

interface TaskCreationConfig {
  minConfidenceThreshold?: number;
  highPriorityOnly?: boolean;
  groupRelatedIssues?: boolean;
  maxTasks?: number;
}

/**
 * Filters and prioritizes tasks based on configuration
 */
export class TaskFilterPrioritizer {
  /**
   * Filter and prioritize tasks according to configuration
   */
  filterAndPrioritize(tasks: TaskDefinition[], config: TaskCreationConfig): TaskDefinition[] {
    let filteredTasks = [...tasks];
    
    // Filter by confidence threshold
    const minConfidence = config.minConfidenceThreshold || 0.3;
    const beforeConfidenceFilter = filteredTasks.length;
    filteredTasks = filteredTasks.filter(task => task.confidence >= minConfidence);
    
    if (beforeConfidenceFilter > filteredTasks.length) {
      logger.debug('Filtered tasks by confidence', {
        removed: beforeConfidenceFilter - filteredTasks.length,
        threshold: minConfidence
      });
    }
    
    // Filter by priority if high priority only
    if (config.highPriorityOnly) {
      const beforePriorityFilter = filteredTasks.length;
      filteredTasks = filteredTasks.filter(task => 
        task.priority === 'critical' || task.priority === 'high'
      );
      
      if (beforePriorityFilter > filteredTasks.length) {
        logger.debug('Filtered tasks by priority', {
          removed: beforePriorityFilter - filteredTasks.length,
          mode: 'high-priority-only'
        });
      }
    }
    
    // Sort by priority and confidence
    filteredTasks = this.sortByPriorityAndConfidence(filteredTasks);
    
    // Limit number of tasks
    const maxTasks = config.maxTasks || 20;
    if (filteredTasks.length > maxTasks) {
      logger.info('Limiting task count', {
        total: filteredTasks.length,
        maxTasks,
        truncated: filteredTasks.length - maxTasks
      });
      filteredTasks = filteredTasks.slice(0, maxTasks);
    }
    
    return filteredTasks;
  }

  /**
   * Sort tasks by priority (descending) then confidence (descending)
   */
  private sortByPriorityAndConfidence(tasks: TaskDefinition[]): TaskDefinition[] {
    const priorityOrder = { critical: 4, high: 3, medium: 2, low: 1 };
    
    return tasks.sort((a, b) => {
      const priorityDiff = priorityOrder[b.priority] - priorityOrder[a.priority];
      if (priorityDiff !== 0) return priorityDiff;
      return b.confidence - a.confidence;
    });
  }
}
