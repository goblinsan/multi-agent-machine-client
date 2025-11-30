export interface PersonaRequestConfig {
  step: string;
  persona: string;
  intent: string;
  payload: Record<string, any>;
  timeout?: number;
  deadlineSeconds?: number;
  maxRetries?: number | null;
  abortOnFailure?: boolean;
  prompt_template?: string;
  maxInformationIterations?: number;
  maxInformationSources?: number;
  duplicateRequestForceIterations?: number;
}

export interface PersonaRequestContextPayload {
  workflowId: string;
  toPersona: string;
  step: string;
  intent: string;
  payload: Record<string, any>;
  repo: string;
  branch: string;
  projectId: string | undefined;
  taskId: string | number | undefined;
  deadlineSeconds: number;
}

export interface PersonaRetryOutcome {
  success: boolean;
  totalAttempts: number;
  finalTimeoutMs: number;
  lastCorrId: string;
  completion: Record<string, any>;
}
