import { DashboardClient } from "./DashboardClient.js";
import { ProjectAPI } from "./ProjectAPI.js";
import { logger } from "../logger.js";
import { fetch } from "undici";

export type CreateTaskInput = {
  projectId?: string;
  projectSlug?: string;
  milestoneId?: string;
  milestoneSlug?: string;
  parentTaskId?: string;
  title: string;
  description: string;
  effortEstimate?: number;
  priorityScore?: number;
  assigneePersona?: string;
  externalId?: string;
  attachments?: { name: string; content_base64: string }[];
  options?: Record<string, any> | null;
};

export type CreateTaskResult = {
  ok: boolean;
  status: number;
  body: any;
  error?: any;
  createdId?: string | null;
};


export class TaskAPI extends DashboardClient {
  private projectAPI: ProjectAPI;

  constructor() {
    super();
    this.projectAPI = new ProjectAPI();
  }

  
  async createDashboardTask(input: CreateTaskInput): Promise<CreateTaskResult | null> {
    if (!this.baseUrl) {
      logger.warn("dashboard task creation skipped: dashboard base URL not configured");
      return null;
    }

    
    const projectId = input.projectId;
    if (!projectId) {
      logger.warn("dashboard task creation failed: projectId required");
      return { ok: false, status: 400, body: { error: "projectId required" }, createdId: null };
    }

    const endpoint = `${this.baseUrl}/projects/${encodeURIComponent(projectId)}/tasks`;

    
    const maxTitleLen = 180;
    const maxDescLen = 10000;
    const safeTitle = String(input.title || "").slice(0, maxTitleLen);
    let safeDesc = String(input.description || "");
    if (safeDesc.length > maxDescLen) safeDesc = safeDesc.slice(0, maxDescLen) + "\n\n[truncated]";

    const body: Record<string, any> = {
      title: safeTitle,
      description: safeDesc,
    };

    

    
    let resolvedMilestoneId = input.milestoneId ?? null;
    if (!resolvedMilestoneId && input.milestoneSlug && projectId) {
      resolvedMilestoneId = await this.resolveMilestoneSlug(projectId, input.milestoneSlug);
    }

    
    if (resolvedMilestoneId) {
      body.milestone_id = Number(resolvedMilestoneId);
    }

    
    if (input.parentTaskId) {
      const isUuid = /^(?:[0-9a-fA-F]{8})-(?:[0-9a-fA-F]{4})-(?:[0-9a-fA-F]{4})-(?:[0-9a-fA-F]{4})-(?:[0-9a-fA-F]{12})$/.test(
        String(input.parentTaskId)
      );
      if (isUuid) {
        body.parent_task_id = Number(input.parentTaskId);
      } else {
        
        logger.warn("parent_task_external_id not supported by backend, skipping", { 
          parentTaskId: input.parentTaskId 
        });
      }
    }

    if (typeof input.effortEstimate === "number") body.effort_estimate = input.effortEstimate;
    if (typeof input.priorityScore === "number") body.priority_score = input.priorityScore;
    if (input.assigneePersona) body.assignee_persona = input.assigneePersona;
    if (input.externalId) body.external_id = input.externalId;
    if (input.attachments && Array.isArray(input.attachments)) body.attachments = input.attachments;

    const initialStatus =
      input.options && typeof input.options.initial_status === "string" && input.options.initial_status.trim().length
        ? input.options.initial_status.trim()
        : "open";
    
    if (initialStatus) body.status = initialStatus;

    try {
      const res = await fetch(endpoint, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${this.apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(body),
      });

      const status = res.status;
      let responseBody: any = null;
      try {
        const text = await res.text();
        responseBody = text ? JSON.parse(text) : null;
      } catch {
        responseBody = null;
      }

      if (!res.ok) {
        const safeBody = { ...body };
        if (safeBody.attachments) safeBody.attachments = `[${(safeBody.attachments as any[]).length} attachments]` as any;
        logger.warn("dashboard task creation failed", { status, endpoint, request: safeBody, response: responseBody ?? "<no-json>" });
        return { ok: false, status, body: responseBody, createdId: null };
      }

      const createdId = this.extractCreatedId(res, responseBody);
      logger.info("dashboard task created", {
        title: input.title,
        status,
        endpoint,
        projectId,
        milestoneId: input.milestoneId || null,
        milestoneSlug: input.milestoneSlug || null,
        parentTaskId: input.parentTaskId,
        createdId,
      });

      return { ok: true, status, body: responseBody, createdId };
    } catch (error) {
      logger.warn("dashboard task creation exception", { error, title: input.title });
      return { ok: false, status: 0, body: null, error };
    }
  }

  
  async fetchTask(taskId: string, projectId?: string): Promise<any | null> {
    if (!this.baseUrl) return null;
    if (!projectId) {
      logger.warn("fetchTask requires projectId for current backend");
      return null;
    }

    try {
      return await this.get(`/projects/${encodeURIComponent(projectId)}/tasks/${encodeURIComponent(taskId)}`);
    } catch (e) {
      logger.warn("fetchTask exception", { taskId, projectId, error: (e as Error).message });
      return null;
    }
  }

  
  async updateTaskStatus(
    taskId: string,
    status: string,
    projectId?: string,
    lockVersion?: number
  ): Promise<CreateTaskResult> {
    if (!this.baseUrl) {
      logger.warn("dashboard update skipped: base URL not configured");
      return { ok: false, status: 0, body: null };
    }

    
    if (!projectId) {
      throw new Error("updateTaskStatus: projectId is required");
    }

    const endpoint = `${this.baseUrl}/projects/${encodeURIComponent(projectId)}/tasks/${encodeURIComponent(taskId)}`;

    try {
      
      const first = await this.patchTaskStatus(endpoint, status, lockVersion ?? undefined);
      if (first.statusCode >= 200 && first.statusCode < 300) {
        logger.info("dashboard task updated", { taskId, projectId, status, statusCode: first.statusCode });
        return { ok: true, status: first.statusCode, body: first.responseBody } as any;
      }

      
      if (first.statusCode === 409 || first.statusCode === 422) {
        const retryResult = await this.retryWithFreshLock(endpoint, taskId, status, projectId);
        if (retryResult) return retryResult;
      }

      logger.warn("dashboard task update failed", {
        taskId,
        projectId,
        status,
        statusCode: first.statusCode,
        responseBody: first.responseBody,
      });
      return { ok: false, status: first.statusCode, body: first.responseBody };
    } catch (e) {
      logger.warn("dashboard task update exception", { taskId, status, error: (e as Error).message });
      return { ok: false, status: 0, body: null, error: e };
    }
  }

  
  private async resolveMilestoneSlug(projectId: string, milestoneSlug: string): Promise<string | null> {
    try {
      const milestones: any = await this.projectAPI.fetchProjectMilestones(projectId);
      if (!Array.isArray(milestones)) return null;

      const slug = (milestoneSlug || "").toString().toLowerCase();
      const match = milestones.find((m: any) => {
        if (!m) return false;
        const mslug = (m.slug || m.name || "")
          .toString()
          .toLowerCase()
          .replace(/[^a-z0-9]+/g, "-");
        if (mslug === slug) return true;
        const name = (m.name || "").toString().toLowerCase();
        if (name === (milestoneSlug || "").toString().toLowerCase()) return true;
        return false;
      });

      return match && match.id ? match.id : null;
    } catch (e) {
      logger.debug("milestone slug resolution failed", {
        projectId,
        milestoneSlug,
        error: (e as Error).message,
      });
      return null;
    }
  }

  
  private extractCreatedId(res: any, responseBody: any): string | null {
    try {
      if (responseBody && (responseBody.id || responseBody.task_id || (responseBody.task && responseBody.task.id))) {
        return String(responseBody.id || responseBody.task_id || responseBody.task.id);
      }

      const loc = res.headers.get("location") || res.headers.get("Location");
      if (loc && typeof loc === "string") {
        const parts = loc.split("/").filter(Boolean);
        const last = parts[parts.length - 1];
        if (last && last.length) return last;
      }
    } catch (e) {
      return null;
    }
    return null;
  }

  
  private async patchTaskStatus(
    endpoint: string,
    status: string,
    lv?: number | null
  ): Promise<{ statusCode: number; responseBody: any }> {
    const payload: any = { status };
    if (lv !== undefined && lv !== null) payload.lock_version = lv;

    const res = await fetch(endpoint, {
      method: "PATCH",
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(payload),
    });

    const statusCode = res.status;
    let responseBody: any = null;
    try {
      const text = await res.text();
      responseBody = text ? JSON.parse(text) : null;
    } catch {
      responseBody = null;
    }

    return { statusCode, responseBody };
  }

  
  private async retryWithFreshLock(
    endpoint: string,
    taskId: string,
    status: string,
    projectId: string
  ): Promise<CreateTaskResult | null> {
    try {
      const current = await this.fetchTask(taskId, projectId);
      const raw = current ? current.lock_version ?? current.lockVersion ?? current.LOCK_VERSION : undefined;
      const fetchedLv = raw !== undefined && raw !== null ? Number(raw) : undefined;

      if (fetchedLv !== undefined) {
        const second = await this.patchTaskStatus(endpoint, status, fetchedLv);
        if (second.statusCode >= 200 && second.statusCode < 300) {
          logger.info("dashboard task updated (retry with lock_version)", {
            taskId,
            status,
            statusCode: second.statusCode,
            usedLockVersion: fetchedLv,
          });
          return { ok: true, status: second.statusCode, body: second.responseBody } as any;
        }

        logger.warn("dashboard task update retry failed", {
          taskId,
          status,
          statusCode: second.statusCode,
          responseBody: second.responseBody,
          usedLockVersion: fetchedLv,
        });
        return { ok: false, status: second.statusCode, body: second.responseBody };
      }
    } catch (e) {
      logger.debug("dashboard task update: failed to fetch for retry", { taskId, error: (e as Error).message });
    }
    return null;
  }
}
