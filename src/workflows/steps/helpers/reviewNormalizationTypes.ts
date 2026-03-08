export type Severity = "critical" | "high" | "medium" | "low";

export interface NormalizationConfig {
  review_type: string;
  review_result: Record<string, any> | null;
  review_status: string;
  pre_qa_test_error?: string | null;
  task?: { id?: number | string; title?: string } | null;
  feature_branch?: string | null;
}

export interface NormalizedIssue {
  id: string;
  title: string;
  description: string;
  severity: Severity;
  blocking: boolean;
  labels: string[];
  source: string;
  file?: string;
  line?: number | null;
  raw?: Record<string, any>;
}

export interface NormalizedReview {
  reviewType: string;
  status: string;
  severity: Severity;
  issues: NormalizedIssue[];
  blockingIssues: NormalizedIssue[];
  hasBlockingIssues: boolean;
  summary?: string;
  raw: Record<string, any>;
}

export interface SeverityGapEvent {
  reviewType: string;
  source: string;
  field: string;
  fallback: Severity;
  rawSeverity: any;
}

export const severityOrder: Record<Severity, number> = {
  critical: 4,
  high: 3,
  medium: 2,
  low: 1,
};

export function parseTestErrors(errorText: string): { file: string; line: number; message: string }[] {
  const results: { file: string; line: number; message: string }[] = [];
  const patterns = [
    /([^\s:]+\.[a-z]{1,4}):(\d+):\d+:\s*(?:ERROR|error):\s*(.+)/g,
    /(?:error|ERROR)\s+(?:in|at)\s+([^\s:]+\.[a-z]{1,4}):(\d+)(?::\d+)?[:\s]+(.+)/g,
    /([^\s:]+\.[a-z]{1,4})\((\d+),\d+\):\s*error\s+\w+:\s*(.+)/g,
    /SyntaxError:\s*(.+?)(?:\n|\r|$)[\s\S]*?at\s+([^\s:]+\.[a-z]{1,4}):(\d+)/g,
  ];

  for (const pattern of patterns) {
    let match;
    while ((match = pattern.exec(errorText)) !== null) {
      if (pattern === patterns[3]) {
        results.push({ file: match[2], line: parseInt(match[3], 10), message: match[1].trim() });
      } else {
        results.push({ file: match[1], line: parseInt(match[2], 10), message: match[3].trim() });
      }
    }
  }

  const seen = new Set<string>();
  return results.filter((r) => {
    const key = `${r.file}:${r.line}`;
    if (seen.has(key)) {
      return false;
    }
    seen.add(key);
    return true;
  });
}

export function normalizeSeverity(
  value: any,
  fallback: Severity = "medium",
  tracking?: {
    severityGaps: SeverityGapEvent[];
    reviewType: string;
    source: string;
    field: string;
  },
): Severity {
  let severity: Severity = fallback;
  let usedFallback = false;

  if (value === undefined || value === null) {
    usedFallback = true;
  } else if (typeof value === "string") {
    const normalized = value.toLowerCase();
    if (normalized.includes("critical") || normalized.includes("severe")) {
      severity = "critical";
    } else if (normalized.includes("high") || normalized.includes("blocker")) {
      severity = "high";
    } else if (normalized.includes("medium") || normalized.includes("moderate")) {
      severity = "medium";
    } else if (normalized.includes("low") || normalized.includes("minor")) {
      severity = "low";
    } else {
      usedFallback = true;
    }
  } else if (typeof value === "number") {
    if (value >= 0.9) severity = "critical";
    else if (value >= 0.6) severity = "high";
    else if (value >= 0.3) severity = "medium";
    else severity = "low";
  } else if (typeof value === "boolean") {
    severity = value ? "high" : fallback;
    if (!value) {
      usedFallback = true;
    }
  } else {
    usedFallback = true;
  }

  if (usedFallback && tracking) {
    tracking.severityGaps.push({
      reviewType: tracking.reviewType,
      source: tracking.source,
      field: tracking.field,
      fallback,
      rawSeverity: value,
    });
  }

  return severity;
}

export function isInfraGap(text: string): boolean {
  const normalized = text.toLowerCase();
  const keywords = [
    "test framework",
    "missing test",
    "no test",
    "unable to run tests",
    "testing infrastructure",
    "qa cannot run",
    "lack of tests",
    "vitest",
    "jest",
    "pytest",
  ];
  return keywords.some((keyword) => normalized.includes(keyword));
}
