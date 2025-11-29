import { StepResult } from "../../../engine/WorkflowStep.js";
import { WorkflowContext } from "../../../engine/WorkflowContext.js";
import { logger } from "../../../../logger.js";
import { cfg } from "../../../../config.js";
import { PersonaRetryCoordinator } from "../PersonaRetryCoordinator.js";
import { PersonaResponseInterpreter } from "../PersonaResponseInterpreter.js";
import { evaluateCodeReviewLanguagePolicy } from "../PersonaLanguagePolicy.js";
import { PersonaPayloadBuilder } from "./payloadUtils.js";
import {
  computeRetryParameters,
  createRetryCoordinator,
  resolveRepoForPersona,
} from "./transportUtils.js";
import type { PersonaRequestConfig } from "./types.js";
import {
  InformationRequestHandler,
  normalizeInformationRequests,
} from "../InformationRequestHandler.js";
import {
  appendInformationContract,
  buildIterationPayload,
  buildSystemInformationBlock,
  extractInformationRequestPayload,
} from "./informationUtils.js";
import {
  buildInformationLimitFailure,
  buildInformationSourceCapFailure,
  handlePersonaCompletion,
  applyOutputVariables,
  recordInformationSources,
} from "./personaRequestOutcomes.js";

export type PersonaRequestExecutorArgs = {
  context: WorkflowContext;
  persona: string;
  step: string;
  intent: string;
  payload: Record<string, any>;
  deadlineSeconds: number;
  config: PersonaRequestConfig;
  payloadBuilder: PersonaPayloadBuilder;
  responseInterpreter: PersonaResponseInterpreter;
  stepName: string;
  outputs?: string[];
};

export async function executePersonaRequestFlow(
  args: PersonaRequestExecutorArgs,
): Promise<StepResult> {
  const {
    context,
    persona,
    step,
    intent,
    payload,
    deadlineSeconds,
    config,
    payloadBuilder,
    responseInterpreter,
    stepName,
    outputs,
  } = args;

  const transport = context.transport;
  if (!transport) {
    throw new Error("Transport not available in context");
  }

  const { maxInformationIterations, maxInformationSources } = config;
  const resolvedPayload = payloadBuilder.resolvePayload(payload, context);

  try {
    await payloadBuilder.maybeApplyPromptTemplate(
      resolvedPayload,
      context,
      config.prompt_template,
      persona,
      stepName,
    );
  } catch (error) {
    logger.error("PersonaRequestStep: Failed to render prompt template", {
      step: stepName,
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
    applyOutputVariables(context, stepName, outputs, guardResult.result);
    context.setVariable(`${stepName}_status`, "fail");
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
    } satisfies StepResult;
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
    const requestSignatureVar = `${stepName}_information_request_signatures`;
    const storedSignatures = context.getVariable(requestSignatureVar);
    const fulfilledRequestSignatures = new Set<string>(
      Array.isArray(storedSignatures) ? (storedSignatures as string[]) : [],
    );
    const uniqueSourceVar = `${stepName}_information_request_sources`;
    const storedSources = context.getVariable(uniqueSourceVar);
    const uniqueInformationSources = new Set<string>(
      Array.isArray(storedSources)
        ? (storedSources as unknown[]).map((value) => String(value))
        : [],
    );
    const maxUniqueSources = Math.max(
      1,
      maxInformationSources ?? cfg.informationRequests?.maxUniqueSources ?? 12,
    );
    const sourceCapFlagVar = `${stepName}_information_sources_cap_hit`;
    let sourceCapTriggered = Boolean(context.getVariable(sourceCapFlagVar));
    const sourceCapGraceVar = `${stepName}_information_sources_grace`;
    const graceRaw = context.getVariable(sourceCapGraceVar);
    let sourceCapGraceRemaining =
      typeof graceRaw === "number" ? graceRaw : Number(graceRaw);
    if (
      !Number.isFinite(sourceCapGraceRemaining) ||
      sourceCapGraceRemaining < 0
    ) {
      sourceCapGraceRemaining = 0;
    }
    if (
      uniqueInformationSources.size >= maxUniqueSources &&
      !sourceCapTriggered
    ) {
      sourceCapTriggered = true;
      if (sourceCapGraceRemaining <= 0) {
        sourceCapGraceRemaining = 1;
      }
      context.setVariable(sourceCapFlagVar, true);
      context.setVariable(sourceCapGraceVar, sourceCapGraceRemaining);
    }
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
      const { result, statusInfo } = responseInterpreter.interpret(
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
          return buildInformationLimitFailure(
            context.workflowId,
            persona,
            step,
            infoBlocks,
            maxInfoIterations,
          );
        }

        if (sourceCapTriggered) {
          if (sourceCapGraceRemaining <= 0) {
            return buildInformationSourceCapFailure(
              context.workflowId,
              persona,
              step,
              infoBlocks,
              uniqueInformationSources.size,
              maxUniqueSources,
            );
          }

          sourceCapGraceRemaining = Math.max(0, sourceCapGraceRemaining - 1);
          context.setVariable(sourceCapGraceVar, sourceCapGraceRemaining);
          infoBlocks.push(
            buildSystemInformationBlock(
              `Additional information requests denied: already inspected ${uniqueInformationSources.size}/${maxUniqueSources} unique sources. Use existing evidence to proceed.`,
            ),
          );
          continue;
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
          infoBlocks.push(...acquisitions.map((record) => record.summaryBlock));
          context.setVariable(
            `${stepName}_information_iteration_${iteration}`,
            acquisitions,
          );
          context.setVariable(
            `${stepName}_information_blocks`,
            infoBlocks.slice(),
          );
        }

        const newSourcesTracked = recordInformationSources(
          acquisitions,
          uniqueInformationSources,
        );
        if (newSourcesTracked > 0) {
          context.setVariable(
            uniqueSourceVar,
            Array.from(uniqueInformationSources),
          );
        }
        if (
          !sourceCapTriggered &&
          uniqueInformationSources.size >= maxUniqueSources
        ) {
          sourceCapTriggered = true;
          if (sourceCapGraceRemaining <= 0) {
            sourceCapGraceRemaining = 1;
          }
          context.setVariable(sourceCapFlagVar, true);
          context.setVariable(sourceCapGraceVar, sourceCapGraceRemaining);
          infoBlocks.push(
            buildSystemInformationBlock(
              `Research cap reached after ${uniqueInformationSources.size} unique sources (limit ${maxUniqueSources}). Finalize findings; future requests will be blocked.`,
            ),
          );
        }
        context.setVariable(
          requestSignatureVar,
          Array.from(fulfilledRequestSignatures),
        );
        continue;
      }

      return handlePersonaCompletion(
        context,
        config,
        persona,
        step,
        retryResult,
        result,
        statusInfo,
        stepName,
        outputs,
      );
    }

    return buildInformationLimitFailure(
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
      error: error?.message,
      stack: error?.stack,
    });
    return {
      status: "failure",
      error: error instanceof Error ? error : new Error(String(error)),
      data: { step, persona },
    } satisfies StepResult;
  }
}
