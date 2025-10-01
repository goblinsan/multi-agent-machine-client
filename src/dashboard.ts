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

export async function uploadContextSnapshot(input: UploadContextInput) {
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

  try {
    await fetch(`${cfg.dashboardBaseUrl}/api/context`, {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${cfg.dashboardApiKey}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify(body)
    });
  } catch (e) {
    logger.warn("dashboard context upload failed", { error: e, body });
  }
}
