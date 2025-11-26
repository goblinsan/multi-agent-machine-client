import fs from "fs/promises";
import path from "path";
import {
  WorkflowStepConfig,
  StepResult,
} from "../../engine/WorkflowStep.js";
import { WorkflowContext } from "../../engine/WorkflowContext.js";
import { PersonaRequestStep } from "../PersonaRequestStep.js";
import { interpretPersonaStatus } from "../../../agents/persona.js";
import { requiresStatus } from "./personaStatusPolicy.js";

export type PersonaStatus = "pass" | "fail" | "unknown";

export interface AnalysisReviewLoopConfig {
  maxIterations?: number;
  analystPersona: string;
  reviewerPersona: string;
  analysisStep?: string;
  reviewStep?: string;
  analysisIntent?: string;
  reviewIntent?: string;
  analysisPromptTemplate?: string;
  reviewPromptTemplate?: string;
  payload?: Record<string, any>;
  reviewPayload?: Record<string, any>;
  deadlineSeconds?: number;
  analysisTimeout?: number;
  reviewTimeout?: number;
  analysisMaxRetries?: number;
  reviewMaxRetries?: number;
  autoPassReason?: string;
}

export interface PersonaInvocationConfig {
  name: string;
  step: string;
  persona: string;
  intent: string;
  payload: Record<string, any>;
  promptTemplate?: string;
  timeout?: number;
  deadlineSeconds?: number;
  maxRetries?: number;
  abortOnFailure?: boolean;
}

export interface NormalizedReviewFeedback {
  text: string;
  summary?: string;
  requiredRevisions?: string[];
  reason?: string;
  status?: string;
}

export interface ReviewHistoryEntry {
  iteration: number;
  raw: any;
  normalized?: NormalizedReviewFeedback | null;
}

export async function executePersonaInvocation(
  context: WorkflowContext,
  cfg: PersonaInvocationConfig,
): Promise<StepResult> {
  const stepConfig: WorkflowStepConfig = {
    name: cfg.name,
    type: "PersonaRequestStep",
    config: {
      step: cfg.step,
      persona: cfg.persona,
      intent: cfg.intent,
      payload: cfg.payload,
      prompt_template: cfg.promptTemplate,
      timeout: cfg.timeout,
      deadlineSeconds: cfg.deadlineSeconds,
      maxRetries: cfg.maxRetries,
      abortOnFailure: cfg.abortOnFailure,
    },
  };

  const step = new PersonaRequestStep(stepConfig);
  return step.execute(context);
}

export function extractPersonaOutputs(result: StepResult): any {
  if (result.outputs !== undefined) {
    return result.outputs;
  }
  if (result.data && typeof result.data === "object") {
    const payload = (result.data as any).result;
    if (payload !== undefined) {
      return payload;
    }
  }
  return null;
}

export function resolvePersonaStatus(
  context: WorkflowContext,
  stepName: string,
  persona: string,
  result: any,
): PersonaStatus {
  const contextStatus = context.getVariable(`${stepName}_status`);
  if (contextStatus === "pass" || contextStatus === "fail") {
    return contextStatus;
  }
  if (result && typeof result === "object" && typeof result.status === "string") {
    const normalized = result.status.toLowerCase();
    if (normalized === "pass" || normalized === "approved") return "pass";
    if (normalized === "fail" || normalized === "failed") return "fail";
  }
  if (typeof result === "string") {
    return interpretPersonaStatus(result, {
      persona,
      statusRequired: requiresStatus(persona),
    }).status as PersonaStatus;
  }
  return "unknown";
}

export function wrapAutoPass(
  result: any,
  iteration: number,
  reason?: string,
): Record<string, any> {
  return {
    status: "pass",
    reason: reason || "Auto-approved after exhausting analysis review attempts",
    auto_pass: true,
    iteration,
    previous_feedback: result,
  } satisfies Record<string, any>;
}

export function normalizeReviewFeedback(
  feedback: any,
): NormalizedReviewFeedback | null {
  if (!feedback) {
    return null;
  }

  if (typeof feedback === "string") {
    const trimmed = feedback.trim();
    return trimmed.length > 0 ? { text: trimmed } : null;
  }

  if (typeof feedback !== "object") {
    const asString = String(feedback).trim();
    return asString.length > 0 ? { text: asString } : null;
  }

  if (feedback.output && typeof feedback.output === "string") {
    return normalizeReviewFeedback(feedback.output);
  }

  const reason =
    typeof feedback.reason === "string" ? feedback.reason.trim() : undefined;
  const status =
    typeof feedback.status === "string" ? feedback.status.trim() : undefined;
  const requiredRevisions = Array.isArray(feedback.required_revisions)
    ? feedback.required_revisions
        .map((entry: unknown) =>
          typeof entry === "string" ? entry.trim() : String(entry),
        )
        .filter((entry: string) => entry.length > 0)
    : undefined;

  const lines: string[] = [];
  if (status) {
    lines.push(`status: ${status}`);
  }
  if (reason) {
    lines.push(`reason: ${reason}`);
  }
  if (requiredRevisions && requiredRevisions.length > 0) {
    lines.push("required revisions:");
    for (const revision of requiredRevisions) {
      lines.push(`- ${revision}`);
    }
  }

  if (lines.length === 0) {
    try {
      return {
        text: JSON.stringify(feedback, null, 2),
      } satisfies NormalizedReviewFeedback;
    } catch {
      return {
        text: String(feedback),
      } satisfies NormalizedReviewFeedback;
    }
  }

  return {
    text: lines.join("\n"),
    summary: reason,
    requiredRevisions,
    reason,
    status,
  } satisfies NormalizedReviewFeedback;
}

export function buildRevisionDirective(
  feedback: NormalizedReviewFeedback | null,
): string | undefined {
  if (!feedback) {
    return undefined;
  }
  const segments: string[] = [
    "Refine the previous analysis so it directly addresses the reviewer feedback.",
  ];
  if (feedback.reason) {
    segments.push(`Reviewer reason: ${feedback.reason}`);
  }
  if (feedback.requiredRevisions && feedback.requiredRevisions.length > 0) {
    segments.push(`Required revisions: ${feedback.requiredRevisions.join("; ")}`);
  }
  return segments.join(" ");
}

export function buildReviewFeedbackHistoryDigest(
  history: ReviewHistoryEntry[],
): string | undefined {
  if (history.length === 0) {
    return undefined;
  }
  const sections = history
    .map((entry) => {
      const text = entry.normalized?.text || stringifyForPrompt(entry.raw);
      if (!text) {
        return null;
      }
      return `Attempt ${entry.iteration} reviewer feedback:\n${text.trim()}`;
    })
    .filter((value): value is string => Boolean(value));
  if (sections.length === 0) {
    return undefined;
  }
  return sections.join("\n\n");
}

export function serializeReviewHistory(
  history: ReviewHistoryEntry[],
): Array<Record<string, any>> {
  return history.map((entry) => ({
    iteration: entry.iteration,
    status: entry.normalized?.status,
    summary: entry.normalized?.summary,
    required_revisions: entry.normalized?.requiredRevisions,
    text: entry.normalized?.text || stringifyForPrompt(entry.raw) || undefined,
  }));
}

export function buildContextOverview(insights: any): string | undefined {
  if (!insights || typeof insights !== "object") {
    return undefined;
  }
  const segments: string[] = [];
  if (
    typeof insights.primaryLanguage === "string" &&
    insights.primaryLanguage.trim().length > 0
  ) {
    segments.push(`Primary Language: ${insights.primaryLanguage}`);
  }
  if (Array.isArray(insights.frameworks) && insights.frameworks.length > 0) {
    segments.push(`Frameworks: ${insights.frameworks.join(", ")}`);
  }
  if (
    Array.isArray(insights.potentialIssues) &&
    insights.potentialIssues.length > 0
  ) {
    segments.push(`Potential Issues: ${insights.potentialIssues.join("; ")}`);
  }
  if (segments.length === 0) {
    return undefined;
  }
  return segments.join("\n");
}

export function extractAcceptanceCriteria(task: any): string[] | undefined {
  const record = unwrapTask(task);
  if (!record || typeof record !== "object") {
    return undefined;
  }

  const candidates = [
    record.acceptance_criteria,
    record.acceptanceCriteria,
    record.requirements,
    task && task !== record ? task.acceptance_criteria : undefined,
    task && task !== record ? task.acceptanceCriteria : undefined,
    task && task !== record ? task.requirements : undefined,
  ];

  for (const candidate of candidates) {
    const normalized = normalizeCriteria(candidate);
    if (normalized.length > 0) {
      return normalized;
    }
  }

  return undefined;
}

function normalizeCriteria(candidate: any): string[] {
  if (!candidate) {
    return [];
  }
  if (Array.isArray(candidate)) {
    return candidate
      .map((entry) => (entry === null || entry === undefined ? "" : String(entry)))
      .map((entry) => entry.trim())
      .filter((entry) => entry.length > 0);
  }

  if (typeof candidate === "string") {
    return candidate
      .split(/\r?\n|\u2022|-/)
      .map((entry) => entry.trim())
      .filter((entry) => entry.length > 0);
  }

  return [];
}

export function buildQaFindingsText(
  task: any,
  acceptance?: string[],
): string | undefined {
  const record = unwrapTask(task);
  const sections: string[] = [];
  const description = extractTaskDescription(record, task);
  if (description) {
    sections.push(`Task Description:\n${description.trim()}`);
  }
  if (acceptance && acceptance.length > 0) {
    const lines = acceptance.map((entry) => `- ${entry}`).join("\n");
    sections.push(`Acceptance Criteria:\n${lines}`);
  }
  if (sections.length === 0) {
    return undefined;
  }
  return sections.join("\n\n");
}

export function buildAnalysisGoal(
  basePayload: Record<string, any>,
  task: any,
  reviewTypeLabel?: string,
): string | undefined {
  if (typeof basePayload.analysis_goal === "string") {
    return basePayload.analysis_goal;
  }
  if (typeof basePayload.goal === "string") {
    return basePayload.goal;
  }
  const record = unwrapTask(task);
  if (record && typeof record === "object") {
    const taskId = record.id ? `#${record.id}` : "";
    if (typeof record.title === "string" && record.title.trim().length > 0) {
      const reviewLabel = reviewTypeLabel || "review";
      return `Resolve ${reviewLabel} findings for task ${taskId} ${record.title}`.trim();
    }
    if (
      typeof record.description === "string" &&
      record.description.trim().length > 0
    ) {
      return record.description;
    }
  }
  return undefined;
}

export function unwrapTask(task: any): any {
  if (task && typeof task === "object" && task.data && typeof task.data === "object") {
    return task.data;
  }
  return task;
}

export function extractTaskDescription(
  taskRecord: any,
  fallback?: any,
): string | undefined {
  if (
    taskRecord &&
    typeof taskRecord.description === "string" &&
    taskRecord.description.trim().length > 0
  ) {
    return taskRecord.description;
  }
  if (
    fallback &&
    typeof fallback.description === "string" &&
    fallback.description.trim().length > 0
  ) {
    return fallback.description;
  }
  return undefined;
}

export function extractParentTaskId(
  taskRecord: any,
  fallback?: any,
): number | undefined {
  const candidates = [
    taskRecord?.parent_task_id,
    taskRecord?.parentTaskId,
    fallback?.parent_task_id,
    fallback?.parentTaskId,
  ];

  for (const candidate of candidates) {
    if (typeof candidate === "number" && Number.isFinite(candidate)) {
      return candidate;
    }
    if (typeof candidate === "string" && candidate.trim().length > 0) {
      const parsed = Number(candidate.trim());
      if (!Number.isNaN(parsed)) {
        return parsed;
      }
    }
  }

  return undefined;
}

export function detectReviewType(
  taskRecord: any,
  fallback?: any,
): string | undefined {
  const candidates = [
    taskRecord?.review_type,
    fallback?.review_type,
    normalizeExternalId(taskRecord?.external_id || taskRecord?.externalId),
    normalizeExternalId(fallback?.external_id || fallback?.externalId),
  ];

  for (const candidate of candidates) {
    const resolved = parseReviewType(candidate);
    if (resolved) {
      return resolved;
    }
  }

  const labelMatch = normalizeLabels(taskRecord?.labels)?.find((label) =>
    isKnownReviewType(label),
  );
  if (labelMatch) {
    return labelMatch as string;
  }

  const fallbackLabel = normalizeLabels(fallback?.labels)?.find((label) =>
    isKnownReviewType(label),
  );
  if (fallbackLabel) {
    return fallbackLabel as string;
  }

  const title = normalizeString(taskRecord?.title || fallback?.title);
  if (title) {
    if (title.startsWith("qa ")) return "qa";
    if (title.includes("code review")) return "code_review";
    if (title.includes("security")) return "security_review";
    if (title.includes("devops")) return "devops_review";
  }

  return undefined;
}

function normalizeString(value: any): string | undefined {
  if (typeof value === "string") {
    const normalized = value.trim();
    return normalized.length > 0 ? normalized.toLowerCase() : undefined;
  }
  return undefined;
}

function normalizeExternalId(value: any): string | undefined {
  if (!value || typeof value !== "string") {
    return undefined;
  }
  const lower = value.trim().toLowerCase();
  if (lower.startsWith("qa-")) return "qa";
  if (lower.startsWith("code_review-")) return "code_review";
  if (lower.startsWith("security_review-")) return "security_review";
  if (lower.startsWith("devops_review-")) return "devops_review";
  return undefined;
}

function normalizeLabels(value: any): string[] | undefined {
  if (!value) {
    return undefined;
  }
  if (Array.isArray(value)) {
    return value
      .map((label) => (typeof label === "string" ? label.trim().toLowerCase() : ""))
      .filter((label) => label.length > 0);
  }
  if (typeof value === "string") {
    try {
      const parsed = JSON.parse(value);
      if (Array.isArray(parsed)) {
        return normalizeLabels(parsed);
      }
    } catch {}
    return value
      .split(/[,:\s]+/)
      .map((label) => label.trim().toLowerCase())
      .filter((label) => label.length > 0);
  }
  return undefined;
}

function parseReviewType(value: any): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const normalized = value.trim().toLowerCase();
  if (isKnownReviewType(normalized)) {
    return normalized as string;
  }
  return undefined;
}

function isKnownReviewType(value: string | undefined): boolean {
  if (!value) {
    return false;
  }
  return ["qa", "code_review", "security_review", "devops_review"].includes(
    value,
  );
}

export function formatReviewType(reviewType: string): string {
  const mapping: Record<string, string> = {
    qa: "QA",
    code_review: "Code Review",
    security_review: "Security Review",
    devops_review: "DevOps Review",
  };
  return mapping[reviewType] || reviewType;
}

export async function loadReviewFailureLog(
  repoRoot: string,
  parentTaskId?: number,
  reviewType?: string,
): Promise<{ logText?: string; sourcePath?: string }> {
  if (!repoRoot || !parentTaskId || !reviewType) {
    return {};
  }

  const fileName = getReviewArtifactFileName(reviewType);
  if (!fileName) {
    return {};
  }

  const artifactPath = path.join(
    repoRoot,
    ".ma",
    "tasks",
    String(parentTaskId),
    "reviews",
    fileName,
  );

  try {
    const content = await fs.readFile(artifactPath, "utf-8");
    const trimmed = content.trim();
    return trimmed.length > 0
      ? { logText: trimmed, sourcePath: artifactPath }
      : { sourcePath: artifactPath };
  } catch {
    return {};
  }
}

function getReviewArtifactFileName(reviewType: string): string | undefined {
  switch (reviewType) {
    case "qa":
      return "qa.json";
    case "code_review":
      return "code-review.json";
    case "security_review":
      return "security.json";
    case "devops_review":
      return "devops.json";
    default:
      return undefined;
  }
}

export function stringifyForPrompt(value: any): string | undefined {
  if (!value) {
    return undefined;
  }
  if (typeof value === "string") {
    return value;
  }
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}
