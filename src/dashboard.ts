import { cfg } from "./config.js";
import { fetch } from "undici";
import { logger } from "./logger.js";

export async function fetchContext(workflowId: string) {
  try {
    const r = await fetch(`${cfg.dashboardBaseUrl}/api/context?workflow_id=${encodeURIComponent(workflowId)}`, {
      headers: { "Authorization": `Bearer ${cfg.dashboardApiKey}` }
    });
    if (!r.ok) throw new Error(`dashboard ${r.status}`);
    const data = await r.json();
    return data;
  } catch {
    return { projectTree: "", fileHotspots: "", limits: "", personaHints: "" };
  }
}

export async function recordEvent(ev: any) {
  try {
    await fetch(`${cfg.dashboardBaseUrl}/api/events`, {
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
  projectId?: string;
  projectName?: string;
  projectSlug?: string;
  repoRoot: string;
  branch?: string | null;
  summaryMd: string;
  snapshot: any;
  filesNdjson?: string;
};

export type UploadContextResult = {
  ok: boolean;
  status: number;
  body: any;
  error?: any;
};

export async function uploadContextSnapshot(input: UploadContextInput): Promise<UploadContextResult> {
  const body = {
    workflow_id: input.workflowId,
    project_id: input.projectId ?? null,
    project_name: input.projectName ?? null,
    project_slug: input.projectSlug ?? null,
    repo_root: input.repoRoot,
    branch: input.branch ?? null,
    summary_md: input.summaryMd,
    snapshot: input.snapshot,
    files_ndjson: input.filesNdjson ?? null,
    uploaded_at: new Date().toISOString()
  };

  const started = Date.now();
  try {
    const res = await fetch(`${cfg.dashboardBaseUrl}/api/context`, {
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
        branch: input.branch,
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
      branch: input.branch,
      responseSample: typeof responseBody === "string" ? responseBody.slice(0, 200) : responseBody
    });
    return { ok: true, status: res.status, body: responseBody };
  } catch (e) {
    logger.error("dashboard context upload exception", { error: e, workflowId: input.workflowId, projectId: input.projectId, projectSlug: input.projectSlug, repoRoot: input.repoRoot, branch: input.branch });
    return { ok: false, status: 0, body: null, error: e };
  }
}
