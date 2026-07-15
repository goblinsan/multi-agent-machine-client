import { appendFileSync } from "fs";
import { logger } from "../logger.js";
import { cfg } from "../config.js";
import { RunAPI } from "../dashboard/RunAPI.js";

export interface StartRunInput {
  projectId: string;
  externalId: string;
  workflowType?: string;
  source?: string;
  modelProfile?: string;
  metadata?: Record<string, unknown>;
}

export interface RunEvent {
  eventId: string;
  sequence?: number;
  eventType: string;
  stepName?: string;
  status?: string;
  durationMs?: number;
  payload?: Record<string, unknown>;
}

export interface RunCompletion {
  status: "completed" | "failed" | "cancelled";
  metadata?: Record<string, unknown>;
}

export interface RunHandle {
  runId: string | null;
}

export interface RunEventSink {
  startRun(input: StartRunInput): Promise<RunHandle>;
  emit(runId: string | null, event: RunEvent): Promise<void>;
  completeRun(runId: string | null, result: RunCompletion): Promise<void>;
}

export class NoopRunEventSink implements RunEventSink {
  async startRun(): Promise<RunHandle> {
    return { runId: null };
  }
  async emit(): Promise<void> {}
  async completeRun(): Promise<void> {}
}

export class FileRunEventSink implements RunEventSink {
  private readonly path: string;

  constructor(path?: string) {
    this.path = path || process.env.RUN_EVENTS_FILE || "run-events.log";
  }

  private write(record: Record<string, unknown>): void {
    try {
      appendFileSync(this.path, JSON.stringify(record) + "\n");
    } catch (error) {
      logger.warn("run event file write failed", {
        error: (error as Error).message,
      });
    }
  }

  async startRun(input: StartRunInput): Promise<RunHandle> {
    this.write({ kind: "run_start", ...input });
    return { runId: input.externalId };
  }

  async emit(runId: string | null, event: RunEvent): Promise<void> {
    if (!runId) return;
    this.write({ kind: "run_event", runId, ...event });
  }

  async completeRun(runId: string | null, result: RunCompletion): Promise<void> {
    if (!runId) return;
    this.write({ kind: "run_complete", runId, ...result });
  }
}

export class DashboardRunEventSink implements RunEventSink {
  private readonly api: RunAPI;

  constructor(baseUrl?: string) {
    this.api = new RunAPI(baseUrl);
  }

  async startRun(input: StartRunInput): Promise<RunHandle> {
    const res = await this.api.createRun(input.projectId, {
      external_id: input.externalId,
      workflow_type: input.workflowType,
      status: "running",
      source: input.source,
      model_profile: input.modelProfile,
      metadata: input.metadata,
    });
    const runId = res.ok && res.data?.id != null ? String(res.data.id) : null;
    if (!runId) {
      logger.warn("run event startRun did not persist; continuing", {
        externalId: input.externalId,
        status: res.status,
      });
    }
    return { runId };
  }

  async emit(runId: string | null, event: RunEvent): Promise<void> {
    if (!runId) return;
    await this.api.appendEvent(runId, {
      event_id: event.eventId,
      sequence: event.sequence,
      event_type: event.eventType,
      step_name: event.stepName,
      status: event.status,
      schema_version: 1,
      duration_ms: event.durationMs,
      payload: event.payload,
    });
  }

  async completeRun(
    runId: string | null,
    result: RunCompletion,
  ): Promise<void> {
    if (!runId) return;
    await this.api.patchRun(runId, {
      status: result.status,
      metadata: result.metadata,
    });
  }
}

let singleton: RunEventSink | null = null;

export function getRunEventSink(): RunEventSink {
  if (singleton) return singleton;
  const mode = (process.env.RUN_EVENTS || "auto").toLowerCase();
  if (process.env.VITEST || process.env.NODE_ENV === "test") {
    singleton = new NoopRunEventSink();
  } else if (mode === "off") {
    singleton = new NoopRunEventSink();
  } else if (mode === "file") {
    singleton = new FileRunEventSink();
  } else if (cfg.dashboardBaseUrl) {
    singleton = new DashboardRunEventSink();
  } else {
    singleton = new FileRunEventSink();
  }
  return singleton;
}

export function setRunEventSinkForTest(sink: RunEventSink | null): void {
  singleton = sink;
}
