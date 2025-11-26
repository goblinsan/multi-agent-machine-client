import fs from "fs/promises";
import path from "path";

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
    let parsed: unknown = null;
    try {
      parsed = JSON.parse(value);
    } catch (_error) {
      parsed = null;
    }
    if (Array.isArray(parsed)) {
      return normalizeLabels(parsed);
    }
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
