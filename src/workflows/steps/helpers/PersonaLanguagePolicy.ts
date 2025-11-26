import { WorkflowContext } from "../../engine/WorkflowContext.js";
import {
  collectAllowedLanguages as collectAllowedLanguagesFromInsights,
  mergeAllowedLanguages,
  findLanguageViolationsForFiles,
  detectLanguagesInText,
  type LanguageViolation,
} from "./languagePolicy.js";

export interface LanguagePolicyResult {
  result: any;
  errorMessage: string;
  violations: LanguageViolation[];
}

export function evaluateCodeReviewLanguagePolicy(
  context: WorkflowContext,
  persona: string,
  payload: Record<string, any>,
): LanguagePolicyResult | null {
  if (persona !== "code-reviewer") {
    return null;
  }

  const changedFiles = collectChangedFilesForReview(context, payload);
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

  const payloadAllowed = toStringArray(payload.allowed_languages);
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
  } satisfies LanguagePolicyResult;
}

function collectChangedFilesForReview(
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

function toStringArray(value: unknown): string[] {
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
