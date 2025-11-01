import { TaskPriority } from "./TaskPriorityCalculator.js";

export interface MilestoneStrategy {
  urgent?: string;
  deferred?: string;
}

export interface ParentTaskMapping {
  urgent?: string;
  deferred?: string | null;
}

export interface TaskRoutingResult {
  milestone_slug?: string;
  parent_task_id?: string | null;
}

export class TaskRouter {
  routeToMilestone(
    priority: TaskPriority | undefined,
    milestoneStrategy?: MilestoneStrategy,
    currentMilestone?: string,
  ): string | undefined {
    if (!milestoneStrategy || !priority) {
      return currentMilestone;
    }

    const isUrgent = priority === "critical" || priority === "high";

    if (isUrgent && milestoneStrategy.urgent) {
      return milestoneStrategy.urgent;
    } else if (!isUrgent && milestoneStrategy.deferred) {
      return milestoneStrategy.deferred;
    }

    return currentMilestone;
  }

  assignParentTask(
    priority: TaskPriority | undefined,
    parentTaskMapping?: ParentTaskMapping,
    currentParentId?: string,
  ): string | null | undefined {
    if (!parentTaskMapping || !priority) {
      return currentParentId;
    }

    const isUrgent = priority === "critical" || priority === "high";

    if (isUrgent && parentTaskMapping.urgent) {
      return parentTaskMapping.urgent;
    } else if (!isUrgent && parentTaskMapping.deferred !== undefined) {
      return parentTaskMapping.deferred;
    }

    return currentParentId;
  }

  routeTask(
    priority: TaskPriority | undefined,
    milestoneStrategy?: MilestoneStrategy,
    parentTaskMapping?: ParentTaskMapping,
    currentMilestone?: string,
    currentParentId?: string,
  ): TaskRoutingResult {
    return {
      milestone_slug: this.routeToMilestone(
        priority,
        milestoneStrategy,
        currentMilestone,
      ),
      parent_task_id: this.assignParentTask(
        priority,
        parentTaskMapping,
        currentParentId,
      ),
    };
  }

  routeWithFallback(
    priority: TaskPriority | undefined,
    context: {
      parent_milestone_id?: string;
      backlog_milestone_id?: string;
    },
    currentMilestone?: string,
  ): { milestone_id: string | null | undefined; warnings: string[] } {
    const warnings: string[] = [];
    const isUrgent = priority === "critical" || priority === "high";

    if (isUrgent) {
      if (context.parent_milestone_id) {
        return { milestone_id: context.parent_milestone_id, warnings };
      } else if (context.backlog_milestone_id) {
        warnings.push(
          "Parent milestone not found, routed to backlog milestone",
        );
        return { milestone_id: context.backlog_milestone_id, warnings };
      } else {
        return { milestone_id: currentMilestone, warnings };
      }
    } else {
      return {
        milestone_id: context.backlog_milestone_id || currentMilestone || null,
        warnings,
      };
    }
  }
}
