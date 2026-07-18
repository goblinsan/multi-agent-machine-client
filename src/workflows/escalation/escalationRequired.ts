export interface EscalationFile {
  path: string;
  contract: string;
}

export interface EscalationDetails {
  changeSlug: string;
  failingFiles: EscalationFile[];
  convergenceErrors: string[];
  attempts: number;
}

export const ESCALATION_REASON = "escalation_required";
export const ESCALATION_ARTIFACT_KIND = "escalation_required";

export class EscalationRequiredError extends Error {
  readonly changeSlug: string;
  readonly failingFiles: EscalationFile[];
  readonly convergenceErrors: string[];
  readonly attempts: number;

  constructor(details: EscalationDetails) {
    super(
      `Change '${details.changeSlug}' requires escalation after ${details.attempts} convergence attempt(s)`,
    );
    this.name = "EscalationRequiredError";
    this.changeSlug = details.changeSlug;
    this.failingFiles = details.failingFiles;
    this.convergenceErrors = details.convergenceErrors;
    this.attempts = details.attempts;
  }
}

export function escalationRequired(details: EscalationDetails): never {
  throw new EscalationRequiredError(details);
}

export function isEscalationRequired(
  error: unknown,
): error is EscalationRequiredError {
  return error instanceof EscalationRequiredError;
}

export function toEscalationArtifact(error: EscalationRequiredError): {
  kind: string;
  content: string;
} {
  return {
    kind: ESCALATION_ARTIFACT_KIND,
    content: JSON.stringify(
      {
        reason: ESCALATION_REASON,
        changeSlug: error.changeSlug,
        attempts: error.attempts,
        failingFiles: error.failingFiles,
        convergenceErrors: error.convergenceErrors,
      },
      null,
      2,
    ),
  };
}

export interface EscalationHandlerDeps {
  blockChange: (changeSlug: string, reason: string) => Promise<void>;
  publishArtifact: (artifact: {
    kind: string;
    content: string;
  }) => Promise<void>;
  reviewAndReplan?: (error: EscalationRequiredError) => Promise<boolean>;
}

export async function handleEscalationRequired(
  error: EscalationRequiredError,
  deps: EscalationHandlerDeps,
): Promise<{ replanned: boolean }> {
  await deps.publishArtifact(toEscalationArtifact(error));

  if (deps.reviewAndReplan) {
    const replanned = await deps.reviewAndReplan(error);
    if (replanned) {
      return { replanned: true };
    }
  }

  await deps.blockChange(error.changeSlug, ESCALATION_REASON);
  return { replanned: false };
}
