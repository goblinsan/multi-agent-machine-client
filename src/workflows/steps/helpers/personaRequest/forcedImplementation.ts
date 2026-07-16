import { StepResult } from "../../../engine/WorkflowStep.js";
import { WorkflowContext } from "../../../engine/WorkflowContext.js";
import { logger } from "../../../../logger.js";
import { PersonaRetryCoordinator } from "../PersonaRetryCoordinator.js";
import { PersonaResponseInterpreter } from "../PersonaResponseInterpreter.js";
import type { PersonaRequestConfig } from "./types.js";
import {
  buildIterationPayload,
  buildSystemInformationBlock,
  extractInformationRequestPayload,
} from "./informationUtils.js";
import {
  handlePersonaCompletion,
  buildForcedSynthesisFailure,
} from "./personaRequestOutcomes.js";
import { DiffParser } from "../../../../agents/parsers/DiffParser.js";

const FORCE_DIRECTIVE =
  "Information gathering is now closed. You already have every file you will be given; they are shown above. " +
  "Do NOT request more information. Output the COMPLETE implementation now as one or more " +
  "```file path=<relative-path> blocks containing the full contents of each file. " +
  "The target file may not exist yet - create it. Import only symbols that actually exist in the files shown above.";

export type ForcedSynthesisMeta = {
  duplicateIterations?: number;
  uniqueSources?: number;
  maxUniqueSources?: number;
};

export type ForcedImplementationArgs = {
  context: WorkflowContext;
  persona: string;
  step: string;
  intent: string;
  stepName: string;
  outputs?: string[];
  config: PersonaRequestConfig;
  transport: any;
  retryCoordinator: PersonaRetryCoordinator;
  responseInterpreter: PersonaResponseInterpreter;
  infoBlocks: string[];
  resolvedPayload: Record<string, any>;
  baseUserText: string;
  maxInfoIterations: number;
  repoForPersona: string;
  currentBranch: string;
  deadlineSeconds: number;
  taskId: any;
  meta?: ForcedSynthesisMeta;
};

export function forcedResponseCarriesEdits(
  completion: any,
  interpreted: any,
): boolean {
  const candidates: string[] = [];
  const push = (value: any): void => {
    if (typeof value !== "string" || !value) return;
    candidates.push(value);
    try {
      const parsed = JSON.parse(value);
      if (parsed && typeof parsed.output === "string") {
        candidates.push(parsed.output);
      }
    } catch {
      void 0;
    }
  };
  push(completion?.fields?.result);
  push(completion?.fields?.output);
  push(completion?.content);
  if (typeof interpreted === "string") {
    push(interpreted);
  } else if (interpreted && typeof interpreted === "object") {
    push(interpreted.output);
    push(interpreted.result);
    push(interpreted.implementation_diff);
  }
  for (const candidate of candidates) {
    try {
      const parsed = DiffParser.parsePersonaResponse(candidate);
      if (parsed.success && (parsed.editSpec?.ops?.length ?? 0) > 0) {
        return true;
      }
    } catch {
      void 0;
    }
  }
  return false;
}

export async function runForcedImplementationAttempt(
  args: ForcedImplementationArgs,
): Promise<StepResult> {
  const {
    context,
    persona,
    step,
    intent,
    stepName,
    outputs,
    config,
    transport,
    retryCoordinator,
    responseInterpreter,
    infoBlocks,
    resolvedPayload,
    baseUserText,
    maxInfoIterations,
    repoForPersona,
    currentBranch,
    deadlineSeconds,
    taskId,
    meta,
  } = args;

  const directiveBlocks = [
    ...infoBlocks,
    buildSystemInformationBlock(FORCE_DIRECTIVE),
  ];
  const forcedPayload = buildIterationPayload(
    resolvedPayload,
    baseUserText,
    directiveBlocks,
    maxInfoIterations,
    maxInfoIterations,
  );

  logger.info("Forcing implementation output after information loop", {
    workflowId: context.workflowId,
    step,
    persona,
    duplicateIterations: meta?.duplicateIterations,
    uniqueSources: meta?.uniqueSources,
  });

  const forcedResult = await retryCoordinator.executeWithRetry(
    transport,
    {
      workflowId: context.workflowId,
      toPersona: persona,
      step,
      intent,
      payload: forcedPayload,
      repo: repoForPersona,
      branch: currentBranch,
      projectId: context.projectId,
      taskId,
      deadlineSeconds,
    },
    context,
  );

  if (!forcedResult.success) {
    return buildForcedSynthesisFailure(
      context,
      persona,
      step,
      infoBlocks,
      stepName,
      meta,
    );
  }

  const forcedRaw = forcedResult.completion.fields?.result || "";
  const changedFilesRaw = context.getVariable("review_diff_files");
  const changedFiles = Array.isArray(changedFilesRaw)
    ? changedFilesRaw.filter((f: unknown) => typeof f === "string")
    : undefined;
  const { result: forcedInterpreted, statusInfo: forcedStatus } =
    responseInterpreter.interpret(
      forcedRaw,
      persona,
      context.workflowId,
      step,
      forcedResult.lastCorrId,
      forcedResult.completion,
      changedFiles,
    );

  const stillRequestingInfo = extractInformationRequestPayload(
    forcedInterpreted,
    forcedResult.completion,
  );
  if (
    stillRequestingInfo &&
    !forcedResponseCarriesEdits(forcedResult.completion, forcedInterpreted)
  ) {
    logger.warn(
      "Persona kept requesting information after forced implementation directive",
      { workflowId: context.workflowId, step, persona },
    );
    return buildForcedSynthesisFailure(
      context,
      persona,
      step,
      infoBlocks,
      stepName,
      meta,
    );
  }

  return handlePersonaCompletion(
    context,
    config,
    persona,
    step,
    forcedResult,
    forcedInterpreted,
    forcedStatus,
    stepName,
    outputs,
  );
}
