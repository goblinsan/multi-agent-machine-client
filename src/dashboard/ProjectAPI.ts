import { DashboardClient } from "./DashboardClient.js";
import { logger } from "../logger.js";


export class ProjectAPI extends DashboardClient {
  
  async fetchProjectStatus(projectId: string | null | undefined): Promise<any | null> {
    if (!projectId) return null;

    try {
      return await this.get(`/projects/${encodeURIComponent(projectId)}`);
    } catch (e) {
      logger.warn("fetchProjectStatus failed", { projectId, error: (e as Error).message });
      return null;
    }
  }

  
  async fetchProjectMilestones(projectId: string | null | undefined): Promise<any[] | null> {
    if (!projectId) return null;

    try {
      const data = await this.get(`/projects/${encodeURIComponent(projectId)}/milestones`);
      if (!data) return null;

      
      if (Array.isArray(data)) return data;
      if (data && typeof data === "object" && Array.isArray((data as any).milestones)) {
        return (data as any).milestones;
      }

      return null;
    } catch (e) {
      logger.warn("fetchProjectMilestones failed", { projectId, error: (e as Error).message });
      return null;
    }
  }

  
  async fetchProjectStatusDetails(projectId: string | null | undefined): Promise<any | null> {
    if (!projectId) return null;

    try {
      return await this.get(`/projects/${encodeURIComponent(projectId)}/status`);
    } catch (e) {
      logger.warn("fetchProjectStatusDetails failed", { projectId, error: (e as Error).message });
      return null;
    }
  }

  
  async fetchProjectStatusSummary(projectId: string | null | undefined): Promise<string | null> {
    if (!projectId) return null;

    try {
      const data = await this.get(`/projects/${encodeURIComponent(projectId)}/status/summary`);
      if (!data) return null;

      
      if (typeof data === "string") return data;
      if (data && typeof data === "object" && typeof (data as any).summary === "string") {
        return (data as any).summary;
      }

      return null;
    } catch (e) {
      logger.warn("fetchProjectStatusSummary failed", { projectId, error: (e as Error).message });
      return null;
    }
  }

  
  async fetchProjectTasks(projectId: string): Promise<any[]> {
    if (!projectId) {
      logger.warn("fetchProjectTasks skipped: no projectId provided");
      return [];
    }

    try {
      const url = `/projects/${encodeURIComponent(projectId)}/tasks`;
      const data = await this.get(url);

      if (!data) return [];

      
      const tasks = Array.isArray(data) ? data : ((data as any)?.data || []);
      return Array.isArray(tasks) ? tasks : [];
    } catch (e) {
      logger.warn("fetchProjectTasks exception", { projectId, error: (e as Error).message });
      return [];
    }
  }
}
