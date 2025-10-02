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
