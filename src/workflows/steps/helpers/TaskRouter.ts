/**
 * Task Router
 * 
 * Handles milestone and parent task assignment based on priority and configuration.
 * Routes urgent tasks to immediate milestones and deferred tasks to backlog.
 */

import { TaskPriority } from './TaskPriorityCalculator.js';

/**
 * Milestone routing strategy configuration
 */
export interface MilestoneStrategy {
  urgent?: string;
  deferred?: string;
}

/**
 * Parent task mapping configuration
 */
export interface ParentTaskMapping {
  urgent?: string;
  deferred?: string | null;
}

/**
 * Task routing result
 */
export interface TaskRoutingResult {
  milestone_slug?: string;
  parent_task_id?: string | null;
}

/**
 * TaskRouter handles milestone and parent task assignments
 */
export class TaskRouter {
  /**
   * Route task to appropriate milestone based on priority
   * 
   * @param priority - Task priority level
   * @param milestoneStrategy - Milestone routing strategy
   * @param currentMilestone - Current milestone assignment (if any)
   * @returns Milestone slug to assign
   */
  routeToMilestone(
    priority: TaskPriority | undefined,
    milestoneStrategy?: MilestoneStrategy,
    currentMilestone?: string
  ): string | undefined {
    if (!milestoneStrategy || !priority) {
      return currentMilestone;
    }

    const isUrgent = priority === 'critical' || priority === 'high';
    
    if (isUrgent && milestoneStrategy.urgent) {
      return milestoneStrategy.urgent;
    } else if (!isUrgent && milestoneStrategy.deferred) {
      return milestoneStrategy.deferred;
    }

    return currentMilestone;
  }

  /**
   * Assign parent task based on priority
   * 
   * @param priority - Task priority level
   * @param parentTaskMapping - Parent task mapping configuration
   * @param currentParentId - Current parent task ID (if any)
   * @returns Parent task ID to assign
   */
  assignParentTask(
    priority: TaskPriority | undefined,
    parentTaskMapping?: ParentTaskMapping,
    currentParentId?: string
  ): string | null | undefined {
    if (!parentTaskMapping || !priority) {
      return currentParentId;
    }

    const isUrgent = priority === 'critical' || priority === 'high';
    
    if (isUrgent && parentTaskMapping.urgent) {
      return parentTaskMapping.urgent;
    } else if (!isUrgent && parentTaskMapping.deferred !== undefined) {
      return parentTaskMapping.deferred;
    }

    return currentParentId;
  }

  /**
   * Route task and assign parent in one operation
   * 
   * @param priority - Task priority level
   * @param milestoneStrategy - Milestone routing strategy
   * @param parentTaskMapping - Parent task mapping configuration
   * @param currentMilestone - Current milestone assignment
   * @param currentParentId - Current parent task ID
   * @returns Complete routing result
   */
  routeTask(
    priority: TaskPriority | undefined,
    milestoneStrategy?: MilestoneStrategy,
    parentTaskMapping?: ParentTaskMapping,
    currentMilestone?: string,
    currentParentId?: string
  ): TaskRoutingResult {
    return {
      milestone_slug: this.routeToMilestone(priority, milestoneStrategy, currentMilestone),
      parent_task_id: this.assignParentTask(priority, parentTaskMapping, currentParentId)
    };
  }

  /**
   * Route task with behavior test logic
   * Includes fallback to backlog milestone with warnings
   * 
   * @param priority - Task priority level
   * @param context - Execution context with milestone IDs
   * @param currentMilestone - Current milestone assignment
   * @returns Milestone ID and warnings
   */
  routeWithFallback(
    priority: TaskPriority | undefined,
    context: {
      parent_milestone_id?: string;
      backlog_milestone_id?: string;
    },
    currentMilestone?: string
  ): { milestone_id: string | null | undefined; warnings: string[] } {
    const warnings: string[] = [];
    const isUrgent = priority === 'critical' || priority === 'high';

    if (isUrgent) {
      if (context.parent_milestone_id) {
        return { milestone_id: context.parent_milestone_id, warnings };
      } else if (context.backlog_milestone_id) {
        warnings.push('Parent milestone not found, routed to backlog milestone');
        return { milestone_id: context.backlog_milestone_id, warnings };
      } else {
        return { milestone_id: currentMilestone, warnings };
      }
    } else {
      return { 
        milestone_id: context.backlog_milestone_id || currentMilestone || null, 
        warnings 
      };
    }
  }
}
