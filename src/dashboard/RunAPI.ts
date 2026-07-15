import { DashboardClient } from "./DashboardClient.js";

const RUN_EVENT_TIMEOUT_MS = 4000;

export interface RunCreateBody {
  external_id?: string;
  workflow_type?: string;
  status?: string;
  source?: string;
  model_profile?: string;
  metadata?: Record<string, unknown>;
}

export interface RunPatchBody {
  status?: string;
  completed_at?: string;
  metadata?: Record<string, unknown>;
}

export interface RunEventBody {
  event_id: string;
  sequence?: number;
  event_type: string;
  step_name?: string;
  status?: string;
  schema_version?: number;
  duration_ms?: number;
  ts?: string;
  payload?: Record<string, unknown>;
}

export class RunAPI extends DashboardClient {
  async createRun(projectId: string, body: RunCreateBody) {
    return this.post(`/projects/${projectId}/runs`, body, RUN_EVENT_TIMEOUT_MS);
  }

  async patchRun(runId: string, body: RunPatchBody) {
    return this.patch(`/runs/${runId}`, body, RUN_EVENT_TIMEOUT_MS);
  }

  async appendEvent(runId: string, body: RunEventBody) {
    return this.post(`/runs/${runId}/events`, body, RUN_EVENT_TIMEOUT_MS);
  }
}
