import { DashboardClient } from "./DashboardClient.js";
import { logger } from "../logger.js";

export type PublishArtifactInput = {
  projectId: string | number;
  taskId: string | number;
  kind: string;
  content: string;
  iteration?: number | null;
  workflowId?: string | null;
};

export type PublishArtifactResult = {
  ok: boolean;
  status: number;
  artifactId?: number;
  error?: any;
};

export type FetchArtifactsInput = {
  projectId: string | number;
  taskId: string | number;
  kind?: string;
  latest?: boolean;
  metaOnly?: boolean;
};

export class ArtifactAPI extends DashboardClient {
  async publishTaskArtifact(
    input: PublishArtifactInput,
  ): Promise<PublishArtifactResult> {
    const { projectId, taskId, kind, content } = input;
    if (!projectId || !taskId || !kind) {
      logger.warn("artifact publish skipped: missing identifiers", {
        projectId,
        taskId,
        kind,
      });
      return { ok: false, status: 0, error: "missing identifiers" };
    }

    const path = `/projects/${encodeURIComponent(String(projectId))}/tasks/${encodeURIComponent(String(taskId))}/artifacts`;
    const body: Record<string, unknown> = { kind, content };
    if (input.iteration !== undefined && input.iteration !== null) {
      body.iteration = input.iteration;
    }
    if (input.workflowId) {
      body.workflow_id = input.workflowId;
    }

    const res = await this.post<{ id?: number }>(path, body);
    if (!res.ok) {
      return { ok: false, status: res.status, error: res.error };
    }
    return { ok: true, status: res.status, artifactId: res.data?.id };
  }

  async fetchTaskArtifacts(input: FetchArtifactsInput): Promise<any[] | null> {
    const { projectId, taskId } = input;
    if (!projectId || !taskId) return null;

    const params = new URLSearchParams();
    if (input.kind) params.set("kind", input.kind);
    if (input.latest) params.set("latest", "1");
    if (input.metaOnly) params.set("meta_only", "1");
    const query = params.toString();

    const path = `/projects/${encodeURIComponent(String(projectId))}/tasks/${encodeURIComponent(String(taskId))}/artifacts${query ? `?${query}` : ""}`;
    const data = await this.get<{ data: any[] }>(path);
    return data?.data ?? null;
  }

  async publishProjectArtifact(
    input: Omit<PublishArtifactInput, "taskId">,
  ): Promise<PublishArtifactResult> {
    const { projectId, kind, content } = input;
    if (!projectId || !kind) {
      logger.warn("project artifact publish skipped: missing identifiers", {
        projectId,
        kind,
      });
      return { ok: false, status: 0, error: "missing identifiers" };
    }

    const path = `/projects/${encodeURIComponent(String(projectId))}/artifacts`;
    const body: Record<string, unknown> = { kind, content };
    if (input.workflowId) {
      body.workflow_id = input.workflowId;
    }

    const res = await this.post<{ id?: number }>(path, body);
    if (!res.ok) {
      return { ok: false, status: res.status, error: res.error };
    }
    return { ok: true, status: res.status, artifactId: res.data?.id };
  }

  async fetchProjectArtifacts(
    input: Omit<FetchArtifactsInput, "taskId">,
  ): Promise<any[] | null> {
    const { projectId } = input;
    if (!projectId) return null;

    const params = new URLSearchParams();
    if (input.kind) params.set("kind", input.kind);
    if (input.latest) params.set("latest", "1");
    if (input.metaOnly) params.set("meta_only", "1");
    const query = params.toString();

    const path = `/projects/${encodeURIComponent(String(projectId))}/artifacts${query ? `?${query}` : ""}`;
    const data = await this.get<{ data: any[] }>(path);
    return data?.data ?? null;
  }
}
