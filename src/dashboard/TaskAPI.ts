import { DashboardClient } from "./DashboardClient.js";
import { ProjectAPI } from "./ProjectAPI.js";
import { logger } from "../logger.js";
import { cfg } from "../config.js";
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

/**
 * Task CRUD operations for Dashboard API
 */
export class TaskAPI extends DashboardClient {
  private projectAPI: ProjectAPI;

  constructor() {
    super();
    this.projectAPI = new ProjectAPI();
  }

  /**
   * Create a new dashboard task with comprehensive error handling and milestone resolution
   */
  async createDashboardTask(input: CreateTaskInput): Promise<CreateTaskResult | null> {
    if (!this.baseUrl) {
      logger.warn("dashboard task creation skipped: dashboard base URL not configured");
      return null;
    }

    const defaultEndpoint = `${this.baseUrl}/v1/tasks`;
    const upsertEndpoint = `${this.baseUrl}/v1/tasks:upsert`;

    // Sanitize inputs
    const maxTitleLen = 180;
    const maxDescLen = 10000;
    const safeTitle = String(input.title || "").slice(0, maxTitleLen);
    let safeDesc = String(input.description || "");
    if (safeDesc.length > maxDescLen) safeDesc = safeDesc.slice(0, maxDescLen) + "\n\n[truncated]";

    const body: Record<string, any> = {
      title: safeTitle,
      description: safeDesc,
    };

    if (input.projectId) body.project_id = input.projectId;
    if (input.projectSlug) body.project_slug = input.projectSlug;

    // Resolve milestone slug to ID if needed
    let resolvedMilestoneId = input.milestoneId ?? null;
    if (!resolvedMilestoneId && input.milestoneSlug && input.projectId) {
      resolvedMilestoneId = await this.resolveMilestoneSlug(input.projectId, input.milestoneSlug);
    }

    // Handle milestone ID/slug
    if (resolvedMilestoneId) {
      body.milestone_id = resolvedMilestoneId;
    } else if (input.milestoneSlug) {
      body.milestone_slug = input.milestoneSlug;

      // Enable auto-create if milestone not resolved to ID
      if (!input.options) {
        body.options = { create_milestone_if_missing: true };
        logger.debug("Milestone not resolved to ID, enabling auto-create", {
          milestoneSlug: input.milestoneSlug,
          projectId: input.projectId,
        });
      } else if (!input.options.create_milestone_if_missing) {
        body.options = { ...input.options, create_milestone_if_missing: true };
        logger.debug("Milestone not resolved to ID, overriding create_milestone_if_missing to true", {
          milestoneSlug: input.milestoneSlug,
          projectId: input.projectId,
          originalValue: input.options.create_milestone_if_missing,
        });
      }

      // Check auto-create policy
      if (body.options && body.options.create_milestone_if_missing) {
        const norm = (input.milestoneSlug || "")
          .toString()
          .trim()
          .toLowerCase()
          .replace(/[^a-z0-9]+/g, "-")
          .replace(/^-+|-+$/g, "");
        const allowOnlyFuture =
          typeof cfg.dashboardAutoCreateFutureEnhancementsOnly === "boolean"
            ? cfg.dashboardAutoCreateFutureEnhancementsOnly
            : true;
        if (
          allowOnlyFuture &&
          !(norm === "future-enhancements" || norm === "future-enhancement" || norm === "future_enhancements" || norm === "future")
        ) {
          logger.info("milestone auto-create policy would block non-future slug", {
            requested: input.milestoneSlug,
            projectId: input.projectId,
          });
        }
      }
    }

    // Handle parent task ID
    if (input.parentTaskId) {
      const isUuid = /^(?:[0-9a-fA-F]{8})-(?:[0-9a-fA-F]{4})-(?:[0-9a-fA-F]{4})-(?:[0-9a-fA-F]{4})-(?:[0-9a-fA-F]{12})$/.test(
        String(input.parentTaskId)
      );
      if (isUuid) body.parent_task_id = input.parentTaskId;
      else body.parent_task_external_id = input.parentTaskId;
    }

    if (typeof input.effortEstimate === "number") body.effort_estimate = input.effortEstimate;
    if (typeof input.priorityScore === "number") body.priority_score = input.priorityScore;
    if (input.assigneePersona) body.assignee_persona = input.assigneePersona;
    if (input.externalId) body.external_id = input.externalId;
    if (input.attachments && Array.isArray(input.attachments)) body.attachments = input.attachments;
    if (input.options) body.options = input.options;

    const initialStatus =
      input.options && typeof input.options.initial_status === "string" && input.options.initial_status.trim().length
        ? input.options.initial_status.trim()
        : null;

    try {
      const useUpsert = Boolean(input.externalId);
      const endpoint = useUpsert ? upsertEndpoint : defaultEndpoint;
      const requestBody = { ...body } as any;
      if (!useUpsert && initialStatus) requestBody.initial_status = initialStatus;

      const res = await fetch(endpoint, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${this.apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(requestBody),
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
        const safeBody = { ...requestBody };
        if (safeBody.attachments) safeBody.attachments = `[${(safeBody.attachments as any[]).length} attachments]` as any;
        logger.warn("dashboard task creation failed", { status, endpoint, request: safeBody, response: responseBody ?? "<no-json>" });

        // Fallback to legacy endpoint if upsert not supported
        if (useUpsert && (status === 404 || status === 405 || (status >= 500 && status < 600))) {
          return await this.createTaskLegacy(body, initialStatus);
        }

        return { ok: false, status, body: responseBody, createdId: null };
      }

      const createdId = this.extractCreatedId(res, responseBody);
      logger.info("dashboard task created", {
        title: input.title,
        status,
        endpoint,
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

  /**
   * Fetch a task by ID
   */
  async fetchTask(taskId: string): Promise<any | null> {
    if (!this.baseUrl) return null;

    try {
      return await this.get(`/v1/tasks/${encodeURIComponent(taskId)}`);
    } catch (e) {
      logger.warn("fetchTask exception", { taskId, error: (e as Error).message });
      return null;
    }
  }

  /**
   * Update task status with optimistic concurrency control
   */
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

    // Legacy compatibility: try external_id path if no projectId
    if (!projectId) {
      return await this.updateTaskStatusLegacy(taskId, status);
    }

    const endpoint = `${this.baseUrl}/projects/${encodeURIComponent(projectId)}/tasks/${encodeURIComponent(taskId)}`;

    try {
      // First attempt with provided lockVersion
      const first = await this.patchTaskStatus(endpoint, status, lockVersion ?? undefined);
      if (first.statusCode >= 200 && first.statusCode < 300) {
        logger.info("dashboard task updated", { taskId, projectId, status, statusCode: first.statusCode });
        return { ok: true, status: first.statusCode, body: first.responseBody } as any;
      }

      // Handle concurrency conflict: retry with fresh lock version
      if (first.statusCode === 409 || first.statusCode === 422) {
        const retryResult = await this.retryWithFreshLock(endpoint, taskId, status);
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

  /**
   * Resolve milestone slug to ID
   */
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

  /**
   * Extract created task ID from response
   */
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

  /**
   * Legacy task creation fallback
   */
  private async createTaskLegacy(body: Record<string, any>, initialStatus: string | null): Promise<CreateTaskResult> {
    try {
      const legacyBody = { ...body } as any;
      if (initialStatus) legacyBody.initial_status = initialStatus;

      const res2 = await fetch(`${this.baseUrl}/v1/tasks`, {
        method: "POST",
        headers: { Authorization: `Bearer ${this.apiKey}`, "Content-Type": "application/json" },
        body: JSON.stringify(legacyBody),
      });

      const status2 = res2.status;
      let rb2: any = null;
      try {
        const t2 = await res2.text();
        rb2 = t2 ? JSON.parse(t2) : null;
      } catch {
        rb2 = null;
      }

      if (!res2.ok) {
        logger.warn("dashboard task creation failed (legacy fallback)", {
          status: status2,
          endpoint: `${this.baseUrl}/v1/tasks`,
          body: body.title,
          response: rb2,
        });
        return { ok: false, status: status2, body: rb2, createdId: null };
      }

      const createdId2 = this.extractCreatedId(res2, rb2);
      logger.info("dashboard task created (legacy fallback)", { title: body.title, status: status2, createdId: createdId2 });
      return { ok: true, status: status2, body: rb2, createdId: createdId2 };
    } catch (e) {
      logger.warn("dashboard task creation exception (legacy fallback)", { error: e, title: body.title });
      return { ok: false, status: 0, body: null, error: e };
    }
  }

  /**
   * PATCH task status
   */
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

  /**
   * Retry update with fresh lock version
   */
  private async retryWithFreshLock(
    endpoint: string,
    taskId: string,
    status: string
  ): Promise<CreateTaskResult | null> {
    try {
      const current = await this.fetchTask(taskId);
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

  /**
   * Legacy update by external_id
   */
  private async updateTaskStatusLegacy(taskId: string, status: string): Promise<CreateTaskResult> {
    try {
      // Try updating by external_id
      const byExternalUrl = `${this.baseUrl}/v1/tasks/by-external/${encodeURIComponent(taskId)}/status`;
      let res = await fetch(byExternalUrl, {
        method: "POST",
        headers: { Authorization: `Bearer ${this.apiKey}`, "Content-Type": "application/json" },
        body: JSON.stringify({ status }),
      });

      if (res.ok) {
        const body = await res.json().catch(() => ({}));
        logger.info("dashboard task updated by external_id", { external_id: taskId, status });
        return { ok: true, status: res.status, body } as any;
      }

      // Resolve external_id to canonical ID then update
      const resolveUrl = `${this.baseUrl}/v1/tasks/resolve`;
      const resolveRes = await fetch(resolveUrl, {
        method: "POST",
        headers: { Authorization: `Bearer ${this.apiKey}`, "Content-Type": "application/json" },
        body: JSON.stringify({ external_id: taskId }),
      });

      const resolveBody = await resolveRes.json().catch(() => ({}));
      const rb: any = resolveBody as any;
      const resolvedId = rb && (rb.id || rb.task_id) ? rb.id || rb.task_id : null;

      if (resolvedId) {
        const byIdUrl = `${this.baseUrl}/v1/tasks/${encodeURIComponent(String(resolvedId))}/status`;
        const byId = await fetch(byIdUrl, {
          method: "POST",
          headers: { Authorization: `Bearer ${this.apiKey}`, "Content-Type": "application/json" },
          body: JSON.stringify({ status }),
        });
        const byIdBody = await byId.json().catch(() => ({}));

        if (byId.ok) {
          logger.info("dashboard task updated by resolved id", { external_id: taskId, resolvedId });
          return { ok: true, status: byId.status, body: byIdBody } as any;
        }
      }

      return { ok: false, status: 404, body: null };
    } catch (e) {
      logger.warn("legacy updateTaskStatus flow failed", { taskId, error: (e as Error).message });
      return { ok: false, status: 0, body: null, error: e } as any;
    }
  }
}
