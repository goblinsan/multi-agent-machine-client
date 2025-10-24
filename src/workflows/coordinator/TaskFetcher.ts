import { ProjectAPI } from "../../dashboard/ProjectAPI.js";
import { logger } from "../../logger.js";

const projectAPI = new ProjectAPI();

/**
 * Helper class for fetching, extracting, and normalizing project tasks
 */
export class TaskFetcher {
  /**
   * Fetch project tasks from the dashboard API
   */
  async fetchTasks(projectId: string): Promise<any[]> {
    return await projectAPI.fetchProjectTasks(projectId);
  }

  /**
   * Extract tasks from project information
   */
  extractTasks(details: any, projectInfo: any): any[] {
    const tasks: any[] = [];
    
    // Extract from milestones first
    if (details && Array.isArray(details.milestones) && details.milestones.length) {
      for (const milestone of details.milestones) {
        const milestoneTasks = Array.isArray(milestone?.tasks) ? milestone.tasks : [];
        for (const task of milestoneTasks) {
          tasks.push({ ...task, milestone });
        }
      }
    } else {
      // Fallback to direct tasks
      const directTasks = Array.isArray(projectInfo?.tasks) ? projectInfo.tasks : [];
      tasks.push(...directTasks);
    }
    
    return tasks;
  }

  /**
   * Normalize task status to standard values
   */
  normalizeTaskStatus(status: string): string {
    if (!status) return 'unknown';
    
    const normalized = String(status).toLowerCase().trim();
    
    if (['done', 'completed', 'finished', 'closed', 'resolved'].includes(normalized)) {
      return 'done';
    }
    
    if (['in_progress', 'in-progress', 'inprogress', 'active', 'working'].includes(normalized)) {
      return 'in_progress';
    }
    
    if (['open', 'new', 'todo', 'pending', 'ready'].includes(normalized)) {
      return 'open';
    }
    
    if (['blocked', 'stuck', 'waiting'].includes(normalized)) {
      return 'blocked';
    }
    
    if (['review', 'in_review', 'in-review', 'in review'].includes(normalized)) {
      return 'in_review';
    }
    
    return 'unknown';
  }

  /**
   * Compare tasks by priority for sorting
   * Priority order: blocked (0) > in_review (1) > in_progress (2) > open (3)
   */
  compareTaskPriority(a: any, b: any): number {
    // FIRST: Check for explicit priority_score (higher score = higher priority)
    // This allows urgent follow-up tasks (e.g., priority_score: 1000) to jump ahead
    const scoreA = a?.priority_score ?? a?.priorityScore ?? 0;
    const scoreB = b?.priority_score ?? b?.priorityScore ?? 0;
    
    if (scoreA !== scoreB) {
      return scoreB - scoreA;  // Higher score first (descending)
    }
    
    // SECOND: Use status-based priority
    const priorityA = this.getTaskPriority(a);
    const priorityB = this.getTaskPriority(b);
    
    // Lower number = higher priority, so sort ascending
    if (priorityA !== priorityB) {
      return priorityA - priorityB;
    }
    
    // THIRD: If same priority, sort by task order/position if available
    const orderA = a?.order ?? a?.position ?? a?.rank ?? Infinity;
    const orderB = b?.order ?? b?.position ?? b?.rank ?? Infinity;
    
    return orderA - orderB;
  }

  /**
   * Get numeric priority for a task status
   * Lower number = higher priority
   */
  private getTaskPriority(task: any): number {
    const status = task?.status;
    if (!status) return 3;  // Default to "open" priority
    
    const normalized = String(status).toLowerCase().trim().replace(/[^a-z0-9]+/g, '_');
    
    // Priority map: blocked > in_review > in_progress > open
    const priorityMap: Record<string, number> = {
      blocked: 0,
      stuck: 0,
      review: 1,
      in_review: 1,
      in_code_review: 1,
      in_security_review: 1,
      ready: 1,
      in_progress: 2,
      active: 2,
      doing: 2,
      working: 2,
      open: 3,
      planned: 3,
      backlog: 3,
      todo: 3,
      not_started: 3,
      waiting: 4,
      pending: 4,
      qa: 4,
      testing: 4
    };
    
    if (normalized in priorityMap) {
      return priorityMap[normalized];
    }
    
    // Fallback pattern matching
    if (normalized.includes('block') || normalized.includes('stuck')) return 0;
    if (normalized.includes('review')) return 1;
    if (normalized.includes('progress') || normalized.includes('doing') || normalized.includes('work') || normalized.includes('active')) return 2;
    
    return 3;  // Default to "open" priority
  }

  /**
   * Get count of remaining tasks for a project
   */
  async getRemainingTaskCount(projectId: string): Promise<number> {
    try {
      const projectInfo = await projectAPI.fetchProjectStatus(projectId);
      const details = await projectAPI.fetchProjectStatusDetails(projectId).catch(() => null);
      const tasks = this.extractTasks(details, projectInfo);
      const pendingTasks = tasks.filter(task => this.normalizeTaskStatus(task?.status) !== 'done');
      return pendingTasks.length;
    } catch (error) {
      logger.error('Failed to get remaining task count', { projectId, error });
      return 0;
    }
  }
}
