import {
  WorkflowStep,
  StepResult,
  ValidationResult,
} from "../engine/WorkflowStep.js";
import { WorkflowContext } from "../engine/WorkflowContext.js";
import {
  Severity,
  NormalizationConfig,
  NormalizedIssue,
  NormalizedReview,
  SeverityGapEvent,
  severityOrder,
  parseTestErrors as parseTestErrorsImpl,
  normalizeSeverity,
  isInfraGap,
} from "./helpers/reviewNormalizationTypes.js";

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

    if (
      reviewResult === undefined ||
      reviewResult === null ||
      (typeof reviewResult !== "object" && typeof reviewResult !== "string")
    ) {
      throw new Error("review_result is required and must be an object");
    }

    this.assertBranchAlignment(context, config.feature_branch);

    const structuredReview = this.expandReviewResult(reviewResult);

    const { normalized, severityGaps } = this.normalizeReview(
      config.review_type,
      structuredReview,
      config.review_status,
      config.pre_qa_test_error,
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
    preQaTestError?: string | null,
  ): { normalized: NormalizedReview; severityGaps: SeverityGapEvent[] } {
    const severityGaps: SeverityGapEvent[] = [];
    const issues = this.collectIssues(
      reviewType,
      reviewResult,
      reviewStatus,
      severityGaps,
      preQaTestError,
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
    preQaTestError?: string | null,
  ): NormalizedIssue[] {
    const issues: NormalizedIssue[] = [];
    const baseSeverity = normalizeSeverity(
      reviewResult.severity,
      reviewStatus === "fail" ? "high" : "medium",
      {
        severityGaps,
        reviewType,
        source: reviewType,
        field: "review_result.severity",
      },
    );

    this.fromPreQaTestError(reviewType, preQaTestError, issues);

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

  static parseTestErrors(errorText: string): { file: string; line: number; message: string }[] {
    return parseTestErrorsImpl(errorText);
  }

  private fromPreQaTestError(
    reviewType: string,
    preQaTestError: string | null | undefined,
    issues: NormalizedIssue[],
  ): void {
    if (!preQaTestError || typeof preQaTestError !== "string" || preQaTestError.trim().length === 0) {
      return;
    }

    const parsed = ReviewFailureNormalizationStep.parseTestErrors(preQaTestError);
    if (parsed.length === 0) {
      issues.push(
        this.buildIssue(
          reviewType,
          "pre-qa-test-error",
          "Pre-QA test execution failure",
          preQaTestError.slice(0, 500),
          "critical",
          true,
          [reviewType, "review-gap", "qa-gap", "pre-qa-test-error"],
        ),
      );
      return;
    }

    parsed.forEach((error, _index) => {
      issues.push(
        this.buildIssue(
          reviewType,
          `pre-qa-test-error-${error.file}-L${error.line}`,
          `${error.file} syntax error at line ${error.line}`,
          `File ${error.file} has an error at line ${error.line}: ${error.message}`,
          "critical",
          true,
          [reviewType, "review-gap", "qa-gap", "pre-qa-test-error", "config-corruption"],
          undefined,
          error.file,
          error.line,
        ),
      );
    });
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

      const severity = normalizeSeverity(cause?.severity, defaultSeverity, {
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

        const severity = normalizeSeverity(entry?.severity || bucket, "medium", {
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

      const severity = normalizeSeverity(issue?.severity || issue?.level, "medium", {
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

    if (isInfraGap(text)) {
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

  private expandReviewResult(
    reviewResult: Record<string, any> | string,
  ): Record<string, any> {
    let merged = { ...this.ensureObjectReview(reviewResult) };
    const nestedKeys = ["result", "output", "payload", "data"];

    for (const key of nestedKeys) {
      const parsed = this.parseStructuredField(merged[key]);
      if (parsed) {
        merged = { ...merged, ...parsed };
      }
    }

    return merged;
  }

  private ensureObjectReview(
    reviewResult: Record<string, any> | string,
  ): Record<string, any> {
    if (typeof reviewResult === "string") {
      const parsed = this.tryParseJson(reviewResult);
      if (!parsed) {
        throw new Error(
          "review_result string must contain valid JSON payload",
        );
      }
      return parsed;
    }

    if (!reviewResult || typeof reviewResult !== "object") {
      throw new Error("review_result is required and must be an object");
    }

    return reviewResult;
  }

  private parseStructuredField(value: unknown): Record<string, any> | null {
    if (!value) {
      return null;
    }

    if (typeof value === "object") {
      return value as Record<string, any>;
    }

    if (typeof value === "string") {
      return this.tryParseJson(value);
    }

    return null;
  }

  private tryParseJson(value: string): Record<string, any> | null {
    try {
      const parsed = JSON.parse(value);
      return parsed && typeof parsed === "object" ? parsed : null;
    } catch {
      return null;
    }
  }
}
