import {
  StepResult,
  ValidationResult,
  WorkflowStep,
} from "../engine/WorkflowStep.js";
import { WorkflowContext } from "../engine/WorkflowContext.js";
import { logger } from "../../logger.js";
import { TaskAPI } from "../../dashboard/TaskAPI.js";
import { fetchArtifactContentFromApi } from "../helpers/artifactReader.js";
import { publishArtifactToDashboard } from "../helpers/artifactPublisher.js";
import {
  EscalationFile,
  escalationRequired,
} from "../escalation/escalationRequired.js";

interface ConvergenceGateConfig {
  change_slug_variable?: string;
  attempts_variable?: string;
  max_attempts?: number;
  gate_status_variables?: string[];
  output_prefix?: string;
  attempts_artifact_kind?: string;
  requeue_status?: string;
}

export type ConvergenceOutcome = "pass" | "retry" | "escalate";

const taskAPI = new TaskAPI();

export class ConvergenceGateStep extends WorkflowStep {
  async execute(context: WorkflowContext): Promise<StepResult> {
    const config = (this.config.config || {}) as ConvergenceGateConfig;
    const prefix = config.output_prefix || "convergence";
    const maxAttempts = config.max_attempts ?? 2;

    const changeSlug = String(
      context.getVariable(config.change_slug_variable || "changeSlug") || "",
    );
    const attemptsVar = config.attempts_variable || "convergence_attempts";
    const priorAttempts = await this.loadPriorAttempts(
      context,
      attemptsVar,
      changeSlug,
      config.attempts_artifact_kind,
    );
    const attempt = priorAttempts + 1;

    const passed = this.gatesPassed(context, config.gate_status_variables);

    if (passed) {
      context.setVariable(`${prefix}_status`, "pass");
      logger.info("Convergence gates passed", {
        workflowId: context.workflowId,
        changeSlug,
        attempt,
      });
      return {
        status: "success",
        data: { outcome: "pass" as ConvergenceOutcome, attempt },
        outputs: { [`${prefix}_status`]: "pass" },
      };
    }

    context.setVariable(attemptsVar, attempt);
    await this.persistAttempts(
      context,
      changeSlug,
      attempt,
      maxAttempts,
      config.attempts_artifact_kind,
    );

    if (attempt < maxAttempts) {
      context.setVariable(`${prefix}_status`, "retry");
      context.setVariable("workflow_stop_requested", true);
      context.setVariable("workflow_stop_reason", "convergence_retry");
      const requeued = await this.requeueConvergeTask(
        context,
        config.requeue_status || "open",
      );
      logger.warn("Convergence gates failed; retry available", {
        workflowId: context.workflowId,
        changeSlug,
        attempt,
        maxAttempts,
        requeued,
      });
      return {
        status: "success",
        data: { outcome: "retry" as ConvergenceOutcome, attempt, requeued },
        outputs: {
          [`${prefix}_status`]: "retry",
          [attemptsVar]: attempt,
          workflow_stop_requested: true,
          workflow_stop_reason: "convergence_retry",
        },
      };
    }

    context.setVariable(`${prefix}_status`, "escalate");
    logger.error("Convergence retries exhausted; raising escalation", {
      workflowId: context.workflowId,
      changeSlug,
      attempt,
      maxAttempts,
    });

    escalationRequired({
      changeSlug,
      failingFiles: this.collectFailingFiles(context),
      convergenceErrors: this.collectErrors(context),
      attempts: attempt,
    });
  }

  private async loadPriorAttempts(
    context: WorkflowContext,
    attemptsVar: string,
    changeSlug: string,
    artifactKind?: string,
  ): Promise<number> {
    const inMemory = Number(context.getVariable(attemptsVar));
    if (Number.isFinite(inMemory) && inMemory > 0) {
      return Math.floor(inMemory);
    }

    const projectId = this.resolveProjectId(context);
    const taskId = this.resolveTaskId(context);
    if (!projectId || !taskId) return 0;

    const content = await fetchArtifactContentFromApi({
      projectId,
      taskId,
      kind: artifactKind || "convergence_attempts",
    });
    if (!content) return 0;

    try {
      const parsed = JSON.parse(content);
      if (parsed?.changeSlug && String(parsed.changeSlug) !== changeSlug) {
        return 0;
      }
      const attempts = Number(parsed?.attempts);
      if (!Number.isFinite(attempts) || attempts < 0) return 0;
      const normalized = Math.floor(attempts);
      context.setVariable(attemptsVar, normalized);
      return normalized;
    } catch (error) {
      logger.debug("Convergence attempts artifact was not valid JSON", {
        workflowId: context.workflowId,
        changeSlug,
        error: error instanceof Error ? error.message : String(error),
      });
      return 0;
    }
  }

  private async persistAttempts(
    context: WorkflowContext,
    changeSlug: string,
    attempts: number,
    maxAttempts: number,
    artifactKind?: string,
  ): Promise<void> {
    const projectId = this.resolveProjectId(context);
    const taskId = this.resolveTaskId(context);
    if (!projectId || !taskId) return;

    await publishArtifactToDashboard({
      projectId,
      taskId,
      workflowId: context.workflowId,
      kind: artifactKind || "convergence_attempts",
      content: JSON.stringify(
        {
          changeSlug,
          attempts,
          maxAttempts,
          updatedAt: new Date().toISOString(),
        },
        null,
        2,
      ),
    });
  }

  private async requeueConvergeTask(
    context: WorkflowContext,
    status: string,
  ): Promise<boolean> {
    const projectId = this.resolveProjectId(context);
    const taskId = this.resolveTaskId(context);
    if (!projectId || !taskId) return false;

    const result = await taskAPI.updateTaskStatus(
      String(taskId),
      status,
      String(projectId),
    );
    if (!result?.ok) {
      logger.warn("Convergence retry could not requeue converge task", {
        workflowId: context.workflowId,
        projectId,
        taskId,
        status,
        updateStatus: result?.status,
      });
      return false;
    }
    return true;
  }

  private resolveProjectId(context: WorkflowContext): string | number | null {
    return context.getVariable("projectId") || context.projectId || null;
  }

  private resolveTaskId(context: WorkflowContext): string | number | null {
    const task = context.getVariable("task");
    return task?.id || task?.taskId || context.getVariable("taskId") || null;
  }

  private gatesPassed(
    context: WorkflowContext,
    statusVariables?: string[],
  ): boolean {
    const vars =
      statusVariables && statusVariables.length > 0
        ? statusVariables
        : ["qa_request_status", "testsPassed"];

    for (const name of vars) {
      const value = context.getVariable(name);
      if (name === "testsPassed") {
        if (value === false) return false;
        continue;
      }
      if (value !== undefined && value !== null && value !== "pass") {
        return false;
      }
    }
    return true;
  }

  private collectFailingFiles(context: WorkflowContext): EscalationFile[] {
    const files =
      context.getVariable("review_diff_files") ||
      context.getVariable("failureFiles") ||
      [];
    if (!Array.isArray(files)) return [];
    return files
      .map((f) => String(f))
      .filter(Boolean)
      .map((path) => ({ path, contract: "" }));
  }

  private collectErrors(context: WorkflowContext): string[] {
    const errors: string[] = [];
    const errorText = context.getVariable("errorText");
    if (typeof errorText === "string" && errorText.trim()) {
      errors.push(errorText.trim());
    }
    const failures = context.getVariable("failures");
    if (Array.isArray(failures)) {
      for (const f of failures) {
        const text =
          typeof f === "string" ? f : f?.error || f?.test || JSON.stringify(f);
        if (text) errors.push(String(text));
      }
    }
    return errors.slice(0, 50);
  }

  async validate(_context: WorkflowContext): Promise<ValidationResult> {
    return { valid: true, errors: [], warnings: [] };
  }
}
