import {
  NormalizedReviewFeedback,
  ReviewHistoryEntry,
} from "./types.js";

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
