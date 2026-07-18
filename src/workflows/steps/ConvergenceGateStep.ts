import {
  StepResult,
  ValidationResult,
  WorkflowStep,
} from "../engine/WorkflowStep.js";
import { WorkflowContext } from "../engine/WorkflowContext.js";
import { logger } from "../../logger.js";
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
}

export type ConvergenceOutcome = "pass" | "retry" | "escalate";

export class ConvergenceGateStep extends WorkflowStep {
  async execute(context: WorkflowContext): Promise<StepResult> {
    const config = (this.config.config || {}) as ConvergenceGateConfig;
    const prefix = config.output_prefix || "convergence";
    const maxAttempts = config.max_attempts ?? 2;

    const changeSlug = String(
      context.getVariable(config.change_slug_variable || "changeSlug") || "",
    );
    const attemptsVar = config.attempts_variable || "convergence_attempts";
    const priorAttempts = Number(context.getVariable(attemptsVar) || 0) || 0;
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

    if (attempt < maxAttempts) {
      context.setVariable(`${prefix}_status`, "retry");
      logger.warn("Convergence gates failed; retry available", {
        workflowId: context.workflowId,
        changeSlug,
        attempt,
        maxAttempts,
      });
      return {
        status: "failure",
        error: new Error(
          `Convergence failed for change '${changeSlug}' (attempt ${attempt}/${maxAttempts}); retry available`,
        ),
        data: { outcome: "retry" as ConvergenceOutcome, attempt },
        outputs: { [`${prefix}_status`]: "retry" },
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
