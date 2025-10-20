import { cfg } from "./config.js";
import { fetch } from "undici";
import { logger } from "./logger.js";

export async function fetchContext(workflowId: string) {
  try {
    // Use context-by-workflow endpoint if available in cfg.dashboardContextEndpoint (overrideable)
    if (cfg.dashboardContextEndpoint && cfg.dashboardContextEndpoint.startsWith('http')) {
      const url = new URL(cfg.dashboardContextEndpoint);
      url.searchParams.set('workflow_id', workflowId);
      url.searchParams.set('limit', '5');
      const r = await fetch(url.toString(), {
        headers: { "Authorization": `Bearer ${cfg.dashboardApiKey}` }
      });
      if (!r.ok) throw new Error(`dashboard ${r.status}`);
      const data = await r.json();
      return data;
    }

    const r = await fetch(`${cfg.dashboardBaseUrl.replace(/\/$/, '')}/context/by-workflow?workflow_id=${encodeURIComponent(workflowId)}&limit=5`, {
      headers: { "Authorization": `Bearer ${cfg.dashboardApiKey}` }
    });
    if (!r.ok) throw new Error(`dashboard ${r.status}`);
    const data = await r.json();
    return data;
  } catch {
    return { projectTree: "", fileHotspots: "", limits: "", personaHints: "" };
  }
}

export async function fetchProjectStatus(projectId: string | null | undefined) {
  if (!projectId) return null;
  try {
    const res = await fetch(`${cfg.dashboardBaseUrl.replace(/\/$/, "")}/projects/${encodeURIComponent(projectId)}`, {
      headers: { "Authorization": `Bearer ${cfg.dashboardApiKey}` }
    });
    if (!res.ok) throw new Error(`dashboard ${res.status}`);
    return await res.json();
  } catch (e) {
    logger.warn("fetch project status failed", { projectId, error: (e as Error).message });
    return null;
  }
}

export async function fetchProjectMilestones(projectId: string | null | undefined) {
  if (!projectId) return null;
  try {
    const base = cfg.dashboardBaseUrl.replace(/\/$/, "");
    // Updated API: GET /v1/projects/{project_id}/milestones
    const res = await fetch(`${base}/v1/projects/${encodeURIComponent(projectId)}/milestones?limit=100`, {
      headers: { "Authorization": `Bearer ${cfg.dashboardApiKey}` }
    });
    if (!res.ok) {
      logger.debug('fetchProjectMilestones non-ok', { projectId, status: res.status });
      return null;
    }
    const body = await res.json().catch(() => null);
    // Normalize to an array of milestone objects
    const list = Array.isArray(body)
      ? body
      : (Array.isArray((body as any)?.milestones) ? (body as any).milestones
        : (Array.isArray((body as any)?.items) ? (body as any).items
          : (Array.isArray((body as any)?.milestones?.items) ? (body as any).milestones.items : null)));
    return list ?? null;
  } catch (e) {
    logger.warn('fetchProjectMilestones failed', { projectId, error: (e as Error).message });
    return null;
  }
}

export async function fetchProjectStatusDetails(projectId: string | null | undefined) {
  if (!projectId) return null;
  try {
    const base = cfg.dashboardBaseUrl.replace(/\/$/, "");
    const res = await fetch(`${base}/projects/${encodeURIComponent(projectId)}/status`, {
      headers: { "Authorization": `Bearer ${cfg.dashboardApiKey}` }
    });
    if (!res.ok) throw new Error(`dashboard ${res.status}`);
    return await res.json();
  } catch (e) {
    logger.warn("fetch project status details failed", { projectId, error: (e as Error).message });
    return null;
  }
}

export async function fetchProjectNextAction(projectId: string | null | undefined) {
  if (!projectId) return null;
  try {
    const base = cfg.dashboardBaseUrl.replace(/\/$/, "");
    const res = await fetch(`${base}/v1/projects/${encodeURIComponent(projectId)}/next-action`, {
      headers: { "Authorization": `Bearer ${cfg.dashboardApiKey}` }
    });
    if (!res.ok) throw new Error(`dashboard ${res.status}`);
    return await res.json();
  } catch (e) {
    logger.warn("fetch project next-action failed", { projectId, error: (e as Error).message });
    return null;
  }
}

// Try to fetch a concise project status summary. Falls back to next-action suggestions or project read data.
export async function fetchProjectStatusSummary(projectId: string | null | undefined) {
  if (!projectId) return null;
  try {
    const base = cfg.dashboardBaseUrl.replace(/\/$/, "");
    // preferred endpoint
    const res = await fetch(`${base}/v1/projects/${encodeURIComponent(projectId)}/status/summary`, {
      headers: { "Authorization": `Bearer ${cfg.dashboardApiKey}` }
    });
    if (res.ok) {
      const data: any = await res.json().catch(() => null);
      // ProjectStatusSummary has 'summary' field
      if (data && typeof data.summary === 'string') return data.summary;
    }
  } catch (e) {
    // ignore
  }

  // fallback: try next-action suggestions
  try {
    const nextAction: any = await fetchProjectNextAction(projectId);
    if (nextAction && Array.isArray(nextAction.suggestions) && nextAction.suggestions.length) {
      const top: any = nextAction.suggestions[0];
      const reason = top.reason || top.title || '';
      return `Next suggested action: ${top.title || '(no title)'} — ${reason}`;
    }
  } catch (e) {
    // ignore
  }

  // last resort: fetch project basic info
  try {
    const p: any = await fetchProjectStatus(projectId);
    if (p) {
      const goal = p.goal || p.direction || "";
      return `Project goal: ${goal}`;
    }
  } catch (e) {
    // ignore
  }

  return null;
}

export async function recordEvent(ev: any) {
  try {
    const endpoint = `${cfg.dashboardBaseUrl.replace(/\/$/, '')}/v1/events`;
    await fetch(endpoint, {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${cfg.dashboardApiKey}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify(ev)
    });
  } catch (e) {
    logger.warn("dashboard event post failed", { error: e, event: ev });
  }
}

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

export async function createDashboardTask(input: CreateTaskInput): Promise<CreateTaskResult | null> {
  if (!cfg.dashboardBaseUrl) {
    logger.warn("dashboard task creation skipped: dashboard base URL not configured");
    return null;
  }
  const base = cfg.dashboardBaseUrl.replace(/\/$/, "");
  const defaultEndpoint = `${base}/v1/tasks`;
  // Prefer upsert when we have an external_id to avoid duplicates and simplify id resolution
  const upsertEndpoint = `${base}/v1/tasks:upsert`;
  // Sanitize potentially large or noisy inputs to reduce server 5xx risk
  const maxTitleLen = 180;
  const maxDescLen = 10000;
  const safeTitle = String(input.title || '').slice(0, maxTitleLen);
  let safeDesc = String(input.description || '');
  if (safeDesc.length > maxDescLen) safeDesc = safeDesc.slice(0, maxDescLen) + "\n\n[truncated]";

  const body: Record<string, any> = {
    title: safeTitle,
    description: safeDesc
  };
  if (input.projectId) body.project_id = input.projectId;
  if (input.projectSlug) body.project_slug = input.projectSlug;
  // If caller provided a milestone slug but not an id, try to resolve it to the canonical milestone id
  let resolvedMilestoneId = input.milestoneId ?? null;
  if (!resolvedMilestoneId && input.milestoneSlug && input.projectId) {
    try {
      const milestones: any = await fetchProjectMilestones(input.projectId);
      if (Array.isArray(milestones)) {
        const slug = (input.milestoneSlug || '').toString().toLowerCase();
        const match = milestones.find((m: any) => {
          if (!m) return false;
          const mslug = (m.slug || (m.name || '')).toString().toLowerCase().replace(/[^a-z0-9]+/g, '-');
          if (mslug === slug) return true;
          const name = (m.name || '').toString().toLowerCase();
          if (name === (input.milestoneSlug || '').toString().toLowerCase()) return true;
          return false;
        });
        if (match && match.id) resolvedMilestoneId = match.id;
      }
    } catch (e) {
      // ignore resolution failures and fall back to sending slug
      logger.debug('milestone slug resolution failed', { projectId: input.projectId, milestoneSlug: input.milestoneSlug, error: (e as Error).message });
    }
  }
  if (resolvedMilestoneId) body.milestone_id = resolvedMilestoneId;
  else if (input.milestoneSlug) {
    // Always send milestone_slug when provided so the server can resolve it; auto-create is controlled separately via options
    body.milestone_slug = input.milestoneSlug;
    
    // IMPORTANT: If we couldn't resolve milestone_slug to an ID, we MUST enable create_milestone_if_missing
    // to avoid 422 "Unknown milestone_slug" errors from the dashboard API.
    // This happens when:
    // 1. Using 'future-enhancements' for backlog tasks on first use
    // 2. The milestone doesn't exist yet in the project
    // 3. The dashboard API requires EITHER the milestone exists OR create_milestone_if_missing=true
    if (!input.options) {
      body.options = { create_milestone_if_missing: true };
      logger.debug('Milestone not resolved to ID, enabling auto-create', {
        milestoneSlug: input.milestoneSlug,
        projectId: input.projectId
      });
    } else if (!input.options.create_milestone_if_missing) {
      // Caller provided options but didn't set create_milestone_if_missing
      // Override to true since we're using an unresolved slug
      body.options = { ...input.options, create_milestone_if_missing: true };
      logger.debug('Milestone not resolved to ID, overriding create_milestone_if_missing to true', {
        milestoneSlug: input.milestoneSlug,
        projectId: input.projectId,
        originalValue: input.options.create_milestone_if_missing
      });
    }
    
    // Optionally log if auto-create would be blocked by policy; server may still accept existing slug
    if (body.options && body.options.create_milestone_if_missing) {
      const norm = (input.milestoneSlug || '').toString().trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
      const allowOnlyFuture = (typeof cfg.dashboardAutoCreateFutureEnhancementsOnly === 'boolean') ? cfg.dashboardAutoCreateFutureEnhancementsOnly : true;
      if (allowOnlyFuture && !(norm === 'future-enhancements' || norm === 'future-enhancement' || norm === 'future_enhancements' || norm === 'future')) {
        logger.info('milestone auto-create policy would block non-future slug', { requested: input.milestoneSlug, projectId: input.projectId });
      }
    }
  }
  // Only send parent_task_id if it's a UUID; otherwise, prefer external linkage when supported
  if (input.parentTaskId) {
    const isUuid = /^(?:[0-9a-fA-F]{8})-(?:[0-9a-fA-F]{4})-(?:[0-9a-fA-F]{4})-(?:[0-9a-fA-F]{4})-(?:[0-9a-fA-F]{12})$/.test(String(input.parentTaskId));
    if (isUuid) body.parent_task_id = input.parentTaskId;
    else body.parent_task_external_id = input.parentTaskId; // tolerated by updated API; ignored by older servers
  }
  if (typeof input.effortEstimate === "number") body.effort_estimate = input.effortEstimate;
  if (typeof input.priorityScore === "number") body.priority_score = input.priorityScore;
  if (input.assigneePersona) body.assignee_persona = input.assigneePersona;
  if (input.externalId) body.external_id = input.externalId;
  if (input.attachments && Array.isArray(input.attachments)) body.attachments = input.attachments;
  if (input.options) body.options = input.options;
  // For legacy POST /v1/tasks some dashboards accept initial_status at top level; we'll include it only for that path.
  const initialStatus = (input.options && typeof input.options.initial_status === 'string' && input.options.initial_status.trim().length)
    ? input.options.initial_status.trim()
    : null;

  try {
    // Choose endpoint: use upsert when external_id is present; otherwise fallback to simple create
    const useUpsert = Boolean(input.externalId);
    const endpoint = useUpsert ? upsertEndpoint : defaultEndpoint;
    // For upsert, keep initial status under options; for legacy create, also include top-level initial_status if requested
    const requestBody = { ...body } as any;
    if (!useUpsert && initialStatus) requestBody.initial_status = initialStatus;

    const res = await fetch(endpoint, {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${cfg.dashboardApiKey}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify(requestBody)
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
      // Include more context: request body keys and plain text when JSON parse fails
      const safeBody = { ...requestBody };
      if (safeBody.attachments) safeBody.attachments = `[${(safeBody.attachments as any[]).length} attachments]` as any;
      logger.warn("dashboard task creation failed", { status, endpoint, request: safeBody, response: responseBody ?? '<no-json>' });
      // If upsert not supported (e.g., 404/405), try falling back to legacy create once
      if (useUpsert && (status === 404 || status === 405 || (status >= 500 && status < 600))) {
        try {
          const legacyBody = { ...body } as any;
          if (initialStatus) legacyBody.initial_status = initialStatus;
          const res2 = await fetch(defaultEndpoint, {
            method: "POST",
            headers: { "Authorization": `Bearer ${cfg.dashboardApiKey}`, "Content-Type": "application/json" },
            body: JSON.stringify(legacyBody)
          });
          const status2 = res2.status;
          let rb2: any = null; try { const t2 = await res2.text(); rb2 = t2 ? JSON.parse(t2) : null; } catch { rb2 = null; }
          if (!res2.ok) {
            logger.warn("dashboard task creation failed (legacy fallback)", { status: status2, endpoint: defaultEndpoint, body: body.title, response: rb2 });
            return { ok: false, status: status2, body: rb2, createdId: null };
          }
          let createdId2: string | null = null;
          try {
            if (rb2 && (rb2.id || rb2.task_id || (rb2.task && rb2.task.id))) createdId2 = String(rb2.id || rb2.task_id || rb2.task.id);
            else {
              const loc2 = res2.headers.get("location") || res2.headers.get("Location");
              if (loc2 && typeof loc2 === 'string') {
                const parts = loc2.split('/').filter(Boolean); const last = parts[parts.length - 1]; if (last && last.length) createdId2 = last;
              }
            }
          } catch { createdId2 = null; }
          logger.info("dashboard task created (legacy fallback)", { title: input.title, status: status2, milestoneId: input.milestoneId || null, milestoneSlug: input.milestoneSlug || null, parentTaskId: input.parentTaskId, createdId: createdId2 });
          return { ok: true, status: status2, body: rb2, createdId: createdId2 };
        } catch (e) {
          logger.warn("dashboard task creation exception (legacy fallback)", { error: e, title: input.title });
          return { ok: false, status: 0, body: null, error: e };
        }
      }
      return { ok: false, status, body: responseBody, createdId: null };
    }

    // Determine created id: prefer explicit id fields in body, else Location header
    let createdId: string | null = null;
    try {
      if (responseBody && (responseBody.id || responseBody.task_id || (responseBody.task && responseBody.task.id))) {
        createdId = String(responseBody.id || responseBody.task_id || responseBody.task.id);
      } else {
        const loc = res.headers.get("location") || res.headers.get("Location");
        if (loc && typeof loc === 'string') {
          const parts = loc.split('/').filter(Boolean);
          const last = parts[parts.length - 1];
          if (last && last.length) createdId = last;
        }
      }
    } catch (e) {
      createdId = null;
    }

    logger.info("dashboard task created", { title: input.title, status, endpoint, milestoneId: input.milestoneId || null, milestoneSlug: input.milestoneSlug || null, parentTaskId: input.parentTaskId, createdId });
    return { ok: true, status, body: responseBody, createdId };
  } catch (error) {
    logger.warn("dashboard task creation exception", { error, title: input.title });
    return { ok: false, status: 0, body: null, error };
  }
}

export async function fetchTask(taskId: string): Promise<any | null> {
  if (!cfg.dashboardBaseUrl) return null;
  try {
    const base = cfg.dashboardBaseUrl.replace(/\/$/, "");
    const res = await fetch(`${base}/v1/tasks/${encodeURIComponent(taskId)}`, {
      headers: { "Authorization": `Bearer ${cfg.dashboardApiKey}` }
    });
    if (!res.ok) {
      logger.warn("fetchTask non-ok", { taskId, status: res.status });
      return null;
    }
    return await res.json();
  } catch (e) {
    logger.warn("fetchTask exception", { taskId, error: (e as Error).message });
    return null;
  }
}

// Update the task status using the current dashboard API
// Current API: PATCH /projects/:projectId/tasks/:taskId
export async function updateTaskStatus(taskId: string, status: string, projectId?: string, lockVersion?: number): Promise<CreateTaskResult> {
  if (!cfg.dashboardBaseUrl) {
    logger.warn("dashboard update skipped: base URL not configured");
    return { ok: false, status: 0, body: null };
  }
  const base = cfg.dashboardBaseUrl.replace(/\/$/, "");

  // If no projectId provided, try to use a default or log a warning
  if (!projectId) {
    logger.warn("updateTaskStatus: projectId not provided, update may fail");
    // For backwards compatibility, return success but log the issue
    return { ok: true, status: 200, body: { message: 'projectId required for dashboard update' } };
  }

  const patchOnce = async (endpoint: string, lv?: number | null) => {
    const payload: any = { status };
    if (lv !== undefined && lv !== null) payload.lock_version = lv;
    const res = await fetch(endpoint, {
      method: "PATCH",
      headers: {
        "Authorization": `Bearer ${cfg.dashboardApiKey}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify(payload)
    });
    const statusCode = res.status;
    let responseBody: any = null;
    try { const text = await res.text(); responseBody = text ? JSON.parse(text) : null; } catch { responseBody = null; }
    return { statusCode, responseBody } as { statusCode: number; responseBody: any };
  };

  try {
    // Current API: PATCH /projects/:projectId/tasks/:taskId
    const endpoint = `${base}/projects/${encodeURIComponent(projectId)}/tasks/${encodeURIComponent(taskId)}`;

    // First attempt; supply provided lockVersion if any
    const first = await patchOnce(endpoint, lockVersion ?? undefined);
    if (first.statusCode >= 200 && first.statusCode < 300) {
      logger.info("dashboard task updated", { taskId, projectId, status, statusCode: first.statusCode });
      return { ok: true, status: first.statusCode, body: first.responseBody } as any;
    }

    // Handle optimistic concurrency or missing lock gracefully: fetch current and retry once
    if (first.statusCode === 409 || first.statusCode === 422) {
      try {
        const current = await fetchTask(taskId);
        const raw = current ? (current.lock_version ?? current.lockVersion ?? current.LOCK_VERSION) : undefined;
        const fetchedLv = (raw !== undefined && raw !== null) ? Number(raw) : undefined;
        if (fetchedLv !== undefined) {
          const second = await patchOnce(endpoint, fetchedLv);
          if (second.statusCode >= 200 && second.statusCode < 300) {
            logger.info("dashboard task updated (retry with lock_version)", { taskId, status, statusCode: second.statusCode, usedLockVersion: fetchedLv });
            return { ok: true, status: second.statusCode, body: second.responseBody } as any;
          }
          logger.warn("dashboard task update retry failed", { taskId, status, statusCode: second.statusCode, responseBody: second.responseBody, usedLockVersion: fetchedLv });
          return { ok: false, status: second.statusCode, body: second.responseBody };
        }
      } catch (e) {
        logger.debug('dashboard task update: failed to fetch for retry', { taskId, error: (e as Error).message });
      }
    }

    logger.warn("dashboard task update failed", { taskId, projectId, status, statusCode: first.statusCode, responseBody: first.responseBody });
    return { ok: false, status: first.statusCode, body: first.responseBody };
  } catch (e) {
    logger.warn("dashboard task update exception", { taskId, status, error: (e as Error).message });
    return { ok: false, status: 0, body: null, error: e };
  }
}

/**
 * Fetch all tasks for a project
 * @param projectId The project ID to fetch tasks for
 * @returns Array of tasks, or empty array on error
 */
export async function fetchProjectTasks(projectId: string): Promise<any[]> {
  if (!cfg.dashboardBaseUrl) {
    logger.warn("fetchProjectTasks skipped: dashboard base URL not configured");
    return [];
  }
  
  try {
    const base = cfg.dashboardBaseUrl.replace(/\/$/, "");
    const url = `${base}/projects/${encodeURIComponent(projectId)}/tasks`;
    
    const res = await fetch(url, {
      headers: { "Authorization": `Bearer ${cfg.dashboardApiKey}` }
    });
    
    if (!res.ok) {
      logger.warn("fetchProjectTasks non-ok", { projectId, status: res.status });
      return [];
    }
    
    const body = await res.json();
    // Handle both array response and {data: [...]} wrapper
    const tasks = Array.isArray(body) ? body : ((body as any)?.data || []);
    return Array.isArray(tasks) ? tasks : [];
  } catch (e) {
    logger.warn("fetchProjectTasks exception", { projectId, error: (e as Error).message });
    return [];
  }
}
