import { getRunEventSink, RunEventSink, RunHandle } from "./RunEventSink.js";

export interface TaskOutcome {
  success?: boolean;
  failedStep?: string | null;
  error?: string;
}

export class CoordinatorRunTracker {
  private sequence = 0;

  private constructor(
    private readonly sink: RunEventSink,
    private readonly handle: RunHandle,
    private readonly workflowId: string,
  ) {}

  static async start(input: {
    projectId: string;
    workflowId: string;
    workflowType?: string;
    metadata?: Record<string, unknown>;
  }): Promise<CoordinatorRunTracker> {
    const sink = getRunEventSink();
    const handle = await sink.startRun({
      projectId: input.projectId,
      externalId: input.workflowId,
      workflowType: input.workflowType,
      source: "coordinator",
      metadata: input.metadata,
    });
    return new CoordinatorRunTracker(sink, handle, input.workflowId);
  }

  async taskStarted(taskId: string, attempt: number): Promise<void> {
    await this.sink.emit(this.handle.runId, {
      eventId: `${this.workflowId}:task:${taskId}:a${attempt}:start`,
      sequence: ++this.sequence,
      eventType: "task_started",
      stepName: `task:${taskId}`,
      status: "running",
      payload: { taskId, attempt: attempt + 1 },
    });
  }

  async taskFinished(
    taskId: string,
    attempt: number,
    outcome: TaskOutcome,
  ): Promise<void> {
    const failed = outcome.error != null || outcome.success === false;
    await this.sink.emit(this.handle.runId, {
      eventId: `${this.workflowId}:task:${taskId}:a${attempt}:end`,
      sequence: ++this.sequence,
      eventType: failed ? "task_failed" : "task_completed",
      stepName: `task:${taskId}`,
      status: failed ? "failed" : "success",
      payload: {
        taskId,
        success: !failed,
        failedStep: outcome.failedStep ?? null,
        error: outcome.error ?? null,
      },
    });
  }

  async finish(
    results: Array<{ success?: boolean }>,
    aborted: boolean,
    iterationCount: number,
  ): Promise<void> {
    const failed = results.filter((r) => !r.success).length;
    await this.sink.completeRun(this.handle.runId, {
      status: aborted || failed > 0 ? "failed" : "completed",
      metadata: {
        iterationCount,
        tasksProcessed: results.length,
        successful: results.length - failed,
        failed,
      },
    });
  }

  async finishFailed(error: string): Promise<void> {
    await this.sink.completeRun(this.handle.runId, {
      status: "failed",
      metadata: { error },
    });
  }
}
