import { ProjectAPI } from "../../dashboard/ProjectAPI.js";
import { logger } from "../../logger.js";

const projectAPI = new ProjectAPI();


export class TaskFetcher {
  
  async fetchTasks(projectId: string): Promise<any[]> {
    const tasks = await projectAPI.fetchProjectTasks(projectId);
    
    logger.debug('TaskFetcher: Fetched tasks from dashboard', {
      projectId,
      taskCount: tasks.length,
      taskIds: tasks.map(t => t?.id).filter(Boolean).slice(0, 10)
    });
    
    return tasks;
  }

  

  
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

  
  compareTaskPriority(a: any, b: any): number {
    
    
    const scoreA = a?.priority_score ?? a?.priorityScore ?? 0;
    const scoreB = b?.priority_score ?? b?.priorityScore ?? 0;
    
    if (scoreA !== scoreB) {
      return scoreB - scoreA;
    }
    
    
    const priorityA = this.getTaskPriority(a);
    const priorityB = this.getTaskPriority(b);
    
    
    if (priorityA !== priorityB) {
      return priorityA - priorityB;
    }
    
    
    const orderA = a?.order ?? a?.position ?? a?.rank ?? Infinity;
    const orderB = b?.order ?? b?.position ?? b?.rank ?? Infinity;
    
    return orderA - orderB;
  }

  
  private getTaskPriority(task: any): number {
    const status = task?.status;
    if (!status) return 3;
    
    const normalized = String(status).toLowerCase().trim().replace(/[^a-z0-9]+/g, '_');
    
    
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
    
    
    if (normalized.includes('block') || normalized.includes('stuck')) return 0;
    if (normalized.includes('review')) return 1;
    if (normalized.includes('progress') || normalized.includes('doing') || normalized.includes('work') || normalized.includes('active')) return 2;
    
    return 3;
  }

  
  async getRemainingTaskCount(projectId: string): Promise<number> {
    try {
      const tasks = await this.fetchTasks(projectId);
      const pendingTasks = tasks.filter((task: any) => this.normalizeTaskStatus(task?.status) !== 'done');
      return pendingTasks.length;
    } catch (error) {
      logger.error('Failed to get remaining task count', { projectId, error });
      return 0;
    }
  }
}
