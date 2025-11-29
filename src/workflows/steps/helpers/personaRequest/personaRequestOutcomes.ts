import { StepResult } from "../../../engine/WorkflowStep.js";
import { WorkflowContext } from "../../../engine/WorkflowContext.js";
import { logger } from "../../../../logger.js";
import type { PersonaRequestConfig } from "./types.js";
import type { InformationRequestRecord } from "../InformationRequestHandler.js";
import { parseRepoFilePath } from "../informationRequest/utils.js";

export function handlePersonaCompletion(
  context: WorkflowContext,
  config: PersonaRequestConfig,
  persona: string,
  step: string,
  retryResult: any,
  result: any,
  statusInfo: { status: "pass" | "fail" | "unknown"; details: string },
  stepName: string,
  outputs?: string[],
): StepResult {
  logger.info(`Persona request completed`, {
    workflowId: context.workflowId,
    step,
    persona,
    corrId: retryResult.lastCorrId,
    attempt: retryResult.totalAttempts,
    status: statusInfo.status,
    rawStatus: result?.status || "unknown",
  });

  applyOutputVariables(context, stepName, outputs, result);
  context.setVariable(`${stepName}_status`, statusInfo.status);

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
      errorFromPersona: result?.error || "Unknown error",
    });

    return {
      status: "failure",
      error: new Error(
        statusInfo.details || result?.error || "Persona request failed",
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

export function buildInformationLimitFailure(
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

export function buildInformationSourceCapFailure(
  workflowId: string,
  persona: string,
  step: string,
  infoBlocks: string[],
  uniqueSources: number,
  maxUniqueSources: number,
): StepResult {
  const message =
    `Persona '${persona}' exceeded the unique information source allowance (` +
    `${maxUniqueSources}) without providing a final response.`;
  logger.error("Information request source cap reached before completion", {
    workflowId,
    persona,
    step,
    maxUniqueSources,
    uniqueSources,
  });
  return {
    status: "failure",
    error: new Error(message),
    data: {
      step,
      persona,
      maxUniqueSources,
      uniqueSources,
      infoBlocks,
    },
  } satisfies StepResult;
}

export function recordInformationSources(
  acquisitions: InformationRequestRecord[],
  seenSources: Set<string>,
): number {
  let added = 0;
  for (const record of acquisitions) {
    if (record.status !== "success") {
      continue;
    }
    const key = resolveInformationSourceKey(record);
    if (!key || seenSources.has(key)) {
      continue;
    }
    seenSources.add(key);
    added += 1;
  }
  return added;
}

function resolveInformationSourceKey(
  record: InformationRequestRecord,
): string | null {
  if (record.request.type === "repo_file") {
    const rawPath = record.metadata?.path || record.request.path || "";
    if (!rawPath) {
      return null;
    }
    const { normalizedPath } = parseRepoFilePath(rawPath);
    return (normalizedPath || rawPath)
      .replace(/\\/g, "/")
      .replace(/^\/+/, "")
      .toLowerCase();
  }

  if (record.request.type === "http_get") {
    const url = (record.metadata?.url || record.request.url || "")
      .trim()
      .toLowerCase();
    return url.length ? url : null;
  }

  return null;
}

export function applyOutputVariables(
  context: WorkflowContext,
  stepName: string,
  outputs: string[] | undefined,
  result: any,
): void {
  if (outputs && outputs.length) {
    for (const output of outputs) {
      context.setVariable(output, result);
    }
  }

  if (result && typeof result === "object") {
    for (const [key, value] of Object.entries(result)) {
      context.setVariable(`${stepName}_${key}`, value);
    }
  }
}
