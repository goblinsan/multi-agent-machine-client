import {
  WorkflowStep,
  StepResult,
  ValidationResult,
} from "../engine/WorkflowStep.js";
import { WorkflowContext } from "../engine/WorkflowContext.js";
import {
  FollowUpTask,
  ExistingTask,
  ReviewResult,
  NormalizedReviewPayload,
  ReviewFollowUpCoverageConfig,
  CoverageItem,
  CoverageSummary,
} from "./reviewFollowUpTypes.js";
import { enforcePMAcknowledgement } from "./reviewFollowUpPMAcknowledgementGuard.js";

export class ReviewFollowUpCoverageStep extends WorkflowStep {
  protected async validateConfig(
    _context: WorkflowContext,
  ): Promise<ValidationResult> {
    return { valid: true, errors: [], warnings: [] };
  }

  async execute(context: WorkflowContext): Promise<StepResult> {
    const startedAt = Date.now();
    const config = (this.config.config || {}) as ReviewFollowUpCoverageConfig;
    const normalizedReview = config.normalized_review ?? null;
    const reviewType =
      normalizedReview?.reviewType || config.review_type || "review";
    const baseFollowUps = Array.isArray(config.follow_up_tasks)
      ? config.follow_up_tasks
      : [];
    const existingTasks = Array.isArray(config.existing_tasks)
      ? config.existing_tasks
      : [];

    enforcePMAcknowledgement(
      context,
      normalizedReview,
      baseFollowUps,
      reviewType,
      this.config.name,
    );

    const coverageItems = this.collectCoverageItems(
      normalizedReview,
      config.review_result,
      reviewType,
    );

    if (coverageItems.length === 0) {
      if (normalizedReview?.hasBlockingIssues) {
        context.logger.error(
          "Blocking review issues produced no coverage items",
          {
            stepName: this.config.name,
            reviewType,
            blockingIssueCount: normalizedReview.blockingIssues?.length || 0,
          },
        );
        throw new Error(
          `Normalized ${reviewType} review reported blocking issues but produced no coverage items`,
        );
      }

      return {
        status: "success",
        outputs: {
          follow_up_tasks: baseFollowUps,
          synthesized_follow_ups: [],
          metadata: {
            summary: this.buildSummary([], 0, 0, baseFollowUps.length, []),
          },
        },
        metrics: {
          duration_ms: Date.now() - startedAt,
          blocking_followup_gap_count: 0,
        },
      } satisfies StepResult;
    }

    const existingTaskTexts = this.collectExistingTaskTexts(existingTasks);
    const handledFingerprints = new Set<string>();
    const blockingFingerprints = new Set<string>();
    const branchLocks: CoverageItem["branchLocks"] = [];
    const synthesized: FollowUpTask[] = [];
    let existingMatches = 0;

    for (const item of coverageItems) {
      const alreadyHandled = this.isCoveredByExistingTask(
        item,
        existingTaskTexts,
      );

      if (item.blocking) {
        blockingFingerprints.add(item.fingerprint);
      }

      if (alreadyHandled) {
        handledFingerprints.add(item.fingerprint);
        existingMatches += 1;
      } else {
        synthesized.push(
          this.buildFollowUpTask(item, config.task, config.external_id_base),
        );
        handledFingerprints.add(item.fingerprint);
      }

      if (item.branchLocks?.length) {
        branchLocks.push(...item.branchLocks);
      }
    }

    const unresolvedBlocking = [...blockingFingerprints].filter(
      (fingerprint) => !handledFingerprints.has(fingerprint),
    );

    if (unresolvedBlocking.length > 0) {
      context.logger.error("Blocking review issues missing follow-ups", {
        stepName: this.config.name,
        reviewType,
        gapCount: unresolvedBlocking.length,
        unresolvedFingerprints: unresolvedBlocking,
      });
      throw new Error(
        `Blocking ${reviewType} issues (${unresolvedBlocking.length}) are missing follow-ups`,
      );
    }

    const labeledFollowUps = this.applyStandardLabels(synthesized);
    const mergedFollowUps = this.mergeFollowUps(baseFollowUps, labeledFollowUps);
    const summary = this.buildSummary(
      coverageItems,
      existingMatches,
      labeledFollowUps.length,
      mergedFollowUps.length,
      [...blockingFingerprints],
      branchLocks.length,
    );

    return {
      status: "success",
      outputs: {
        follow_up_tasks: mergedFollowUps,
        synthesized_follow_ups: labeledFollowUps,
        metadata: { summary },
      },
      metrics: {
        duration_ms: Date.now() - startedAt,
        blocking_followup_gap_count: 0,
      },
    } satisfies StepResult;
  }

  private collectCoverageItems(
    normalizedReview: NormalizedReviewPayload | null,
    reviewResult: ReviewResult | null | undefined,
    reviewType: string,
  ): CoverageItem[] {
    const normalized = this.extractNormalizedCoverageItems(
      normalizedReview,
      reviewType,
    );
    const raw = this.extractRawCoverageItems(reviewResult, reviewType);
    return this.dedupeCoverageItems([...normalized, ...raw]);
  }

  private extractNormalizedCoverageItems(
    normalizedReview: NormalizedReviewPayload | null,
    reviewType: string,
  ): CoverageItem[] {
    if (!normalizedReview?.blockingIssues?.length) {
      return [];
    }

    return normalizedReview.blockingIssues.map((issue) => {
      const severity = issue.severity?.toLowerCase();
      const blocking =
        issue.blocking === true || this.isBlockingSeverity(severity);
      const labels = this.mergeLabels(issue.labels, [reviewType, "blocking"]);
      return {
        key: issue.id || this.buildFingerprint(issue.description),
        type: `normalized_${reviewType}`,
        source: issue.source || reviewType,
        description: issue.description,
        labels,
        priority: this.priorityFromSeverity(severity),
        category: this.categoryFromSeverity(severity),
        branchLocks: blocking
          ? [{ branch: "main", policy: "block" }]
          : undefined,
        blocking,
        fingerprint: issue.id || this.buildFingerprint(issue.description),
        severity,
      } satisfies CoverageItem;
    });
  }

  private extractRawCoverageItems(
    reviewResult: ReviewResult | null | undefined,
    reviewType: string,
  ): CoverageItem[] {
    if (!reviewResult?.qa_root_cause_analyses?.length) {
      return [];
    }

    const items: CoverageItem[] = [];

    for (const analysis of reviewResult.qa_root_cause_analyses) {
      for (const gap of analysis.qa_gaps || []) {
        items.push({
          key: `${analysis.failing_capability}:${gap}`,
          type: "qa_gap",
          source: reviewType,
          description: this.buildQAGapDescription(analysis, gap, reviewType),
          labels: ["qa-gap", "follow-up"],
          priority: "critical",
          category: "urgent",
          branchLocks: [
            { branch: "main", policy: "block" },
            { branch: "qa", policy: "block" },
          ],
          blocking: true,
          fingerprint: this.buildFingerprint(
            `${analysis.failing_capability}:${gap}`,
          ),
          severity: "critical",
        });
      }

      for (const validation of analysis.suggested_validations || []) {
        if (!validation.is_critical_blocker) {
          continue;
        }
        items.push({
          key: `${analysis.failing_capability}:${validation.description}`,
          type: "critical_validation",
          source: reviewType,
          description: `Critical validation missing: ${validation.description}\nContext: ${validation.context || "unspecified"}`,
          labels: ["validation", "critical"],
          priority: "critical",
          category: "urgent",
          branchLocks: [{ branch: "main", policy: "block" }],
          blocking: true,
          fingerprint: this.buildFingerprint(
            `validation:${analysis.failing_capability}:${validation.description}`,
          ),
          severity: "critical",
        });
      }
    }

    return items;
  }

  private dedupeCoverageItems(items: CoverageItem[]): CoverageItem[] {
    const seen = new Map<string, CoverageItem>();

    for (const item of items) {
      const existing = seen.get(item.fingerprint);
      if (!existing) {
        seen.set(item.fingerprint, item);
        continue;
      }

      const merged: CoverageItem = {
        ...existing,
        labels: this.mergeLabels(existing.labels, item.labels),
        priority: existing.priority || item.priority,
        category: existing.category || item.category,
        branchLocks: this.mergeBranchLocks(existing.branchLocks, item.branchLocks),
        blocking: existing.blocking || item.blocking,
        severity: this.mergeSeverity(existing.severity, item.severity),
      };

      seen.set(item.fingerprint, merged);
    }

    return Array.from(seen.values());
  }

  private mergeSeverity(a?: string, b?: string): string | undefined {
    const order = ["critical", "high", "medium", "low"];
    const indexA = a ? order.indexOf(a) : -1;
    const indexB = b ? order.indexOf(b) : -1;
    if (indexA === -1) return b;
    if (indexB === -1) return a;
    return indexA <= indexB ? a : b;
  }

  private collectExistingTaskTexts(tasks: ExistingTask[]): string[] {
    return tasks
      .map((task) => task.description || task.title || "")
      .filter(Boolean)
      .map((text) => text.toLowerCase());
  }

  private isCoveredByExistingTask(
    item: CoverageItem,
    existingTaskTexts: string[],
  ): boolean {
    const key = item.key.toLowerCase();
    const description = item.description.toLowerCase().slice(0, 80);
    return existingTaskTexts.some(
      (text) => text.includes(key) || text.includes(description),
    );
  }

  private buildFollowUpTask(
    item: CoverageItem,
    task: { id?: number | string; title?: string } | null | undefined,
    externalBase?: string,
  ): FollowUpTask {
    const baseLabels = this.mergeLabels(item.labels, ["coordination"]);
    const description = this.buildDescription(item, task);
    const followUp: FollowUpTask = {
      type: "follow_up",
      title: this.buildTitle(item),
      description,
      priority: item.priority || "high",
      category: item.category || "follow_up",
      labels: baseLabels,
      branch_locks: item.branchLocks,
      metadata: {
        labels: baseLabels,
        coverage_source: item.source,
        severity: item.severity,
      },
    };

    if (externalBase) {
      followUp.external_id = `${externalBase}-gap-${item.fingerprint}`;
    }

    return followUp;
  }

  private mergeFollowUps(
    existingFollowUps: FollowUpTask[],
    newFollowUps: FollowUpTask[],
  ): FollowUpTask[] {
    const merged = [...existingFollowUps];

    for (const followUp of newFollowUps) {
      const index = merged.findIndex((candidate) =>
        this.isSameFollowUp(candidate, followUp),
      );

      if (index === -1) {
        merged.push(followUp);
        continue;
      }

      merged[index] = this.mergeFollowUpDetails(merged[index], followUp);
    }

    return merged;
  }

  private isSameFollowUp(a: FollowUpTask, b: FollowUpTask): boolean {
    const descA = (a.description || "").trim().toLowerCase();
    const descB = (b.description || "").trim().toLowerCase();
    return descA === descB;
  }

  private mergeFollowUpDetails(a: FollowUpTask, b: FollowUpTask): FollowUpTask {
    return {
      ...a,
      title: b.title || a.title,
      description: b.description || a.description,
      priority: b.priority || a.priority,
      category: b.category || a.category,
      labels: this.mergeLabels(a.labels, b.labels),
      branch_locks: this.mergeBranchLocks(a.branch_locks, b.branch_locks),
      external_id: b.external_id || a.external_id,
      metadata: { ...(a.metadata || {}), ...(b.metadata || {}) },
    };
  }

  private mergeLabels(
    current?: string[] | null,
    next?: string[] | null,
  ): string[] {
    return Array.from(new Set([...(current ?? []), ...(next ?? [])]));
  }

  private mergeBranchLocks(
    first?: FollowUpTask["branch_locks"],
    second?: FollowUpTask["branch_locks"],
  ): FollowUpTask["branch_locks"] {
    if (!first) return second;
    if (!second) return first;
    return [...first, ...second];
  }

  private applyStandardLabels(followUps: FollowUpTask[]): FollowUpTask[] {
    return followUps.map((followUp, index) => ({
      ...followUp,
      labels: this.mergeLabels(followUp.labels, [
        "coordination",
        "qa_follow_up",
        `qa_follow_up_${index + 1}`,
      ]),
    }));
  }

  private buildDescription(
    item: CoverageItem,
    task: { id?: number | string; title?: string } | null | undefined,
  ): string {
    const original = task?.id ? `Original task: #${task.id}` : null;
    const lines = [
      `Review reported the following issue: ${item.description}`,
      "Add a follow-up task that resolves this blocker so the reviewer can re-run successfully.",
    ];

    if (original) {
      lines.push(original);
    }

    return lines.join("\n\n");
  }

  private buildTitle(item: CoverageItem): string {
    const prefix = item.labels.includes("qa-gap") ? "QA Gap" : "Review Gap";
    return `${prefix}: ${item.source.toUpperCase()}`;
  }

  private buildSummary(
    items: CoverageItem[],
    existingMatches: number,
    synthesizedCount: number,
    finalCount: number,
    blockingFingerprints: string[],
    branchLockCount = 0,
  ): CoverageSummary {
    const breakdown = items.reduce<Record<string, number>>((acc, item) => {
      acc[item.type] = (acc[item.type] || 0) + 1;
      return acc;
    }, {});

    return {
      totalCoverageItems: items.length,
      existingTaskMatches: existingMatches,
      synthesizedFollowUps: synthesizedCount,
      finalFollowUpCount: finalCount,
      blockingFingerprints,
      coverageItemBreakdown: breakdown,
      branchLockCount,
    } satisfies CoverageSummary;
  }

  private buildQAGapDescription(
    analysis: NonNullable<ReviewResult["qa_root_cause_analyses"]>[number],
    gap: string,
    reviewType: string,
  ): string {
    const parts = [
      `Review type: ${reviewType}`,
      `Failing capability: ${analysis.failing_capability}`,
      `QA gap: ${gap}`,
    ];
    if (analysis.impact) {
      parts.push(`Impact: ${analysis.impact}`);
    }
    if (analysis.proposed_fix) {
      parts.push(`Proposed fix: ${analysis.proposed_fix}`);
    }
    return parts.join("\n");
  }

  private buildFingerprint(text: string): string {
    return text.trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").slice(0, 48);
  }

  private priorityFromSeverity(
    severity?: string,
  ): FollowUpTask["priority"] {
    switch (severity) {
      case "critical":
        return "critical";
      case "high":
        return "high";
      case "medium":
        return "medium";
      default:
        return "high";
    }
  }

  private categoryFromSeverity(severity?: string): string {
    if (!severity) {
      return "follow_up";
    }
    return severity === "critical" || severity === "high"
      ? "urgent"
      : "follow_up";
  }

  private isBlockingSeverity(severity?: string): boolean {
    return severity === "critical" || severity === "high";
  }
}
