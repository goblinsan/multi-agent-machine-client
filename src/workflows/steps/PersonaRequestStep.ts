import {
  WorkflowStep,
  StepResult,
  ValidationResult,
} from "../engine/WorkflowStep.js";
import { WorkflowContext } from "../engine/WorkflowContext.js";
import { logger } from "../../logger.js";
import { cfg } from "../../config.js";
import { TestModeHandler } from "./helpers/TestModeHandler.js";
import { PersonaRetryCoordinator } from "./helpers/PersonaRetryCoordinator.js";
import { PersonaResponseInterpreter } from "./helpers/PersonaResponseInterpreter.js";
import { evaluateCodeReviewLanguagePolicy } from "./helpers/PersonaLanguagePolicy.js";
import { PersonaPayloadBuilder } from "./helpers/personaRequest/payloadUtils.js";
import {
  computeRetryParameters,
  createRetryCoordinator,
  resolveRepoForPersona,
} from "./helpers/personaRequest/transportUtils.js";
import type { PersonaRequestConfig } from "./helpers/personaRequest/types.js";
import {
  InformationRequestHandler,
  normalizeInformationRequests,
} from "./helpers/InformationRequestHandler.js";
import {
  appendInformationContract,
  buildIterationPayload,
  buildSystemInformationBlock,
  extractInformationRequestPayload,
} from "./helpers/personaRequest/informationUtils.js";

export class PersonaRequestStep extends WorkflowStep {
  private payloadBuilder: PersonaPayloadBuilder;
  private testModeHandler: TestModeHandler;
  private responseInterpreter: PersonaResponseInterpreter;

  constructor(config: any) {
    super(config);
    this.payloadBuilder = new PersonaPayloadBuilder();
    this.testModeHandler = new TestModeHandler();
    this.responseInterpreter = new PersonaResponseInterpreter();
  }

  async execute(context: WorkflowContext): Promise<StepResult> {
    const config = this.config.config as PersonaRequestConfig;
    const {
      step,
      persona,
      intent,
      payload,
      deadlineSeconds = 600,
    } = config;

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

    const { maxInformationIterations } = config;

    const resolvedPayload = this.resolvePayloadVariables(payload, context);
    try {
      await this.payloadBuilder.maybeApplyPromptTemplate(
        resolvedPayload,
        context,
        config.prompt_template,
        persona,
        this.config.name,
      );
    } catch (error) {
      logger.error("PersonaRequestStep: Failed to render prompt template", {
        step: this.config.name,
        templatePath: config.prompt_template,
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }

    const guardResult = evaluateCodeReviewLanguagePolicy(
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

    let repoForPersona: string;
    try {
      repoForPersona = resolveRepoForPersona(context);
    } catch (error) {
      logger.error("No repository remote URL available for persona request", {
        workflowId: context.workflowId,
        persona,
        step,
        availableVars: Object.keys(context.getAllVariables()),
      });
      throw error;
    }

    const currentBranch = context.getCurrentBranch();

    const retryParams = computeRetryParameters(persona, config);
    const {
      coordinator: retryCoordinator,
      baseTimeoutMs,
      effectiveMaxRetries,
      isUnlimitedRetries,
    } = createRetryCoordinator(persona, retryParams);

    const taskId =
      resolvedPayload.task_id ||
      resolvedPayload.taskId ||
      context.getVariable("task_id") ||
      context.getVariable("taskId");

    try {
      const infoHandler = new InformationRequestHandler(context);
      const baseUserText = appendInformationContract(
        resolvedPayload.user_text || "",
      );
      resolvedPayload.user_text = baseUserText;

      const infoBlocks: string[] = [];
      const requestSignatureVar = `${this.config.name}_information_request_signatures`;
      const storedSignatures = context.getVariable(requestSignatureVar);
      const fulfilledRequestSignatures = new Set<string>(
        Array.isArray(storedSignatures)
          ? (storedSignatures as string[])
          : [],
      );
      const maxInfoIterations = Math.max(
        1,
        maxInformationIterations ?? cfg.informationRequests?.maxIterations ?? 5,
      );

      for (let iteration = 1; iteration <= maxInfoIterations; iteration++) {
        const iterationPayload = buildIterationPayload(
          resolvedPayload,
          baseUserText,
          infoBlocks,
          iteration,
          maxInfoIterations,
        );

        const retryResult = await retryCoordinator.executeWithRetry(
          transport,
          {
            workflowId: context.workflowId,
            toPersona: persona,
            step,
            intent,
            payload: iterationPayload,
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
          } satisfies StepResult;
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

        const infoRequestPayload = extractInformationRequestPayload(
          result,
          retryResult.completion,
        );

        if (infoRequestPayload) {
          if (iteration >= maxInfoIterations) {
            return this.buildInformationLimitFailure(
              context.workflowId,
              persona,
              step,
              infoBlocks,
              maxInfoIterations,
            );
          }

          const normalizedRequests = normalizeInformationRequests(
            infoRequestPayload,
          );
          if (!normalizedRequests.length) {
            infoBlocks.push(
              buildSystemInformationBlock(
                "Persona asked for additional information but supplied no valid requests.",
              ),
            );
            continue;
          }

          logger.info("Persona requested supplemental information", {
            workflowId: context.workflowId,
            step,
            persona,
            iteration,
            requestCount: normalizedRequests.length,
          });

          const acquisitions = await infoHandler.fulfillRequests(
            normalizedRequests,
            { persona, step, iteration, taskId },
            fulfilledRequestSignatures,
          );

          if (!acquisitions.length) {
            infoBlocks.push(
              buildSystemInformationBlock(
                "Information acquisition produced no records.",
              ),
            );
          } else {
            infoBlocks.push(
              ...acquisitions.map((record) => record.summaryBlock),
            );
            context.setVariable(
              `${this.config.name}_information_iteration_${iteration}`,
              acquisitions,
            );
            context.setVariable(
              `${this.config.name}_information_blocks`,
              infoBlocks.slice(),
            );
          }
          context.setVariable(
            requestSignatureVar,
            Array.from(fulfilledRequestSignatures),
          );
          continue;
        }

        return this.handlePersonaCompletion(
          context,
          config,
          persona,
          step,
          retryResult,
          result,
          statusInfo,
        );
      }

      return this.buildInformationLimitFailure(
        context.workflowId,
        persona,
        step,
        infoBlocks,
        maxInfoIterations,
      );
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
      } satisfies StepResult;
    }
  }

  private resolvePayloadVariables(
    payload: Record<string, any>,
    context: WorkflowContext,
  ): Record<string, any> {
    return this.payloadBuilder.resolvePayload(payload, context);
  }

  private handlePersonaCompletion(
    context: WorkflowContext,
    config: PersonaRequestConfig,
    persona: string,
    step: string,
    retryResult: any,
    result: any,
    statusInfo: { status: "pass" | "fail" | "unknown"; details: string },
  ): StepResult {
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

    const abortOnFailure =
      config.abortOnFailure === undefined ? true : Boolean(config.abortOnFailure);
    const isFailureStatus =
      statusInfo.status === "fail" || statusInfo.status === "unknown";

    if (isFailureStatus && abortOnFailure) {
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
      } satisfies StepResult;
    }

    if (isFailureStatus && !abortOnFailure) {
      logger.warn(`Persona request returned ${statusInfo.status} status`, {
        workflowId: context.workflowId,
        step,
        persona,
        corrId: retryResult.lastCorrId,
        statusDetails: statusInfo.details,
        handledByAbortOverride: true,
      });

      return {
        status: "success",
        data: {
          step,
          persona,
          corrId: retryResult.lastCorrId,
          totalAttempts: retryResult.totalAttempts,
          result,
          completion: retryResult.completion,
          personaFailureReason: statusInfo.details,
          abortOverrideApplied: true,
        },
        outputs: result,
      } satisfies StepResult;
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
    } satisfies StepResult;
  }

  private buildInformationLimitFailure(
    workflowId: string,
    persona: string,
    step: string,
    infoBlocks: string[],
    maxIterations: number,
  ): StepResult {
    const message =
      `Persona '${persona}' exhausted the information request allowance (` +
      `${maxIterations}) without providing a final response.`;
    logger.error("Information request limit reached before completion", {
      workflowId,
      persona,
      step,
      maxIterations,
    });
    return {
      status: "failure",
      error: new Error(message),
      data: {
        step,
        persona,
        maxIterations,
        infoBlocks,
      },
    } satisfies StepResult;
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
