import { WorkflowContext } from "../../engine/WorkflowContext.js";
import {
  sendPersonaRequest,
  waitForPersonaCompletion,
} from "../../../agents/persona.js";
import { logger } from "../../../logger.js";
import { calculateProgressiveTimeout } from "../../../util.js";
import { MessageTransport } from "../../../transport/MessageTransport.js";

interface RetryConfig {
  baseTimeoutMs: number;
  maxRetries: number;
  isUnlimitedRetries: boolean;
  backoffIncrementMs: number;
}

interface PersonaRequestParams {
  workflowId: string;
  toPersona: string;
  step: string;
  intent: string;
  payload: Record<string, any>;
  repo: string;
  branch: string;
  projectId: string;
  taskId: string | undefined;
  deadlineSeconds: number;
}

interface RetryResult {
  success: boolean;
  completion: any | null;
  totalAttempts: number;
  lastCorrId: string;
  finalTimeoutMs: number;
}

export class PersonaRetryCoordinator {
  private static readonly HARD_CAP_ATTEMPTS = 100;

  constructor(private readonly config: RetryConfig) {}

  async executeWithRetry(
    transport: MessageTransport,
    params: PersonaRequestParams,
    _context: WorkflowContext,
  ): Promise<RetryResult> {
    const { baseTimeoutMs, maxRetries, isUnlimitedRetries, backoffIncrementMs } =
      this.config;

    let lastCorrId = "";
    let attempt = 0;
    let completion = null;

    logger.info(`Making persona request`, {
      workflowId: params.workflowId,
      step: params.step,
      persona: params.toPersona,
      intent: params.intent,
      baseTimeoutMs,
      baseTimeoutSec: (baseTimeoutMs / 1000).toFixed(1),
      maxRetries: isUnlimitedRetries ? "unlimited" : maxRetries,
      backoffIncrementMs,
    });

    while (
      (isUnlimitedRetries || attempt <= maxRetries) &&
      !completion &&
      attempt < PersonaRetryCoordinator.HARD_CAP_ATTEMPTS
    ) {
      attempt++;

      const currentTimeoutMs = calculateProgressiveTimeout(
        baseTimeoutMs,
        attempt,
        backoffIncrementMs,
      );

      this.logAttempt(
        params.workflowId,
        params.step,
        params.toPersona,
        attempt,
        currentTimeoutMs,
        baseTimeoutMs,
        backoffIncrementMs,
      );

      const corrId = await sendPersonaRequest(transport, params);
      lastCorrId = corrId;

      logger.info(`Persona request sent`, {
        workflowId: params.workflowId,
        step: params.step,
        persona: params.toPersona,
        corrId,
        attempt,
        timeoutMs: currentTimeoutMs,
      });

      try {
        completion = await waitForPersonaCompletion(
          transport,
          params.toPersona,
          params.workflowId,
          corrId,
          currentTimeoutMs,
        );
      } catch (error: any) {
        if (error.message && error.message.includes("Timed out waiting")) {
          completion = null;

          if (
            isUnlimitedRetries ||
            attempt < maxRetries ||
            attempt >= PersonaRetryCoordinator.HARD_CAP_ATTEMPTS
          ) {
            this.logTimeout(
              params.workflowId,
              params.step,
              params.toPersona,
              corrId,
              attempt,
              currentTimeoutMs,
              baseTimeoutMs,
              backoffIncrementMs,
              maxRetries,
              isUnlimitedRetries,
            );
          }
        } else {
          throw error;
        }
      }
    }

    const finalTimeoutMs = calculateProgressiveTimeout(
      baseTimeoutMs,
      attempt,
      backoffIncrementMs,
    );

    return {
      success: !!completion,
      completion,
      totalAttempts: attempt,
      lastCorrId,
      finalTimeoutMs,
    };
  }

  private logAttempt(
    workflowId: string,
    step: string,
    persona: string,
    attempt: number,
    currentTimeoutMs: number,
    baseTimeoutMs: number,
    backoffIncrementMs: number,
  ): void {
    if (attempt > 1) {
      logger.info(`Retrying persona request (progressive timeout)`, {
        workflowId,
        step,
        persona,
        attempt,
        maxRetries: this.config.isUnlimitedRetries
          ? "unlimited"
          : this.config.maxRetries,
        baseTimeoutMs,
        currentTimeoutMs,
        currentTimeoutMin: (currentTimeoutMs / 60000).toFixed(2),
        backoffIncrementMs,
      });
    } else {
      logger.info(`First attempt with base timeout`, {
        workflowId,
        step,
        persona,
        timeoutMs: currentTimeoutMs,
        timeoutMin: (currentTimeoutMs / 60000).toFixed(2),
      });
    }
  }

  private logTimeout(
    workflowId: string,
    step: string,
    persona: string,
    corrId: string,
    attempt: number,
    currentTimeoutMs: number,
    baseTimeoutMs: number,
    backoffIncrementMs: number,
    maxRetries: number,
    isUnlimitedRetries: boolean,
  ): void {
    logger.warn(
      `Persona request timed out, will retry with increased timeout`,
      {
        workflowId,
        step,
        persona,
        corrId,
        attempt,
        timedOutAtMs: currentTimeoutMs,
        timedOutAtMin: (currentTimeoutMs / 60000).toFixed(2),
        nextTimeoutMs: calculateProgressiveTimeout(
          baseTimeoutMs,
          attempt + 1,
          backoffIncrementMs,
        ),
        nextTimeoutMin: (
          calculateProgressiveTimeout(
            baseTimeoutMs,
            attempt + 1,
            backoffIncrementMs,
          ) / 60000
        ).toFixed(2),
        remainingRetries: isUnlimitedRetries
          ? "unlimited"
          : maxRetries - attempt,
      },
    );
  }

  public static createExhaustedRetriesError(
    persona: string,
    step: string,
    totalAttempts: number,
    baseTimeoutMs: number,
    finalTimeoutMs: number,
    maxRetries: number,
    isUnlimitedRetries: boolean,
    backoffIncrementMs: number,
    lastCorrId: string,
    workflowId: string,
  ): {
    message: string;
    logContext: Record<string, any>;
  } {
    const hitHardCap = totalAttempts >= PersonaRetryCoordinator.HARD_CAP_ATTEMPTS;

    const logContext = {
      workflowId,
      step,
      persona,
      totalAttempts,
      baseTimeoutMs,
      baseTimeoutMin: (baseTimeoutMs / 60000).toFixed(2),
      finalTimeoutMs,
      finalTimeoutMin: (finalTimeoutMs / 60000).toFixed(2),
      maxRetriesConfigured: isUnlimitedRetries ? "unlimited" : maxRetries,
      backoffIncrementMs,
      corrId: lastCorrId,
      hitHardCap,
      diagnostics: {
        reason: hitHardCap
          ? "Hit hard cap of 100 attempts (safety limit)"
          : "All retry attempts exhausted without successful completion",
        recommendation:
          "Check persona availability, LM Studio status, and increase timeout/retries if needed",
        configKeys: [
          "PERSONA_TIMEOUTS_JSON",
          "PERSONA_MAX_RETRIES_JSON",
          "PERSONA_DEFAULT_TIMEOUT_MS",
          "PERSONA_DEFAULT_MAX_RETRIES",
        ],
      },
    };

    const message =
      `Persona '${persona}' request timed out after ${totalAttempts} attempts. ` +
      `Base timeout: ${(baseTimeoutMs / 60000).toFixed(2)}min, ` +
      `Final timeout: ${(finalTimeoutMs / 60000).toFixed(2)}min. ` +
      `Workflow aborted. Check persona availability and configuration.`;

    return { message, logContext };
  }
}
