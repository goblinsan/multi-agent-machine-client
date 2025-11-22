import {
  WorkflowStep,
  StepResult,
  ValidationResult,
  WorkflowStepConfig,
} from "../engine/WorkflowStep.js";
import { WorkflowContext } from "../engine/WorkflowContext.js";
import { logger } from "../../logger.js";

interface NormalizationConfig {
  review_type: string;
  review_result: Record<string, any> | null;
  review_status: string;
  task?: { id?: number | string; title?: string } | null;
  feature_branch?: string | null;
}

type Severity = "critical" | "high" | "medium" | "low";

interface NormalizedIssue {
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

interface NormalizedReview {
  reviewType: string;
  status: string;
  severity: Severity;
  issues: NormalizedIssue[];
  blockingIssues: NormalizedIssue[];
  hasBlockingIssues: boolean;
  summary?: string;
  raw: Record<string, any>;
}

interface SeverityGapEvent {
  reviewType: string;
  source: string;
  field: string;
  fallback: Severity;
  rawSeverity: any;
}

const severityOrder: Record<Severity, number> = {
  critical: 4,
  high: 3,
  medium: 2,
  low: 1,
};

export class ReviewFailureNormalizationStep extends WorkflowStep {
  protected async validateConfig(
    _context: WorkflowContext,
  ): Promise<ValidationResult> {
    const errors: string[] = [];
    const config = this.config.config as NormalizationConfig;

    if (!config.review_type) {
      errors.push("review_type is required");
    }

    if (!config.review_status) {
      errors.push("review_status is required");
    }

    return { valid: errors.length === 0, errors, warnings: [] };
  }

  async execute(context: WorkflowContext): Promise<StepResult> {
    const startTime = Date.now();
    const config = this.config.config as NormalizationConfig;
    const reviewResult = config.review_result;

    if (!reviewResult || typeof reviewResult !== "object") {
      throw new Error("review_result is required and must be an object");
    }

    this.assertBranchAlignment(context, config.feature_branch);

    const { normalized, severityGaps } = this.normalizeReview(
      config.review_type,
      reviewResult,
      config.review_status,
    );

    if (severityGaps.length > 0) {
      context.logger.warn("Severity gaps detected during normalization", {
        stepName: this.config.name,
        reviewType: normalized.reviewType,
        gapCount: severityGaps.length,
        fields: this.summarizeSeverityGaps(severityGaps),
      });
    }

    context.logger.info("Normalized review failure payload", {
      stepName: this.config.name,
      reviewType: normalized.reviewType,
      blockingIssueCount: normalized.blockingIssues.length,
      severity: normalized.severity,
    });

    return {
      status: "success",
      data: normalized,
      outputs: {
        normalized_review: normalized,
        blocking_issue_count: normalized.blockingIssues.length,
        has_blocking_issues: normalized.blockingIssues.length > 0,
      },
      metrics: {
        duration_ms: Date.now() - startTime,
        severity_gap_count: severityGaps.length,
      },
    } satisfies StepResult;
  }

  private assertBranchAlignment(
    context: WorkflowContext,
    expectedBranch?: string | null,
  ): void {
    if (!expectedBranch) {
      return;
    }
    const current = context.getCurrentBranch();
    if (current && current !== expectedBranch) {
      throw new Error(
        `Review failure handling invoked on branch '${current}' but expected '${expectedBranch}'`,
      );
    }
  }

  private summarizeSeverityGaps(events: SeverityGapEvent[]): Record<string, number> {
    return events.reduce<Record<string, number>>((acc, event) => {
      const key = `${event.source}.${event.field}`;
      acc[key] = (acc[key] || 0) + 1;
      return acc;
    }, {});
  }

  private normalizeReview(
    reviewType: string,
    reviewResult: Record<string, any>,
    reviewStatus: string,
  ): { normalized: NormalizedReview; severityGaps: SeverityGapEvent[] } {
    const severityGaps: SeverityGapEvent[] = [];
    const issues = this.collectIssues(
      reviewType,
      reviewResult,
      reviewStatus,
      severityGaps,
    );
    const blockingIssues = issues.filter((issue) => issue.blocking);
    const maxSeverity = issues.reduce<Severity>(
      (current, issue) =>
        severityOrder[issue.severity] > severityOrder[current]
          ? issue.severity
          : current,
      blockingIssues[0]?.severity || (reviewStatus === "fail" ? "high" : "low"),
    );

    return {
      normalized: {
        reviewType,
        status: reviewStatus,
        severity: maxSeverity,
        issues,
        blockingIssues,
        hasBlockingIssues: blockingIssues.length > 0,
        summary:
          typeof reviewResult.summary === "string"
            ? reviewResult.summary
            : undefined,
        raw: reviewResult,
      },
      severityGaps,
    };
  }

  private collectIssues(
    reviewType: string,
    reviewResult: Record<string, any>,
    reviewStatus: string,
    severityGaps: SeverityGapEvent[],
  ): NormalizedIssue[] {
    const issues: NormalizedIssue[] = [];
    const baseSeverity = this.normalizeSeverity(
      reviewResult.severity,
      reviewStatus === "fail" ? "high" : "medium",
      {
        severityGaps,
        reviewType,
        source: reviewType,
        field: "review_result.severity",
      },
    );

    this.fromRootCauses(
      reviewType,
      reviewResult,
      baseSeverity,
      issues,
      severityGaps,
    );
    this.fromFindings(reviewType, reviewResult, issues, severityGaps);
    this.fromIssuesArray(reviewType, reviewResult, issues, severityGaps);
    this.fromCriticalAnalysis(
      reviewType,
      reviewResult,
      baseSeverity,
      issues,
      severityGaps,
    );

    if (issues.length === 0 && reviewStatus !== "pass") {
      issues.push(this.buildFallbackIssue(reviewType, reviewResult, baseSeverity));
    }

    return issues;
  }

  private fromRootCauses(
    reviewType: string,
    reviewResult: Record<string, any>,
    defaultSeverity: Severity,
    issues: NormalizedIssue[],
    severityGaps: SeverityGapEvent[],
  ): void {
    if (!Array.isArray(reviewResult.root_causes)) {
      return;
    }

    reviewResult.root_causes.forEach((cause: any, index: number) => {
      const description = this.stringifyCause(cause);
      if (!description) {
        return;
      }

      const severity = this.normalizeSeverity(cause?.severity, defaultSeverity, {
        severityGaps,
        reviewType,
        source: reviewType,
        field: `root_causes.${index}`,
      });
      issues.push(
        this.buildIssue(
          reviewType,
          `root_cause-${index}`,
          typeof cause === "string" ? cause : cause?.title || description,
          description,
          severity,
          true,
          this.extractLabels(reviewType, description),
          cause,
        ),
      );
    });
  }

  private fromFindings(
    reviewType: string,
    reviewResult: Record<string, any>,
    issues: NormalizedIssue[],
    severityGaps: SeverityGapEvent[],
  ): void {
    const findings = reviewResult.findings;
    if (!findings || typeof findings !== "object") {
      return;
    }

    Object.entries(findings).forEach(([bucket, entries]) => {
      if (!Array.isArray(entries)) {
        return;
      }

      entries.forEach((entry: any, index: number) => {
        const description =
          entry?.description || entry?.issue || entry?.summary || String(entry);
        if (!description || typeof description !== "string") {
          return;
        }

        const severity = this.normalizeSeverity(entry?.severity || bucket, "medium", {
          severityGaps,
          reviewType,
          source: reviewType,
          field: `findings.${bucket}`,
        });
        const blocking = severityOrder[severity] >= severityOrder.high;
        issues.push(
          this.buildIssue(
            reviewType,
            `${bucket}-${index}`,
            entry?.title || entry?.issue || bucket,
            description,
            severity,
            blocking,
            this.extractLabels(reviewType, description),
            entry,
            entry?.file,
            entry?.line,
          ),
        );
      });
    });
  }

  private fromIssuesArray(
    reviewType: string,
    reviewResult: Record<string, any>,
    issues: NormalizedIssue[],
    severityGaps: SeverityGapEvent[],
  ): void {
    if (!Array.isArray(reviewResult.issues)) {
      return;
    }

    reviewResult.issues.forEach((issue: any, index: number) => {
      const description = issue?.description || issue?.message || String(issue);
      if (!description || typeof description !== "string") {
        return;
      }

      const severity = this.normalizeSeverity(issue?.severity || issue?.level, "medium", {
        severityGaps,
        reviewType,
        source: reviewType,
        field: `issues.${index}`,
      });
      const blocking = issue?.blocking === true || severityOrder[severity] >= severityOrder.high;
      issues.push(
        this.buildIssue(
          reviewType,
          `issue-${index}`,
          issue?.title || issue?.code || `Issue ${index + 1}`,
          description,
          severity,
          blocking,
          this.extractLabels(reviewType, description),
          issue,
          issue?.file,
          issue?.line,
        ),
      );
    });
  }

  private fromCriticalAnalysis(
    reviewType: string,
    reviewResult: Record<string, any>,
    defaultSeverity: Severity,
    issues: NormalizedIssue[],
    _severityGaps: SeverityGapEvent[],
  ): void {
    const analysis = reviewResult.critical_analysis;
    if (!analysis || typeof analysis !== "object") {
      return;
    }

    Object.entries(analysis).forEach(([key, value]) => {
      if (!value || typeof value !== "string") {
        return;
      }

      issues.push(
        this.buildIssue(
          reviewType,
          `analysis-${key}`,
          key.replace(/_/g, " "),
          value,
          defaultSeverity,
          true,
          this.extractLabels(reviewType, value),
          { key, value },
        ),
      );
    });
  }

  private buildFallbackIssue(
    reviewType: string,
    reviewResult: Record<string, any>,
    severity: Severity,
  ): NormalizedIssue {
    const summary =
      typeof reviewResult.summary === "string"
        ? reviewResult.summary
        : reviewResult.message || "Review failed";

    return this.buildIssue(
      reviewType,
      "fallback",
      `${reviewType} failure`,
      summary,
      severity,
      severityOrder[severity] >= severityOrder.high,
      this.extractLabels(reviewType, summary),
      reviewResult,
    );
  }

  private buildIssue(
    reviewType: string,
    id: string,
    title: string,
    description: string,
    severity: Severity,
    blocking: boolean,
    labels: string[],
    raw?: Record<string, any>,
    file?: string,
    line?: number | null,
  ): NormalizedIssue {
    return {
      id,
      title: title.trim(),
      description: description.trim(),
      severity,
      blocking,
      labels,
      source: reviewType,
      file,
      line: typeof line === "number" ? line : undefined,
      raw,
    };
  }

  private extractLabels(reviewType: string, text: string): string[] {
    const labels = new Set<string>(["review-gap"]);

    if (reviewType === "qa") {
      labels.add("qa-gap");
    } else if (reviewType === "security_review") {
      labels.add("security-gap");
    } else if (reviewType === "code_review") {
      labels.add("code-gap");
    } else if (reviewType === "devops_review") {
      labels.add("devops-gap");
    }

    if (this.isInfraGap(text)) {
      labels.add("infra");
    }

    return Array.from(labels);
  }

  private stringifyCause(cause: any): string {
    if (!cause) {
      return "";
    }
    if (typeof cause === "string") {
      return cause;
    }
    if (typeof cause === "object") {
      const parts = [cause.type, cause.description, cause.message]
        .filter((value) => typeof value === "string" && value.trim().length > 0)
        .map((value) => value.trim());

      if (cause.suggestion) {
        parts.push(`Suggested fix: ${cause.suggestion}`);
      }

      return parts.join(". ");
    }
    return String(cause);
  }

  private normalizeSeverity(
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
      } else if (
        normalized.includes("high") ||
        normalized.includes("blocker")
      ) {
        severity = "high";
      } else if (
        normalized.includes("medium") ||
        normalized.includes("moderate")
      ) {
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

  private isInfraGap(text: string): boolean {
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
}
