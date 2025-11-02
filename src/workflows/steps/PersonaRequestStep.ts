import {
  WorkflowStep,
  StepResult,
  ValidationResult,
} from "../engine/WorkflowStep.js";
import { WorkflowContext } from "../engine/WorkflowContext.js";
import { logger } from "../../logger.js";
import { cfg } from "../../config.js";
import { personaTimeoutMs, personaMaxRetries } from "../../util.js";
import { VariableResolver } from "./helpers/VariableResolver.js";
import { TestModeHandler } from "./helpers/TestModeHandler.js";
import { PersonaRetryCoordinator } from "./helpers/PersonaRetryCoordinator.js";
import { PersonaResponseInterpreter } from "./helpers/PersonaResponseInterpreter.js";
import {
  collectAllowedLanguages as collectAllowedLanguagesFromInsights,
  mergeAllowedLanguages,
  findLanguageViolationsForFiles,
  detectLanguagesInText,
  type LanguageViolation,
} from "./helpers/languagePolicy.js";

interface PersonaRequestConfig {
  step: string;
  persona: string;
  intent: string;
  payload: Record<string, any>;
  timeout?: number;
  deadlineSeconds?: number;
  maxRetries?: number;
}

export class PersonaRequestStep extends WorkflowStep {
  private variableResolver: VariableResolver;
  private testModeHandler: TestModeHandler;
  private responseInterpreter: PersonaResponseInterpreter;

  constructor(config: any) {
    super(config);
    this.variableResolver = new VariableResolver();
    this.testModeHandler = new TestModeHandler();
    this.responseInterpreter = new PersonaResponseInterpreter();
  }

  async execute(context: WorkflowContext): Promise<StepResult> {
    const config = this.config.config as PersonaRequestConfig;
    const { step, persona, intent, payload, deadlineSeconds = 600 } = config;

    if (this.testModeHandler.shouldSkipPersonaOperation(context)) {
      return this.executeTestMode(context, step, persona);
    }

    return this.executePersonaRequest(
      context,
      step,
      persona,
      intent,
      payload,
      deadlineSeconds,
      config,
    );
  }

  private executeTestMode(
    context: WorkflowContext,
    step: string,
    persona: string,
  ): StepResult {
    const stepName = this.config.name || "";
    const mockResult = this.testModeHandler.getMockResponse(
      stepName,
      this.config.outputs,
      context,
    );

    this.testModeHandler.setMockOutputs(
      stepName,
      this.config.outputs,
      context,
      mockResult.statusValue!,
      mockResult.responseValue,
    );

    logger.info("PersonaRequestStep bypassed (SKIP_PERSONA_OPERATIONS)", {
      workflowId: context.workflowId,
      step: stepName,
      persona,
    });

    return {
      status: "success",
      data: {
        step,
        persona,
        bypassed: true,
        seededStatus: mockResult.statusValue,
        result: mockResult.responseValue,
      },
      outputs: mockResult.responseValue,
    };
  }

  private async executePersonaRequest(
    context: WorkflowContext,
    step: string,
    persona: string,
    intent: string,
    payload: Record<string, any>,
    deadlineSeconds: number,
    config: PersonaRequestConfig,
  ): Promise<StepResult> {
    const transport = context.transport;
    if (!transport) {
      throw new Error("Transport not available in context");
    }

    const resolvedPayload = this.resolvePayloadVariables(payload, context);

    const guardResult = this.maybeFailForCodeReviewLanguagePolicy(
      context,
      persona,
      resolvedPayload,
    );
    if (guardResult) {
      this.setOutputVariables(context, guardResult.result);
      context.setVariable(`${this.config.name}_status`, "fail");
      context.logger.warn(
        "Code review request blocked due to language policy violation",
        {
          step,
          persona,
          violations: guardResult.violations,
          allowed_languages: guardResult.result.allowed_languages,
        },
      );

      return {
        status: "failure",
        error: new Error(guardResult.errorMessage),
        data: {
          step,
          persona,
          guard: "language_policy",
          violations: guardResult.violations,
        },
        outputs: guardResult.result,
      };
    }

    const repoForPersona =
      context.getVariable("repo_remote") ||
      context.getVariable("repo") ||
      context.getVariable("effective_repo_path");

    if (!repoForPersona) {
      logger.error("No repository remote URL available for persona request", {
        workflowId: context.workflowId,
        persona,
        step,
        availableVars: Object.keys(context.getAllVariables()),
      });
      throw new Error(
        `Cannot send persona request: no repository remote URL available. Local paths cannot be shared across distributed agents.`,
      );
    }

    const currentBranch = context.getCurrentBranch();

    const baseTimeoutMs = config.timeout ?? personaTimeoutMs(persona, cfg);
    const configuredMaxRetries =
      config.maxRetries !== undefined
        ? config.maxRetries
        : personaMaxRetries(persona, cfg);

    const effectiveMaxRetries =
      configuredMaxRetries === null
        ? Number.MAX_SAFE_INTEGER
        : configuredMaxRetries;
    const isUnlimitedRetries = configuredMaxRetries === null;

    const retryCoordinator = new PersonaRetryCoordinator({
      baseTimeoutMs,
      maxRetries: effectiveMaxRetries,
      isUnlimitedRetries,
      backoffIncrementMs: cfg.personaRetryBackoffIncrementMs,
    });

    const taskId =
      resolvedPayload.task_id ||
      resolvedPayload.taskId ||
      context.getVariable("task_id") ||
      context.getVariable("taskId");

    try {
      const retryResult = await retryCoordinator.executeWithRetry(
        transport,
        {
          workflowId: context.workflowId,
          toPersona: persona,
          step,
          intent,
          payload: resolvedPayload,
          repo: repoForPersona,
          branch: currentBranch,
          projectId: context.projectId,
          taskId,
          deadlineSeconds,
        },
        context,
      );

      if (!retryResult.success) {
        const errorDetails =
          PersonaRetryCoordinator.createExhaustedRetriesError(
            persona,
            step,
            retryResult.totalAttempts,
            baseTimeoutMs,
            retryResult.finalTimeoutMs,
            effectiveMaxRetries,
            isUnlimitedRetries,
            cfg.personaRetryBackoffIncrementMs,
            retryResult.lastCorrId,
            context.workflowId,
          );

        logger.error(
          `Persona request failed after exhausting all retries - WORKFLOW WILL ABORT`,
          errorDetails.logContext,
        );

        return {
          status: "failure",
          error: new Error(errorDetails.message),
          data: {
            step,
            persona,
            corrId: retryResult.lastCorrId,
            totalAttempts: retryResult.totalAttempts,
            baseTimeoutMs,
            finalTimeoutMs: retryResult.finalTimeoutMs,
            workflowAborted: true,
          },
        };
      }

      const rawResponse = retryResult.completion.fields?.result || "";
      const { result, statusInfo } = this.responseInterpreter.interpret(
        rawResponse,
        persona,
        context.workflowId,
        step,
        retryResult.lastCorrId,
        retryResult.completion,
      );

      logger.info(`Persona request completed`, {
        workflowId: context.workflowId,
        step,
        persona,
        corrId: retryResult.lastCorrId,
        attempt: retryResult.totalAttempts,
        status: statusInfo.status,
        rawStatus: result.status || "unknown",
      });

      this.setOutputVariables(context, result);
      context.setVariable(`${this.config.name}_status`, statusInfo.status);

      if (statusInfo.status === "fail") {
        logger.error(`Persona request failed - workflow will abort`, {
          workflowId: context.workflowId,
          step,
          persona,
          corrId: retryResult.lastCorrId,
          statusDetails: statusInfo.details,
          errorFromPersona: result.error || "Unknown error",
        });

        return {
          status: "failure",
          error: new Error(
            statusInfo.details || result.error || "Persona request failed",
          ),
          data: {
            step,
            persona,
            corrId: retryResult.lastCorrId,
            totalAttempts: retryResult.totalAttempts,
            result,
            completion: retryResult.completion,
            personaFailureReason: statusInfo.details,
          },
          outputs: result,
        };
      }

      return {
        status: "success",
        data: {
          step,
          persona,
          corrId: retryResult.lastCorrId,
          totalAttempts: retryResult.totalAttempts,
          result,
          completion: retryResult.completion,
        },
        outputs: result,
      };
    } catch (error: any) {
      logger.error(`Persona request failed`, {
        workflowId: context.workflowId,
        step,
        persona,
        error: error.message,
        stack: error.stack,
      });

      return {
        status: "failure",
        error: error instanceof Error ? error : new Error(error.message),
        data: { step, persona },
      };
    }
  }

  private resolvePayloadVariables(
    payload: Record<string, any>,
    context: WorkflowContext,
  ): Record<string, any> {
    return this.variableResolver.resolvePayload(payload, context);
  }

  private maybeFailForCodeReviewLanguagePolicy(
    context: WorkflowContext,
    persona: string,
    payload: Record<string, any>,
  ): {
    result: any;
    errorMessage: string;
    violations: LanguageViolation[];
  } | null {
    if (persona !== "code-reviewer") {
      return null;
    }

    const changedFiles = this.collectChangedFilesForReview(context, payload);
    if (changedFiles.length === 0) {
      return null;
    }

    const insights = context.getVariable("context_insights") || null;
    let allowedInfo = collectAllowedLanguagesFromInsights(insights);

    const contextAllowed = context.getVariable("context_allowed_languages");
    if (Array.isArray(contextAllowed)) {
      allowedInfo = mergeAllowedLanguages(allowedInfo, contextAllowed);
    }

    const contextAllowedNormalized = context.getVariable(
      "context_allowed_languages_normalized",
    );
    if (Array.isArray(contextAllowedNormalized)) {
      allowedInfo = mergeAllowedLanguages(allowedInfo, contextAllowedNormalized);
    }

    const payloadAllowed = this.toStringArray(payload.allowed_languages);
    if (payloadAllowed.length > 0) {
      allowedInfo = mergeAllowedLanguages(allowedInfo, payloadAllowed);
    }

    const taskValue = payload.task || context.getVariable("task");
    const taskDescription =
      taskValue && typeof taskValue.description === "string"
        ? taskValue.description
        : undefined;
    const taskRequestedLanguages = detectLanguagesInText(taskDescription);
    if (taskRequestedLanguages.length > 0) {
      allowedInfo = mergeAllowedLanguages(allowedInfo, taskRequestedLanguages);
    }

    if (allowedInfo.normalized.size === 0) {
      return null;
    }

    const violations = findLanguageViolationsForFiles(
      changedFiles,
      allowedInfo.normalized,
    );

    if (violations.length === 0) {
      return null;
    }

    const allowedLabel =
      allowedInfo.display.length > 0
        ? allowedInfo.display.join(", ")
        : "none detected";
    const violationSummary = violations
      .map((violation) => `${violation.file} (${violation.language})`)
      .join(", ");

    const summary =
      "Language policy violation: Implementation touches " +
      `${violationSummary} outside allowed set (${allowedLabel}). ` +
      "Task description did not request these languages.";

    const severeFindings = violations.map((violation) => ({
      file: violation.file,
      line: null,
      issue: `Unapproved language detected: ${violation.language}`,
      recommendation:
        allowedInfo.display.length > 0
          ? `Restrict changes to allowed languages (${allowedLabel}) or explicitly update the task description to justify ${violation.language}.`
          : `Align changes with the repository's established language stack or update the task description to justify ${violation.language}.`,
    }));

    const result = {
      status: "fail",
      summary,
      findings: {
        severe: severeFindings,
        high: [] as any[],
        medium: [] as any[],
        low: [] as any[],
      },
      guard: "language_policy",
      violations,
      allowed_languages: allowedInfo.display,
      allowed_languages_normalized: Array.from(allowedInfo.normalized),
      task_description_languages: taskRequestedLanguages,
    };

    return {
      result,
      errorMessage: summary,
      violations,
    };
  }

  private collectChangedFilesForReview(
    context: WorkflowContext,
    payload: Record<string, any>,
  ): string[] {
    const files = new Set<string>();

    const append = (source: unknown) => {
      if (!source) return;
      if (Array.isArray(source)) {
        source.forEach((item) => {
          if (typeof item === "string" && item.trim().length > 0) {
            files.add(item.trim());
          }
        });
      }
    };

    append(context.getVariable("last_applied_files"));

    const diffOutput = context.getStepOutput("apply_implementation_edits");
    if (diffOutput && typeof diffOutput === "object") {
      append((diffOutput as any).applied_files);
    }

    if (payload && typeof payload === "object") {
      const implementation = (payload as any).implementation;
      if (implementation && typeof implementation === "object") {
        append((implementation as any).applied_files);
        append((implementation as any).changed_files);
      }
    }

    return Array.from(files);
  }

  private toStringArray(value: unknown): string[] {
    if (!value) return [];
    if (Array.isArray(value)) {
      return value
        .map((item) => (typeof item === "string" ? item : String(item)))
        .filter((text) => text.trim().length > 0);
    }
    if (typeof value === "string") {
      return value.trim().length > 0 ? [value] : [];
    }
    return [];
  }

  private setOutputVariables(context: WorkflowContext, result: any): void {
    if (this.config.outputs) {
      for (const output of this.config.outputs) {
        context.setVariable(output, result);
      }
    }

    if (result && typeof result === "object") {
      for (const [key, value] of Object.entries(result)) {
        context.setVariable(`${this.config.name}_${key}`, value);
      }
    }
  }

  protected async validateConfig(
    _context: WorkflowContext,
  ): Promise<ValidationResult> {
    const errors: string[] = [];
    const config = this.config.config as PersonaRequestConfig;

    if (!config.step || typeof config.step !== "string") {
      errors.push("PersonaRequestStep: step is required and must be a string");
    }

    if (!config.persona || typeof config.persona !== "string") {
      errors.push(
        "PersonaRequestStep: persona is required and must be a string",
      );
    }

    if (!config.intent || typeof config.intent !== "string") {
      errors.push(
        "PersonaRequestStep: intent is required and must be a string",
      );
    }

    if (!config.payload || typeof config.payload !== "object") {
      errors.push(
        "PersonaRequestStep: payload is required and must be an object",
      );
    }

    if (
      config.timeout !== undefined &&
      (typeof config.timeout !== "number" || config.timeout < 0)
    ) {
      errors.push("PersonaRequestStep: timeout must be a non-negative number");
    }

    if (
      config.deadlineSeconds !== undefined &&
      (typeof config.deadlineSeconds !== "number" || config.deadlineSeconds < 0)
    ) {
      errors.push(
        "PersonaRequestStep: deadlineSeconds must be a non-negative number",
      );
    }

    if (
      config.maxRetries !== undefined &&
      (typeof config.maxRetries !== "number" || config.maxRetries < 0)
    ) {
      errors.push(
        "PersonaRequestStep: maxRetries must be a non-negative number",
      );
    }

    return {
      valid: errors.length === 0,
      errors,
      warnings: [],
    };
  }
}
