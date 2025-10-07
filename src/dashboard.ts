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
    const res = await fetch(`${cfg.dashboardBaseUrl.replace(/\/$/, "")}/v1/projects/${encodeURIComponent(projectId)}`, {
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
    const res = await fetch(`${base}/v1/milestones?project_id=${encodeURIComponent(projectId)}`, {
      headers: { "Authorization": `Bearer ${cfg.dashboardApiKey}` }
    });
    if (!res.ok) {
      logger.debug('fetchProjectMilestones non-ok', { projectId, status: res.status });
      return null;
    }
    const body = await res.json();
    return body;
  } catch (e) {
    logger.warn('fetchProjectMilestones failed', { projectId, error: (e as Error).message });
    return null;
  }
}

export async function fetchProjectStatusDetails(projectId: string | null | undefined) {
  if (!projectId) return null;
  try {
    const base = cfg.dashboardBaseUrl.replace(/\/$/, "");
    const res = await fetch(`${base}/v1/projects/${encodeURIComponent(projectId)}/status`, {
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

export type UploadContextInput = {
  workflowId: string;
  repoId?: string;
  projectId?: string;
  projectName?: string;
  projectSlug?: string;
  repoRoot: string;
  branch?: string | null;
  snapshotPath: string;
  summaryPath: string;
  filesNdjsonPath: string;
  totals: { files: number; bytes: number; lines: number };
  components?: any;
  hotspots?: any;
};

export type UploadContextResult = {
  ok: boolean;
  status: number;
  body: any;
  error?: any;
};

export async function uploadContextSnapshot(input: UploadContextInput): Promise<UploadContextResult> {
  const body = {
    repo_id: input.repoId ?? input.projectId ?? input.projectSlug ?? input.repoRoot,
    branch: input.branch ?? null,
    workflow_id: input.workflowId,
    snapshot_path: input.snapshotPath,
    summary_path: input.summaryPath,
    files_ndjson_path: input.filesNdjsonPath,
    totals_files: input.totals.files ?? 0,
    totals_bytes: input.totals.bytes ?? 0,
    totals_lines: input.totals.lines ?? 0,
    components_json: input.components ?? {},
    hotspots_json: input.hotspots ?? {}
  };

  const started = Date.now();
  try {
    const endpoint = cfg.dashboardContextEndpoint.startsWith("http")
      ? cfg.dashboardContextEndpoint
      : `${cfg.dashboardBaseUrl.replace(/\/$/, "")}${cfg.dashboardContextEndpoint.startsWith("/") ? "" : "/"}${cfg.dashboardContextEndpoint}`;
    const res = await fetch(endpoint, {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${cfg.dashboardApiKey}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify(body)
    });
    const duration = Date.now() - started;

    if (!res.ok) {
      const errorText = await res.text().catch(() => "<no body>");
      logger.warn("dashboard context upload failed", {
        status: res.status,
        duration_ms: duration,
        workflowId: input.workflowId,
        projectId: input.projectId,
        projectSlug: input.projectSlug,
        repoRoot: input.repoRoot,
        repoId: body.repo_id,
        branch: input.branch,
        url: endpoint,
        response: errorText.slice(0, 1000)
      });
      return { ok: false, status: res.status, body: errorText };
    }

    let responseBody: any = null;
    const text = await res.text();
    try { responseBody = text ? JSON.parse(text) : null; } catch { responseBody = text; }

    logger.info("dashboard context upload succeeded", {
      status: res.status,
      duration_ms: duration,
      workflowId: input.workflowId,
      projectId: input.projectId,
      projectSlug: input.projectSlug,
      repoRoot: input.repoRoot,
      repoId: body.repo_id,
      branch: input.branch,
      url: endpoint,
      responseSample: typeof responseBody === "string" ? responseBody.slice(0, 200) : responseBody
    });
    return { ok: true, status: res.status, body: responseBody };
  } catch (e) {
    logger.error("dashboard context upload exception", { error: e, workflowId: input.workflowId, projectId: input.projectId, projectSlug: input.projectSlug, repoRoot: input.repoRoot, branch: input.branch, url: cfg.dashboardContextEndpoint });
    return { ok: false, status: 0, body: null, error: e };
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
  const endpoint = `${cfg.dashboardBaseUrl.replace(/\/$/, "")}/v1/tasks`;
  const body: Record<string, any> = {
    title: input.title,
    description: input.description
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
  else if (input.milestoneSlug && input.options && input.options.create_milestone_if_missing) {
    // Only allow auto-creating the 'Future Enhancements' milestone to avoid accidental duplicates
    const norm = (input.milestoneSlug || '').toString().trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
    const allowOnlyFuture = (typeof cfg.dashboardAutoCreateFutureEnhancementsOnly === 'boolean') ? cfg.dashboardAutoCreateFutureEnhancementsOnly : true;
    if (!allowOnlyFuture || norm === 'future-enhancements' || norm === 'future-enhancement' || norm === 'future_enhancements' || norm === 'future') {
      body.milestone_slug = input.milestoneSlug;
    } else {
      logger.info('milestone auto-create blocked (only allowed for Future Enhancements)', { requested: input.milestoneSlug, projectId: input.projectId });
    }
  }
  if (input.parentTaskId) body.parent_task_id = input.parentTaskId;
  if (typeof input.effortEstimate === "number") body.effort_estimate = input.effortEstimate;
  if (typeof input.priorityScore === "number") body.priority_score = input.priorityScore;
  if (input.assigneePersona) body.assignee_persona = input.assigneePersona;
  if (input.externalId) body.external_id = input.externalId;
  if (input.attachments && Array.isArray(input.attachments)) body.attachments = input.attachments;
  if (input.options) body.options = input.options;
  // Allow the caller to request an initial status for newly created tasks (some dashboards accept this)
  if (input.options && typeof input.options.initial_status === 'string' && input.options.initial_status.trim().length) {
    body.initial_status = input.options.initial_status.trim();
  }

  try {
    const res = await fetch(endpoint, {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${cfg.dashboardApiKey}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify(body)
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
      logger.warn("dashboard task creation failed", { status, body: body.title, response: responseBody });
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

    logger.info("dashboard task created", { title: input.title, status, milestoneId: input.milestoneId || null, milestoneSlug: input.milestoneSlug || null, parentTaskId: input.parentTaskId, createdId });
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

// Update the task status using the task's lock/version to prevent races.
// Update the task status using new coordinator-friendly endpoints.
// If taskId looks like a UUID, call /v1/tasks/{id}/status; otherwise treat it as external_id and call /v1/tasks/by-external/{external_id}/status.
export async function updateTaskStatus(taskId: string, status: string, lockVersion?: number): Promise<CreateTaskResult> {
  if (!cfg.dashboardBaseUrl) {
    logger.warn("dashboard update skipped: base URL not configured");
    return { ok: false, status: 0, body: null };
  }
  const base = cfg.dashboardBaseUrl.replace(/\/$/, "");

  const isUuid = (s: string) => /^(?:[0-9a-fA-F]{8})-(?:[0-9a-fA-F]{4})-(?:[0-9a-fA-F]{4})-(?:[0-9a-fA-F]{4})-(?:[0-9a-fA-F]{12})$/.test(s);
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
    const byId = isUuid(taskId);
    const endpoint = byId
      ? `${base}/v1/tasks/${encodeURIComponent(taskId)}/status`
      : `${base}/v1/tasks/by-external/${encodeURIComponent(taskId)}/status`;

    // First attempt; supply provided lockVersion if any
    const first = await patchOnce(endpoint, lockVersion ?? undefined);
    if (first.statusCode >= 200 && first.statusCode < 300) {
      logger.info("dashboard task updated", { taskId, by: byId ? 'id' : 'external', status, statusCode: first.statusCode });
      return { ok: true, status: first.statusCode, body: first.responseBody } as any;
    }

    // Handle optimistic concurrency or missing lock gracefully: fetch current and retry once when updating by id
    if (byId && (first.statusCode === 409 || first.statusCode === 422)) {
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

    // If by-external returned 404, we can optionally try to resolve to id and retry by id
    if (!byId && first.statusCode === 404) {
      try {
        const resolveUrl = `${base}/v1/tasks/resolve?external_id=${encodeURIComponent(taskId)}`;
        const r = await fetch(resolveUrl, { headers: { "Authorization": `Bearer ${cfg.dashboardApiKey}` } });
        if (r.ok) {
          const body: any = await r.json().catch(() => null);
          const id = body && (body.id || body.task_id || (body.task && body.task.id)) ? String(body.id || body.task_id || body.task.id) : null;
          if (id) {
            const byIdEndpoint = `${base}/v1/tasks/${encodeURIComponent(id)}/status`;
            const second = await patchOnce(byIdEndpoint, undefined);
            if (second.statusCode >= 200 && second.statusCode < 300) {
              logger.info("dashboard task updated (resolved by external)", { externalId: taskId, resolvedId: id, status, statusCode: second.statusCode });
              return { ok: true, status: second.statusCode, body: second.responseBody } as any;
            }
            return { ok: false, status: second.statusCode, body: second.responseBody };
          }
        }
      } catch (e) {
        logger.debug('dashboard task update: resolve by external failed', { externalId: taskId, error: (e as Error).message });
      }
    }

    logger.warn("dashboard task update failed", { taskId, by: byId ? 'id' : 'external', status, statusCode: first.statusCode, responseBody: first.responseBody });
    return { ok: false, status: first.statusCode, body: first.responseBody };
  } catch (e) {
    logger.warn("dashboard task update exception", { taskId, status, error: (e as Error).message });
    return { ok: false, status: 0, body: null, error: e };
  }
}
