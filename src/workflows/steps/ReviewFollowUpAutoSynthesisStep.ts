import {
  WorkflowStep,
  StepResult,
  ValidationResult,
} from "../engine/WorkflowStep.js";
import { WorkflowContext } from "../engine/WorkflowContext.js";
import {
  FollowUpTask,
  NormalizedReviewPayload,
  ReviewResult,
} from "./reviewFollowUpTypes.js";

type Severity = "critical" | "high" | "medium" | "low";

interface AutoSynthesisConfig {
  normalized_review?: NormalizedReviewPayload | null;
  review_result?: ReviewResult | null;
  review_type?: string;
  task?: { id?: number | string; title?: string } | null;
  external_id_base?: string;
}

interface AutoFollowUpSummary {
  reviewType: string;
  blockingIssueCount: number;
  synthesizedTaskCount: number;
  sourceCounts: Record<string, number>;
}

const TEST_INFRA_KEYWORDS = [
  "missing test",
  "no test",
  "no tests",
  "test framework",
  "testing framework",
  "test harness",
  "test runner",
  "qa infrastructure",
  "missing qa",
  "unable to run tests",
  "add tests",
  "add vitest",
  "add jest",
  "add pytest",
  "restore tests",
];

const SECURITY_KEYWORDS = [
  "xss",
  "sql injection",
  "injection",
  "csrf",
  "rce",
  "remote code",
  "secrets",
  "credential",
  "auth bypass",
  "encryption",
];

const DEVOPS_KEYWORDS = [
  "pipeline",
  "ci/cd",
  "deployment",
  "infrastructure",
  "container",
  "orchestration",
  "kubernetes",
];

export class ReviewFollowUpAutoSynthesisStep extends WorkflowStep {
  protected async validateConfig(
    _context: WorkflowContext,
  ): Promise<ValidationResult> {
    return { valid: true, errors: [], warnings: [] };
  }

  async execute(context: WorkflowContext): Promise<StepResult> {
    const startedAt = Date.now();
    const config = (this.config.config || {}) as AutoSynthesisConfig;
    const normalized = config.normalized_review;
    const reviewType =
      normalized?.reviewType || config.review_type || "review";

    const tasksFromBlocking = this.buildTasksFromBlockingIssues(
      normalized,
      reviewType,
      config.external_id_base,
    );
    const tasksFromRootCauses = this.buildTasksFromRootCauses(
      config.review_result,
      reviewType,
      config.external_id_base,
    );

    const merged = this.dedupeTasks([
      ...tasksFromBlocking,
      ...tasksFromRootCauses,
    ]);

    const summary: AutoFollowUpSummary = {
      reviewType,
      blockingIssueCount: normalized?.blockingIssues?.length || 0,
      synthesizedTaskCount: merged.length,
      sourceCounts: {
        blocking: tasksFromBlocking.length,
        qa_root_cause: tasksFromRootCauses.length,
      },
    };

    context.logger.info("Auto follow-up synthesis completed", {
      stepName: this.config.name,
      reviewType,
      synthesizedTaskCount: merged.length,
      blockingIssueCount: summary.blockingIssueCount,
    });

    return {
      status: "success",
      outputs: {
        auto_follow_up_tasks: merged,
        auto_follow_up_summary: summary,
      },
      data: { tasks: merged, summary },
      metrics: {
        duration_ms: Date.now() - startedAt,
        synthesized_task_count: merged.length,
      },
    } satisfies StepResult;
  }

  private buildTasksFromBlockingIssues(
    normalized: NormalizedReviewPayload | null | undefined,
    reviewType: string,
    externalBase?: string,
  ): FollowUpTask[] {
    if (!normalized?.blockingIssues || normalized.blockingIssues.length === 0) {
      return [];
    }

    return normalized.blockingIssues.map((issue, index) =>
      this.buildTaskFromIssue(
        issue,
        reviewType,
        externalBase,
        index,
        "normalized_blocking",
      ),
    );
  }

  private buildTasksFromRootCauses(
    reviewResult: ReviewResult | null | undefined,
    reviewType: string,
    externalBase?: string,
  ): FollowUpTask[] {
    if (!reviewResult?.qa_root_cause_analyses) {
      return [];
    }

    const tasks: FollowUpTask[] = [];
    reviewResult.qa_root_cause_analyses.forEach((analysis, _index) => {
      const failingCapability = analysis.failing_capability;
      if (!Array.isArray(analysis.qa_gaps) || analysis.qa_gaps.length === 0) {
        return;
      }

      analysis.qa_gaps.forEach((gap, gapIndex) => {
        const description =
          `QA gap detected for capability "${failingCapability}": ${gap}`;
        tasks.push(
          this.buildTaskFromFields({
            id: `${failingCapability}-${gapIndex}`,
            title: `${failingCapability}: close QA gap`,
            description,
            severity: "critical",
            labels: ["qa-gap", reviewType],
            source: "qa_root_cause",
            blocking: true,
          }, reviewType, externalBase, tasks.length),
        );
      });
    });

    return tasks;
  }

  private buildTaskFromIssue(
    issue: any,
    reviewType: string,
    externalBase: string | undefined,
    index: number,
    source: string,
  ): FollowUpTask {
    return this.buildTaskFromFields(
      {
        id: issue?.id || `${source}-${index}`,
        title: issue?.title || `Blocking ${reviewType} issue ${index + 1}`,
        description: issue?.description || issue?.summary || "",
        severity: (issue?.severity as Severity) || "high",
        labels: Array.isArray(issue?.labels) ? issue.labels : [],
        source,
        blocking: issue?.blocking !== false,
      },
      reviewType,
      externalBase,
      index,
    );
  }

  private buildTaskFromFields(
    issue: {
      id?: string;
      title: string;
      description: string;
      severity: Severity;
      labels?: string[];
      source: string;
      blocking?: boolean;
    },
    reviewType: string,
    externalBase: string | undefined,
    index: number,
  ): FollowUpTask {
    const text = `${issue.title} ${issue.description}`.toLowerCase();
    const isTestingGap = this.containsAny(text, TEST_INFRA_KEYWORDS);
    const isSecurityGap =
      reviewType.includes("security") || this.containsAny(text, SECURITY_KEYWORDS);
    const isDevOpsGap =
      reviewType.includes("devops") || this.containsAny(text, DEVOPS_KEYWORDS);
    const severity = issue.severity || "high";

    const category = isSecurityGap
      ? "security"
      : isTestingGap
        ? "testing"
        : isDevOpsGap
          ? "infrastructure"
          : "follow_up";

    const priority = this.priorityFromSeverity(severity);
    const fingerprint = this.buildFingerprint(issue.id, issue.description, index);
    const labels = this.mergeLabels([
      reviewType,
      "follow-up",
      "auto-follow-up",
      "needs-pm-triage",
      category,
    ], issue.labels);

    const task: FollowUpTask = {
      type: "auto_follow_up",
      title: this.buildTitle(reviewType, category, issue.title, severity),
      description: this.buildDescription(issue, severity, category),
      labels,
      priority,
      category,
      branch_locks:
        issue.blocking === false
          ? undefined
          : [{ branch: "main", policy: "block" }],
      external_id: externalBase
        ? `${externalBase}-auto-${fingerprint}`
        : undefined,
      metadata: {
        auto_generated: true,
        review_type: reviewType,
        source_issue_id: issue.id,
        fingerprint,
        severity,
        flags: {
          testing_gap: isTestingGap,
          security_gap: isSecurityGap,
          devops_gap: isDevOpsGap,
        },
        source: issue.source,
      },
    };

    return task;
  }

  private priorityFromSeverity(severity: Severity | undefined): FollowUpTask["priority"] {
    switch (severity) {
      case "critical":
        return "critical";
      case "high":
        return "high";
      case "medium":
        return "medium";
      default:
        return "low";
    }
  }

  private buildTitle(
    reviewType: string,
    category: string,
    baseTitle: string,
    severity: Severity,
  ): string {
    const prefix = `${this.capitalize(reviewType)} ${this.capitalize(category)}`;
    return `${prefix}: ${baseTitle} (${severity.toUpperCase()})`;
  }

  private buildDescription(
    issue: { description: string; source: string },
    severity: Severity,
    category: string,
  ): string {
    return [
      `Severity: ${severity}`,
      `Category: ${category}`,
      `Source: ${issue.source}`,
      `Details: ${issue.description}`,
      "Acceptance criteria:",
      "- Confirm the root cause is mitigated",
      "- Add regression coverage for the reported gap",
      "- Document verification steps in QA notes",
    ].join("\n");
  }

  private buildFingerprint(
    issueId: string | undefined,
    description: string,
    index: number,
  ): string {
    if (issueId) {
      return issueId.replace(/\s+/g, "-").toLowerCase();
    }
    return this.hash(`${description}-${index}`);
  }

  private hash(text: string): string {
    let hash = 0;
    for (let i = 0; i < text.length; i += 1) {
      hash = (hash << 5) - hash + text.charCodeAt(i);
      hash |= 0;
    }
    return Math.abs(hash).toString(36);
  }

  private dedupeTasks(tasks: FollowUpTask[]): FollowUpTask[] {
    const seen = new Map<string, FollowUpTask>();
    for (const task of tasks) {
      const key = this.normalizeKey(task);
      if (!seen.has(key)) {
        seen.set(key, task);
      }
    }
    return Array.from(seen.values());
  }

  private normalizeKey(task: FollowUpTask): string {
    const title = (task.title || "").trim().toLowerCase();
    const description = (task.description || "").trim().toLowerCase();
    return `${title}::${description}`;
  }

  private mergeLabels(base: string[], extra?: string[] | null): string[] {
    return Array.from(new Set([...(extra || []), ...base].filter(Boolean)));
  }

  private containsAny(text: string, keywords: string[]): boolean {
    return keywords.some((keyword) => text.includes(keyword));
  }

  private capitalize(text: string): string {
    if (!text) return "";
    return text.charAt(0).toUpperCase() + text.slice(1);
  }
}
