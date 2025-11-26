import { WorkflowContext } from "../../../engine/WorkflowContext.js";
import { cfg } from "../../../../config.js";
import { personaTimeoutMs, personaMaxRetries } from "../../../../util.js";
import { PersonaRetryCoordinator } from "../PersonaRetryCoordinator.js";
import { PersonaRequestConfig } from "./types.js";

export interface RetryCoordinatorParams {
  baseTimeoutMs: number;
  configuredMaxRetries: number | null | undefined;
}

export interface RetryCoordinatorSetup {
  coordinator: PersonaRetryCoordinator;
  baseTimeoutMs: number;
  effectiveMaxRetries: number;
  isUnlimitedRetries: boolean;
}

export function resolveRepoForPersona(context: WorkflowContext): string {
  const repoForPersona =
    context.getVariable("repo_remote") ||
    context.getVariable("repo") ||
    context.getVariable("effective_repo_path");

  if (!repoForPersona) {
    throw new Error(
      "Cannot send persona request: no repository remote URL available. Local paths cannot be shared across distributed agents.",
    );
  }

  return repoForPersona;
}

export function computeRetryParameters(
  persona: string,
  config: PersonaRequestConfig,
): RetryCoordinatorParams {
  const baseTimeoutMs = config.timeout ?? personaTimeoutMs(persona, cfg);
  const configuredMaxRetries =
    config.maxRetries !== undefined
      ? config.maxRetries
      : personaMaxRetries(persona, cfg);

  return { baseTimeoutMs, configuredMaxRetries };
}

export function createRetryCoordinator(
  persona: string,
  params: RetryCoordinatorParams,
): RetryCoordinatorSetup {
  const { baseTimeoutMs, configuredMaxRetries } = params;
  const effectiveMaxRetries =
    configuredMaxRetries === null || configuredMaxRetries === undefined
      ? Number.MAX_SAFE_INTEGER
      : configuredMaxRetries;
  const isUnlimitedRetries = configuredMaxRetries === null;

  const coordinator = new PersonaRetryCoordinator({
    baseTimeoutMs,
    maxRetries: effectiveMaxRetries,
    isUnlimitedRetries,
    backoffIncrementMs: cfg.personaRetryBackoffIncrementMs,
  });

  return {
    coordinator,
    baseTimeoutMs,
    effectiveMaxRetries,
    isUnlimitedRetries,
  } satisfies RetryCoordinatorSetup;
}
