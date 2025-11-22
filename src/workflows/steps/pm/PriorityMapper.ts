import type { PMDecision } from "./DecisionParser";
import { slugify } from "../../../util.js";

export class PriorityMapper {
  applyPriorityAndMilestoneRouting(
    decision: PMDecision,
    reviewType: string | undefined,
    ctx: any,
    warnings: string[],
  ): PMDecision {
    const milestoneContext = this.resolveMilestoneContext(ctx);
    const parentMilestoneId = this.resolveMilestoneId(
      milestoneContext?.id,
      ctx.parent_task_milestone_id,
      ctx.milestone_id,
    );
    const parentMilestoneSlug = this.normalizeMilestoneSlug(
      milestoneContext?.slug,
      milestoneContext?.name,
    );
    const parentMilestoneName =
      milestoneContext?.name || milestoneContext?.title || undefined;
    const backlogMilestoneSlug =
      ctx.backlog_milestone_slug || ctx.backlog_milestone || "backlog-milestone";
    const backlogMilestoneId = this.resolveMilestoneId(
      ctx.backlog_milestone_id,
      ctx.backlog_milestone,
    );
    const parentTask = this.resolveParentTask(ctx);
    const reviewLabel = this.formatReviewLabel(reviewType);

    const urgentPriority = (title: string, prio: string) => {
      const p = prio.toLowerCase();
      const isUrgent = p === "critical" || p === "high";
      if (!isUrgent) return null;

      if (reviewType === "qa" || /\[qa\]/i.test(title)) return 1200;
      return 1000;
    };

    const routed = {
      ...decision,
      follow_up_tasks: (decision.follow_up_tasks || []).map((task) => {
        const originalTitle = task.title || "";
        const normalizedTitle = this.ensureTaskTitle(
          originalTitle,
          reviewLabel,
          parentTask,
        );
        const p = String(task.priority).toLowerCase();
        const urgent = urgentPriority(normalizedTitle, p);
        let numericPriority =
          urgent ?? (p === "medium" || p === "low" ? 50 : 50);

        const milestonePreference =
          urgent != null
            ? [task.milestone_id, parentMilestoneId, backlogMilestoneId]
            : [task.milestone_id, backlogMilestoneId, parentMilestoneId];
        const normalizedMilestoneId = this.resolveMilestoneId(
          ...milestonePreference,
        );

        const slugPreference =
          urgent != null
            ? [task.milestone_slug, parentMilestoneSlug, backlogMilestoneSlug]
            : [task.milestone_slug, backlogMilestoneSlug, parentMilestoneSlug];
        const normalizedMilestoneSlug =
          this.pickFirstSlug(...slugPreference) || null;
        if (urgent != null && parentMilestoneId == null) {
          warnings.push(
            "Parent milestone not found - routing urgent task to backlog",
          );
        }

        return {
          ...task,
          title: normalizedTitle,
          description: this.applyReviewLabelToDescription(
            task.description,
            reviewLabel,
            parentTask,
          ),
          priority: numericPriority as any,
          milestone_id: normalizedMilestoneId ?? undefined,
          milestone_slug: normalizedMilestoneSlug ?? undefined,
          milestone_name: parentMilestoneName ?? task.milestone_name,
          assignee_persona: "implementation-planner",
          metadata: this.enrichMetadata(
            task.metadata,
            reviewType,
            parentTask,
            parentMilestoneId,
            urgent != null,
            reviewLabel,
            originalTitle,
            normalizedTitle,
          ),
        };
      }),
    };

    return routed;
  }

  private ensureTaskTitle(
    title: string | undefined,
    label: string | null,
    parentTask: any,
  ): string {
    const trimmed = title?.trim();
    if (trimmed && trimmed.length > 0) {
      return trimmed;
    }
    return this.applyReviewLabelToTitle(undefined, label, parentTask);
  }

  private resolveParentTask(ctx: any): any {
    const candidates = [
      this.resolveContextValue(ctx, "task"),
      this.resolveContextValue(ctx, "parent_task"),
      ctx?.task,
    ];
    for (const candidate of candidates) {
      if (candidate) return candidate;
    }
    return null;
  }

  private resolveMilestoneContext(ctx: any): any {
    const candidates = [
      this.resolveContextValue(ctx, "milestone_context"),
      this.resolveContextValue(ctx, "milestone"),
      ctx?.milestone_context,
      ctx?.milestone,
      this.resolveContextValue(ctx, "task")?.milestone,
    ];
    for (const candidate of candidates) {
      if (candidate && typeof candidate === "object") {
        return candidate;
      }
    }
    return null;
  }

  private resolveContextValue(ctx: any, key: string): any {
    if (!ctx) return undefined;
    if (typeof ctx.getVariable === "function") {
      try {
        return ctx.getVariable(key);
      } catch (_error) {
        return undefined;
      }
    }
    return ctx[key];
  }

  private formatReviewLabel(reviewType?: string): string | null {
    if (!reviewType) return null;
    return reviewType
      .split(/[_\s]+/)
      .filter(Boolean)
      .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
      .join(" ");
  }

  private applyReviewLabelToTitle(
    _title: string | undefined,
    label: string | null,
    parentTask: any,
  ): string {
    const fallback =
      parentTask?.title ||
      parentTask?.name ||
      "Review follow-up";
    if (!label) return fallback;
    const prefix = `[${label.toUpperCase()}]`;
    if (fallback.toUpperCase().startsWith(prefix)) {
      return fallback;
    }
    return `${prefix} ${fallback}`.trim();
  }

  private applyReviewLabelToDescription(
    description: string | undefined,
    label: string | null,
    parentTask: any,
  ): string {
    const base = (description || "").trim();
    const parts: string[] = [];
    if (label) {
      parts.push(`${label} review`);
    }
    if (parentTask?.id) {
      const parentTitle =
        parentTask.title || parentTask.name || parentTask.summary || "";
      const summary = parentTitle
        ? `task #${parentTask.id} (${parentTitle})`
        : `task #${parentTask.id}`;
      parts.push(summary);
    }
    const header = parts.length
      ? `Follow-up generated from ${parts.join(" · ")}.`
      : null;
    if (header && base) {
      return `${header}\n\n${base}`;
    }
    if (header) {
      return header;
    }
    return base || "Automated follow-up task generated by review workflows.";
  }

  private normalizeMilestoneId(
    value: number | string | undefined,
  ): number | null {
    if (value === undefined || value === null) {
      return null;
    }
    if (typeof value === "number" && Number.isFinite(value)) {
      return value;
    }
    if (typeof value === "string") {
      const parsed = Number(value);
      if (!Number.isNaN(parsed)) {
        return parsed;
      }
    }
    return null;
  }

  private normalizeMilestoneSlug(
    slugValue?: string,
    nameValue?: string,
  ): string | undefined {
    if (slugValue && typeof slugValue === "string" && slugValue.trim()) {
      return slugValue.trim();
    }
    if (nameValue && typeof nameValue === "string" && nameValue.trim()) {
      return slugify(nameValue.trim());
    }
    return undefined;
  }

  private pickFirstSlug(
    ...values: Array<string | null | undefined>
  ): string | null {
    for (const value of values) {
      if (typeof value === "string") {
        const trimmed = value.trim();
        if (trimmed.length > 0) {
          return trimmed;
        }
      }
    }
    return null;
  }

  private resolveMilestoneId(
    ...values: Array<string | number | null | undefined>
  ): string | number | null {
    for (const value of values) {
      if (value === undefined || value === null) {
        continue;
      }

      if (typeof value === "number") {
        const normalized = this.normalizeMilestoneId(value);
        if (normalized !== null) {
          return normalized;
        }
        continue;
      }

      if (typeof value === "string") {
        const trimmed = value.trim();
        if (!trimmed) {
          continue;
        }
        const normalized = this.normalizeMilestoneId(trimmed);
        if (normalized !== null) {
          return normalized;
        }
        return trimmed;
      }
    }

    return null;
  }

  private enrichMetadata(
    metadata: Record<string, any> | undefined,
    reviewType: string | undefined,
    parentTask: any,
    milestoneId: string | number | null,
    isUrgent: boolean,
    reviewLabel: string | null,
    originalTitle?: string,
    finalTitle?: string,
  ): Record<string, any> {
    const existingLabels = Array.isArray(metadata?.labels)
      ? metadata?.labels
      : undefined;
    return {
      ...(metadata || {}),
      review_type: reviewType || (metadata || {}).review_type || null,
      parent_task_id:
        parentTask?.id ||
        parentTask?.taskId ||
        (metadata || {}).parent_task_id ||
        null,
      parent_milestone_id:
        milestoneId ?? (metadata || {}).parent_milestone_id ?? null,
      labels: this.buildLabels(existingLabels, reviewType, isUrgent),
      original_pm_title:
        originalTitle && originalTitle.trim().length > 0
          ? originalTitle.trim()
          : (metadata || {}).original_pm_title || null,
      generated_title_reason:
        !originalTitle || originalTitle.trim().length === 0
          ? (metadata || {}).generated_title_reason || "missing_pm_title"
          : (metadata || {}).generated_title_reason || null,
      review_label: reviewLabel || (metadata || {}).review_label || null,
      final_title: finalTitle || (metadata || {}).final_title || null,
    };
  }

  private buildLabels(
    existing: string[] | undefined,
    reviewType: string | undefined,
    isUrgent: boolean,
  ): string[] | undefined {
    const labels = new Set<string>();
    (existing || []).forEach((label) => {
      if (typeof label === "string" && label.trim()) {
        labels.add(label.trim());
      }
    });
    labels.add("review-follow-up");
    if (reviewType) {
      labels.add(`${reviewType}-follow-up`);
    }
    if (isUrgent) {
      labels.add("urgent");
    }
    return Array.from(labels);
  }
}
